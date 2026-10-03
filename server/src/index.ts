/**
 * 羽球對決線上房間伺服器。
 * 一個房號 = 一個 Durable Object（Room）。
 * - 2 人房：最多兩人；伺服器不跑遊戲邏輯，只轉送兩邊的訊息
 *   （遊戲同步在瀏覽器端：各自模擬，擊球方傳擊球、接球方判定得分）
 * - 4 人房（線上雙打 2 對 2，建房時網址帶 ?cap=4）：最多四人；一般訊息照樣轉送給其他人，
 *   但會影響比分的事件（ev：擊球、落地）交給裁決器（arbiter.ts）決定一個、蓋上序號廣播給所有人（acc）；
 *   ping 由伺服器直接回 pong（量自己到伺服器的延遲）
 * - 觀眾（連線網址帶 ?spec=1，每房最多 MAX_SPECTATORS 人）：沒有座位、不算人數；
 *   玩家送的訊息都會轉一份給觀眾（2 人房多標 fr = 送出的人是房主 h 還是加入的人 g；ping/pong 不轉），4 人房的裁決結果（acc）也給；
 *   觀眾送的訊息只接受 ping（直接回）、spec-hello（要快照，轉給玩家）、bye，其他全部丟掉，不會影響比賽；
 *   玩家回的快照（snap）只轉給觀眾。觀眾人數變了就告訴玩家（spec）
 * - 遊戲大廳（Lobby，一個 Durable Object）：房主送 lob（房間資料、公開與否、狀態、比分），
 *   Room 合併自己知道的人數、觀眾數，節流（2 秒內合併成一次）送給 Lobby；等待中每 30 秒心跳一次（alarm），
 *   房間空了就從大廳拿掉；Lobby 超過 75 秒沒更新的也當作消失。GET /lobby 拿 JSON 名單
 * 連線網址帶 ?cid=（每個分頁一個連線編號）：同一個 cid 重新連上時，舊的連線作廢（不會卡著「房間滿了」）。
 * 用 WebSocket Hibernation：沒有訊息時物件會休眠，不計時間（每條連線的資料存在 attachment，休眠也不會丟）。
 */
import { DurableObject } from 'cloudflare:workers';
import { ARB_DEFAULTS, Arbiter, isArbEv, type Decision } from './arbiter';
import { Coalescer, LOBBY_HEARTBEAT_MS, LobbyRegistry, type LobbyEntry, type LobbyMode, type LobbyStatus } from './lobby';

interface Env {
  ROOM: DurableObjectNamespace<Room>;
  LOBBY: DurableObjectNamespace<Lobby>;
  /** 可選：裁決窗口（毫秒），沒設就用 arbiter.ts 的預設（擊球 60、落地 150） */
  ARB_HIT_MS?: string;
  ARB_LAND_MS?: string;
}

// 只接受遊戲網頁連線
const ALLOWED_ORIGINS = [/^https:\/\/rredpanda78\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
const LOBBY_NAME = 'main';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response('badminton rooms ok');
    const origin = req.headers.get('Origin') ?? '';
    const allowed = ALLOWED_ORIGINS.some((r) => r.test(origin));
    if (url.pathname === '/lobby') {
      // 遊戲大廳的名單（網頁用 fetch 每 3 秒拉一次）；沒帶 Origin（curl）也可以看
      if (origin && !allowed) return new Response('forbidden', { status: 403 });
      if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
      const rooms = await env.LOBBY.get(env.LOBBY.idFromName(LOBBY_NAME)).list();
      return new Response(JSON.stringify({ rooms }), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': origin || '*', vary: 'Origin' },
      });
    }
    const m = url.pathname.match(/^\/room\/([A-Z0-9]{4,8})$/);
    if (!m) return new Response('not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!allowed) return new Response('forbidden', { status: 403 });
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
  },
};

const MAX_MSG = 4096;
const MAX_SPECTATORS = 20;

/** 每條連線的資料（serializeAttachment，休眠醒來還在） */
interface Att {
  cap: 2 | 4;
  cid: string;
  role: 'host' | 'guest' | 'spectator';
  hostCid?: string; // 4 人房：房主的 cid（房主斷線回來還是房主）
  gone?: boolean; // 被同一個 cid 的新連線取代了（關閉中，不算人數、不通知）
}

/** 房主送來的大廳資料（存在儲存裡，休眠醒來心跳時還能用） */
interface LobInfo {
  pub: boolean;
  name: string;
  mode: LobbyMode;
  venue: string;
  points: number;
  games: number;
  status: LobbyStatus;
  sc?: [number, number];
  gm?: [number, number];
}

