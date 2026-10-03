/**
 * 羽球對決線上房間伺服器。
 * 一個房號 = 一個 Durable Object。
 * - 2 人房：最多兩人；伺服器不跑遊戲邏輯，只轉送兩邊的訊息
 *   （遊戲同步在瀏覽器端：各自模擬，擊球方傳擊球、接球方判定得分）
 * - 4 人房（線上雙打 2 對 2，建房時網址帶 ?cap=4）：最多四人；一般訊息照樣轉送給其他人，
 *   但會影響比分的事件（ev：擊球、落地）交給裁決器（arbiter.ts）決定一個、蓋上序號廣播給所有人（acc）；
 *   ping 由伺服器直接回 pong（量自己到伺服器的延遲）
 * 連線網址帶 ?cid=（每個分頁一個連線編號）：同一個 cid 重新連上時，舊的連線作廢（不會卡著「房間滿了」）。
 * 用 WebSocket Hibernation：沒有訊息時物件會休眠，不計時間（每條連線的資料存在 attachment，休眠也不會丟）。
 */
import { DurableObject } from 'cloudflare:workers';
import { ARB_DEFAULTS, Arbiter, isArbEv, type Decision } from './arbiter';

interface Env {
  ROOM: DurableObjectNamespace<Room>;
  /** 可選：裁決窗口（毫秒），沒設就用 arbiter.ts 的預設（擊球 60、落地 150） */
  ARB_HIT_MS?: string;
  ARB_LAND_MS?: string;
}

// 只接受遊戲網頁連線
const ALLOWED_ORIGINS = [/^https:\/\/rredpanda78\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response('badminton rooms ok');
    const m = url.pathname.match(/^\/room\/([A-Z0-9]{4,8})$/);
    if (!m) return new Response('not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const origin = req.headers.get('Origin') ?? '';
    if (!ALLOWED_ORIGINS.some((r) => r.test(origin))) return new Response('forbidden', { status: 403 });
    return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
  },
};

const MAX_MSG = 4096;

/** 每條連線的資料（serializeAttachment，休眠醒來還在） */
interface Att {
  cap: 2 | 4;
  cid: string;
  role: 'host' | 'guest';
  hostCid?: string; // 4 人房：房主的 cid（房主斷線回來還是房主）
  gone?: boolean; // 被同一個 cid 的新連線取代了（關閉中，不算人數、不通知）
}

export class Room extends DurableObject<Env> {
  private arb: Arbiter;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const n = (s: string | undefined, d: number) => (s && Number.isFinite(Number(s)) ? Number(s) : d);
    this.arb = new Arbiter({ hitWindowMs: n(env.ARB_HIT_MS, ARB_DEFAULTS.hitWindowMs), landWindowMs: n(env.ARB_LAND_MS, ARB_DEFAULTS.landWindowMs) });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const cid = (url.searchParams.get('cid') ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
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
    const peers = all.filter((ws) => !att(ws)?.gone);
    const cap = Math.max(url.searchParams.get('cap') === '4' ? 4 : 2, ...peers.map((ws) => att(ws)?.cap ?? 2)) as 2 | 4;
    return cap === 4 ? this.join4(peers, cid) : this.join2(peers, cid);
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
    server.send(JSON.stringify({ t: 'welcome', role, peers: peers.length }));
    for (const ws of peers) safeSend(ws, JSON.stringify({ t: 'peer-join' }));
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
    server.send(JSON.stringify({ t: 'welcome', role, peers: peers.length, cap: 4, cid, ids: atts.map((a) => a.cid) }));
    for (const ws of peers) safeSend(ws, JSON.stringify({ t: 'peer-join', cid }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== 'string' || msg.length > MAX_MSG) return;
    const a = att(ws);
    if (a?.gone) return;
    if (a?.cap === 4) {
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
    for (const other of this.ctx.getWebSockets()) if (other !== ws && !att(other)?.gone) safeSend(other, msg);
  }

  /** 裁決結果廣播給所有人（包含送出的人，他要知道自己有沒有被採用） */
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
    if (!a?.gone) {
      const left = JSON.stringify(a?.cap === 4 ? { t: 'peer-left', cid: a.cid } : { t: 'peer-left' });
      for (const other of this.ctx.getWebSockets()) if (other !== ws && !att(other)?.gone) safeSend(other, left);
    }
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {
      /* 已經關了 */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
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