export class Room extends DurableObject<Env> {
  private arb: Arbiter;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 大廳更新的節流（2 秒內合併）；lobTimer = 排程中的那一次 */
  private pub = new Coalescer();
  private lobTimer: ReturnType<typeof setTimeout> | null = null;
  private code = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const n = (s: string | undefined, d: number) => (s && Number.isFinite(Number(s)) ? Number(s) : d);
    this.arb = new Arbiter({ hitWindowMs: n(env.ARB_HIT_MS, ARB_DEFAULTS.hitWindowMs), landWindowMs: n(env.ARB_LAND_MS, ARB_DEFAULTS.landWindowMs) });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const code = url.pathname.split('/').pop() ?? '';
    if (code && code !== this.code) {
      // 物件不知道自己的房號（大廳要用）：第一次連線時記下來
      this.code = code;
      await this.ctx.storage.put('code', code);
    }
    const cid = (url.searchParams.get('cid') ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
    const spec = url.searchParams.get('spec') === '1';
    const all = this.ctx.getWebSockets();
    // 同一個 cid 重新連上（手機睡醒、重新整理）：舊的連線可能還沒斷乾淨 → 作廢，免得卡住名額
    if (cid) {
      for (const ws of all) {
        const a = att(ws);
        if (a && !a.gone && a.cid === cid) {
          a.gone = true;
          ws.serializeAttachment(a);
          try {
            ws.close(4002, 'replaced');
          } catch {
            /* 已經關了 */
          }
        }
      }
    }
    const live = all.filter((ws) => !att(ws)?.gone);
    const players = live.filter((ws) => att(ws)?.role !== 'spectator');
    const specs = live.filter((ws) => att(ws)?.role === 'spectator');
    const cap = Math.max(url.searchParams.get('cap') === '4' ? 4 : 2, ...players.map((ws) => att(ws)?.cap ?? 2)) as 2 | 4;
    if (spec) return this.joinSpectator(players, specs, cid, cap);
    const res = cap === 4 ? this.join4(players, cid) : this.join2(players, cid);
    await this.touchLobby();
    return res;
  }

  /** 2 人房（跟以前一樣）：先到的是房主 */
  private join2(peers: WebSocket[], cid: string): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (peers.length >= 2) {
      // 房間滿了：接起來告訴對方再關掉（直接回錯誤瀏覽器拿不到原因）
      server.accept();
      server.send(JSON.stringify({ t: 'full' }));
      server.close(4001, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }
    const hasHost = peers.some((ws) => this.ctx.getTags(ws).includes('host'));
    const role = hasHost ? 'guest' : 'host';
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ cap: 2, cid, role } satisfies Att);
    server.send(JSON.stringify({ t: 'welcome', role, peers: peers.length, spec: this.spectators().length }));
    const join = JSON.stringify({ t: 'peer-join' });
    for (const ws of peers) safeSend(ws, join);
    for (const ws of this.spectators()) safeSend(ws, join);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 4 人房：最多四人；房主 = 建房的那個 cid（斷線回來還是房主），房間空了才重新認定 */
  private join4(peers: WebSocket[], cid: string): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (peers.length >= 4) {
      server.accept();
      server.send(JSON.stringify({ t: 'full', cap: 4 }));
      server.close(4001, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }
    const atts = peers.map(att).filter((a): a is Att => !!a);
    const hostCid = peers.length ? (atts.find((a) => a.hostCid)?.hostCid ?? '') : cid;
    const role = !peers.length || (cid && cid === hostCid) ? 'host' : 'guest';
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ cap: 4, cid, role, hostCid } satisfies Att);
    // 舊的 2 人房連線剛好升級成 4 人（不太會發生）：記下上限
    for (const ws of peers) {
      const a = att(ws);
      if (a && a.cap !== 4) ws.serializeAttachment({ ...a, cap: 4 });
    }
    server.send(JSON.stringify({ t: 'welcome', role, peers: peers.length, cap: 4, cid, ids: atts.map((a) => a.cid), spec: this.spectators().length }));
    const join = JSON.stringify({ t: 'peer-join', cid });
    for (const ws of peers) safeSend(ws, join);
    for (const ws of this.spectators()) safeSend(ws, join);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 觀眾：沒有座位、不算人數；滿了（MAX_SPECTATORS）回 full */
  private async joinSpectator(players: WebSocket[], specs: WebSocket[], cid: string, cap: 2 | 4): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (specs.length >= MAX_SPECTATORS) {
      server.accept();
      server.send(JSON.stringify({ t: 'full', cap, spec: 1 }));
      server.close(4001, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server, ['spectator']);
    server.serializeAttachment({ cap, cid, role: 'spectator' } satisfies Att);
    const n = specs.length + 1;
    server.send(JSON.stringify({ t: 'welcome', role: 'spectator', peers: players.length, cap, spec: n }));
    const out = JSON.stringify({ t: 'spec', n });
    for (const ws of players) safeSend(ws, out);
    await this.touchLobby();
    return new Response(null, { status: 101, webSocket: client });
  }

  private players(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = att(ws);
      return !!a && !a.gone && a.role !== 'spectator';
    });
  }

  private spectators(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = att(ws);
      return !!a && !a.gone && a.role === 'spectator';
    });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== 'string' || msg.length > MAX_MSG || msg[0] !== '{') return;
    const a = att(ws);
    if (!a || a.gone) return;
    if (a.role === 'spectator') {
      // 觀眾只能：ping（伺服器直接回）、spec-hello（要快照，轉給玩家）、bye；其他全部丟掉
      if (msg.startsWith('{"t":"ping"')) safeSend(ws, '{"t":"pong"' + msg.slice(11));
      else if (msg.startsWith('{"t":"spec-hello"')) for (const p of this.players()) safeSend(p, msg);
      return;
    }
    if (msg.startsWith('{"t":"lob"')) {
      // 房主 → 伺服器：大廳資料（不轉送）
      await this.onLob(msg);
      return;
    }
    if (a.cap === 4) {
      // 4 人房：ping 直接回；ev 交給裁決器；arb = 開賽／繼續比賽時重設裁決器（不轉送）
      if (msg.startsWith('{"t":"ping"')) {
        safeSend(ws, '{"t":"pong"' + msg.slice(11));
        return;
      }
      if (msg.startsWith('{"t":"ev"')) {
        let ev: unknown;
        try {
          ev = JSON.parse(msg);
        } catch {
          return;
        }
        if (isArbEv(ev)) this.broadcast(this.arb.submit(ev, Date.now()));
        this.schedule();
        return;
      }
      if (msg.startsWith('{"t":"arb"')) {
        try {
          const r = JSON.parse(msg) as { ep?: unknown; q?: unknown };
          if (Number.isFinite(r.ep) && Number.isFinite(r.q)) this.arb.reset(r.ep as number, r.q as number);
        } catch {
          /* 壞資料 */
        }
        return;
      }
    }
    // 轉送給其他玩家；觀眾也收一份（snap 只給觀眾；ping/pong 不給觀眾）。
    // 2 人房的座標是「送出方自己的視角」，觀眾要知道是誰送的才能換算：多標 fr（h = 房主、g = 加入的人）
    const snap = msg.startsWith('{"t":"snap"');
    const quiet = msg.startsWith('{"t":"ping"') || msg.startsWith('{"t":"pong"');
    const forSpec = a.cap === 4 ? msg : `{"fr":"${a.role === 'host' ? 'h' : 'g'}",` + msg.slice(1);
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const b = att(other);
      if (!b || b.gone) continue;
      if (b.role === 'spectator') {
        if (!quiet) safeSend(other, forSpec);
      } else if (!snap) safeSend(other, msg);
    }
  }

  /** 裁決結果廣播給所有人（包含送出的人，他要知道自己有沒有被採用；觀眾也要） */
  private broadcast(ds: Decision[]): void {
    for (const d of ds) {
      const out = JSON.stringify({ t: 'acc', q: d.q, e: d.ev });
      for (const ws of this.ctx.getWebSockets()) if (!att(ws)?.gone) safeSend(ws, out);
    }
  }

  /** 裁決窗口時間到要再看一次 */
  private schedule(): void {
    const due = this.arb.due;
    if (this.timer || due === null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.broadcast(this.arb.poll(Date.now()));
        this.schedule();
      },
      Math.max(1, due - Date.now()),
    );
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const a = att(ws);
    if (a && !a.gone) {
      if (a.role === 'spectator') {
        // 觀眾走了：只告訴玩家人數
        const n = this.spectators().filter((x) => x !== ws).length;
        const out = JSON.stringify({ t: 'spec', n });
        for (const p of this.players()) if (p !== ws) safeSend(p, out);
      } else {
        const left = JSON.stringify(a.cap === 4 ? { t: 'peer-left', cid: a.cid } : { t: 'peer-left' });
        const forSpec = a.cap === 4 ? left : `{"fr":"${a.role === 'host' ? 'h' : 'g'}",` + left.slice(1);
        for (const other of this.ctx.getWebSockets()) {
          if (other === ws) continue;
          const b = att(other);
          if (!b || b.gone) continue;
          safeSend(other, b.role === 'spectator' ? forSpec : left);
        }
      }
    }
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {
      /* 已經關了 */
    }
    if (a && !a.gone) await this.touchLobby(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }

  // ---------- 遊戲大廳 ----------

  /** 房主送來的大廳資料：檢查、存起來（pub 只有建房的人會送，沒送就沿用） */
  private async onLob(msg: string): Promise<void> {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(msg) as Record<string, unknown>;
    } catch {
      return;
    }
    const old = await this.ctx.storage.get<LobInfo>('lob');
    const str = (v: unknown, max: number, d: string) => (typeof v === 'string' ? v.slice(0, max) : d);
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const pair = (v: unknown): [number, number] | undefined => (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [v[0] as number, v[1] as number] : undefined);
    const mode = m.mode === 'doubles' || m.mode === 'quad' ? m.mode : 'singles';
    const status: LobbyStatus = m.st === 'play' || m.st === 'over' ? m.st : 'wait';
    const info: LobInfo = {
      pub: typeof m.pub === 'number' ? m.pub === 1 : (old?.pub ?? false),
      name: str(m.name, 24, old?.name ?? '?'),
      mode,
      venue: str(m.venue, 16, old?.venue ?? 'indoor'),
      points: num(m.points, old?.points ?? 21),
      games: num(m.games, old?.games ?? 1),
      status,
      sc: pair(m.sc),
      gm: pair(m.gm),
    };
    await this.ctx.storage.put('lob', info);
    await this.touchLobby();
  }

  /** 大廳要更新（有人進出、觀眾進出、房主送 lob）：2 秒內合併成一次；closing = 正在關閉的連線（不算人數） */
  private async touchLobby(closing?: WebSocket): Promise<void> {
    const now = Date.now();
    const at = this.pub.request(now);
    if (at === null) await this.pushLobby(now, closing);
    else if (!this.lobTimer)
      this.lobTimer = setTimeout(
        () => {
          this.lobTimer = null;
          void this.pushLobby(Date.now());
        },
        Math.max(1, at - now),
      );
  }

  /** 把這個房間目前的狀態送給大廳（不公開、沒人了 → 從大廳拿掉）；公開的房間接著排 30 秒後的心跳 */
  private async pushLobby(now: number, closing?: WebSocket): Promise<void> {
    this.pub.sent(now);
    const code = this.code || (await this.ctx.storage.get<string>('code')) || '';
    if (!code) return;
    this.code = code;
    const info = await this.ctx.storage.get<LobInfo>('lob');
    const players = this.players().filter((ws) => ws !== closing);
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName(LOBBY_NAME));
    const listed = (await this.ctx.storage.get<boolean>('listed')) ?? false;
    if (!info?.pub || players.length === 0) {
      if (listed) {
        await lobby.remove(code);
        await this.ctx.storage.put('listed', false);
      }
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const cap = Math.max(2, ...players.map((ws) => att(ws)?.cap ?? 2)) as 2 | 4;
    const entry: LobbyEntry = {
      code,
      host: info.name,
      mode: info.mode,
      venue: info.venue,
      points: info.points,
      games: info.games,
      cap,
      players: players.length,
      spectators: this.spectators().filter((ws) => ws !== closing).length,
      status: info.status,
      sc: info.sc,
      gm: info.gm,
      t: now,
    };
    await lobby.upsert(entry);
    if (!listed) await this.ctx.storage.put('listed', true);
    await this.ctx.storage.setAlarm(now + LOBBY_HEARTBEAT_MS);
  }

  /** 心跳：等待中（沒有訊息往來）的公開房間也要讓大廳知道還在 */
  async alarm(): Promise<void> {
    await this.pushLobby(Date.now());
  }
}

/** 遊戲大廳：所有公開房間的名單（一個物件；名單也存在儲存裡，被回收再醒來還在） */
export class Lobby extends DurableObject<Env> {
  private reg = new LobbyRegistry();
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    const all = await this.ctx.storage.list<LobbyEntry>();
    for (const e of all.values()) if (e && typeof e.code === 'string') this.reg.upsert(e);
    this.loaded = true;
  }

  async upsert(e: LobbyEntry): Promise<void> {
    await this.load();
    this.reg.upsert(e);
    await this.ctx.storage.put(e.code, e);
  }

  async remove(code: string): Promise<void> {
    await this.load();
    if (this.reg.remove(code)) await this.ctx.storage.delete(code);
  }

  /** 目前的名單（順便清掉太久沒更新的） */
  async list(): Promise<LobbyEntry[]> {
    await this.load();
    const now = Date.now();
    const gone = this.reg.prune(now);
    if (gone.length) await this.ctx.storage.delete(gone);
    return this.reg.list(now);
  }
}

function att(ws: WebSocket): Att | null {
  try {
    return (ws.deserializeAttachment() as Att | null) ?? null;
  } catch {
    return null;
  }
}

function safeSend(ws: WebSocket, data: string): void {
  try {
    ws.send(data);
  } catch {
    /* 對方剛好斷線 */
  }
}
