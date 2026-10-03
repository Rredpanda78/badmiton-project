import type { Difficulty, MoveMode, Venue } from '../config';
import { PROTOCOL, type NetMsg, type PeerMsg, type SpecMsg } from './protocol';

/** 房間伺服器（Cloudflare Worker）；網址加 ?server=local 改連本機的 wrangler dev（?server=local:8797 = 指定連接埠） */
const PROD_SERVER = 'wss://badminton-rooms.rredpanda78.workers.dev';
const serverParam = new URLSearchParams(location.search).get('server') ?? '';
const localPort = /^local(?::(\d{2,5}))?$/.exec(serverParam);
export const ROOM_SERVER = localPort ? `ws://127.0.0.1:${localPort[1] ?? '8787'}` : PROD_SERVER;
/** 遊戲大廳的名單（GET，JSON { rooms: LobbyRoom[] }） */
export const LOBBY_URL = ROOM_SERVER.replace(/^ws/, 'http') + '/lobby';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 不用 0/O、1/I 這種容易看錯的
export function newRoomCode(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

// ---------- 連線編號、斷線回來的紀錄 ----------
let memCid = '';
const randId = () => Array.from({ length: 10 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
/**
 * 這個分頁的連線編號：存在 sessionStorage（重新整理還是同一個、開新分頁就不同），
 * 伺服器靠它認出「同一個人重新連上」（4 人房拿回同一個座位、舊的連線作廢）
 */
export function clientId(): string {
  try {
    let c = sessionStorage.getItem('badminton.cid');
    if (!c) {
      c = randId();
      sessionStorage.setItem('badminton.cid', c);
    }
    return c;
  } catch {
    return (memCid ||= randId());
  }
}
/** 這個分頁已經有連線編號了嗎（重新整理 = 有，新分頁 = 沒有）；不會產生新的 */
export function peekClientId(): string | null {
  try {
    return sessionStorage.getItem('badminton.cid') ?? (memCid || null);
  } catch {
    return memCid || null;
  }
}
/** 從「回到剛剛的房間」進來：沿用當時的連線編號 */
export function adoptClientId(cid: string): void {
  memCid = cid;
  try {
    sessionStorage.setItem('badminton.cid', cid);
  } catch {
    /* 私密模式 */
  }
}

/** 最近一場線上比賽（localStorage）：關掉分頁、手機睡著、不小心按了離開，10 分鐘內可以從主選單回去 */
export interface RejoinRecord {
  code: string;
  cid: string;
  cap: 2 | 4;
  t: number;
  /** 自己按了離開（回主選單只顯示按鈕，不會自動回去） */
  left?: boolean;
}
const REJOIN_KEY = 'badminton.rejoin';
export const REJOIN_MAX_AGE = 10 * 60 * 1000;
/** 紀錄依連線編號分開存（同一個瀏覽器開好幾個分頁在不同房間也不會互相蓋掉），只留 10 分鐘內的 */
function readRejoins(): Record<string, RejoinRecord> {
  try {
    const raw = JSON.parse(localStorage.getItem(REJOIN_KEY) ?? '{}') as Record<string, RejoinRecord>;
    const out: Record<string, RejoinRecord> = {};
    if (raw && typeof raw === 'object' && !('code' in raw)) {
      for (const [cid, r] of Object.entries(raw)) if (r && typeof r.code === 'string' && r.cid === cid && Date.now() - r.t < REJOIN_MAX_AGE) out[cid] = r;
    }
    return out;
  } catch {
    return {};
  }
}
function writeRejoins(m: Record<string, RejoinRecord>): void {
  try {
    const recent = Object.values(m)
      .sort((a, b) => b.t - a.t)
      .slice(0, 6);
    localStorage.setItem(REJOIN_KEY, JSON.stringify(Object.fromEntries(recent.map((r) => [r.cid, r]))));
  } catch {
    /* ignore */
  }
}
export function saveRejoin(r: RejoinRecord): void {
  const m = readRejoins();
  m[r.cid] = r;
  writeRejoins(m);
}
/** cid = 這個分頁的紀錄（重新整理後自動回去用）；沒給 = 最近的一筆（主選單的按鈕用） */
export function loadRejoin(cid?: string | null): RejoinRecord | null {
  const m = readRejoins();
  if (cid !== undefined) return cid ? (m[cid] ?? null) : null;
  return Object.values(m).sort((a, b) => b.t - a.t)[0] ?? null;
}
export function clearRejoin(cid: string): void {
  const m = readRejoins();
  delete m[cid];
  writeRejoins(m);
}

export interface Hello {
  name: string;
  character: string;
  racket: string;
  points: 11 | 15 | 21;
  games: 1 | 3;
  venue: Venue;
  matchType?: 'singles' | 'doubles' | 'quad'; // 房主建房時選的（加入的人用房主的）
  difficulty?: Difficulty; // 雙打 AI 隊友的強度
  shirt?: number; // 自己選的球衣顏色
  shorts?: number;
  partner?: string; // 雙打：自己的 AI 隊友（球員 id、球拍）
  partnerRacket?: string;
  cid?: string;
  mv?: MoveMode; // 自己的跑位設定
  ms?: 0 | 1 | 2;
}
export interface StartInfo {
  points: 11 | 15 | 21;
  games: 1 | 3;
  venue: Venue;
  matchType: 'singles' | 'doubles';
  difficulty: Difficulty;
}

/**
 * 一個線上房間的連線：先到的是房主。兩邊互送 hello（球員、球拍、設定），
 * 房主收到對方的 hello 後送 start（用房主的分數、局數、場地），兩邊同時開打。
 * 4 人房（cap = 4）：連線、重連還是這裡管，訊息全部交給 onQuad（src/main.ts 的 4 人大廳）。
 */
export class RoomClient {
  role: 'host' | 'guest' | 'spectator' | null = null;
  /** 觀眾：連線網址帶 ?spec=1，沒有座位；所有訊息交給 onSpectate（src/net/spectate.ts） */
  spectator = false;
  peer: Hello | null = null;
  /** 對方 hello 帶來的比賽狀態（0 = 沒有比賽，要先送 start 給他重建） */
  peerMs: 0 | 1 | 2 = 0;
  /** 房間人數上限：建立 4 人房、或伺服器說這是 4 人房 = 4 */
  cap: 2 | 4 = 2;
  cid = clientId();
  /** 自己的連線斷過（比賽狀態可能落後）；繼續比賽後清掉 */
  dropped = false;
  private ws: WebSocket | null = null;
  private sentHello = false;
  private wantRematch = false;
  private peerRematch = false;
  private closedByMe = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 這個房間是自己建的（顯示的等待文字不同） */
  creator = false;
  /** 比賽進行中（對方重新連線時改送「繼續比賽」而不是重開一場） */
  inMatch = false;

  /** 狀態文字（給 UI 顯示） */
  onStatus: (text: string, kind: 'wait' | 'ok' | 'error') => void = () => {};
  onStart: (start: StartInfo, peer: Hello, host: boolean, rejoin: boolean) => void = () => {};
  /** 比賽中的訊息（狀態、擊球、判定、ping） */
  onGame: (msg: PeerMsg) => void = () => {};
  /** 對方離開或斷線（bye = 對方自己按離開） */
  onPeerLeft: (bye: boolean) => void = () => {};
  /** 自己跟伺服器斷線（會自動重連） */
  onDisconnect: () => void = () => {};
  /** 自動重連放棄了（或被別的分頁取代）：交給 UI 讓玩家選重試／AI 接手／離開 */
  onGiveUp: () => void = () => {};
  /**
   * 比賽中對方（重新）連上：lead = 由自己帶大家繼續（比賽狀態比較新的那一邊；一樣就房主），
   * 不是 lead 就等對方送 start（重建）＋ resume
   */
  onRejoin: (peer: Hello, lead: boolean) => void = () => {};
  /** 對方送來的「繼續比賽」 */
  onResume: (msg: Extract<PeerMsg, { t: 'resume' }>) => void = () => {};
  /** 4 人房：所有訊息（含伺服器的 welcome／peer-join／peer-left） */
  onQuad: (msg: NetMsg) => void = () => {};
  /** 觀眾：所有訊息（2 人房的訊息多帶 fr = 誰送的） */
  onSpectate: (msg: SpecMsg) => void = () => {};
  /** 2 人房：有觀眾進來要狀態快照（房主回 snap） */
  onSpecHello: () => void = () => {};
  /** 2 人房：觀眾人數變了 */
  onSpectators: (n: number) => void = () => {};
  /** 2 人房：連上了（房主要把房間資料送給大廳） */
  onWelcome: () => void = () => {};

  constructor(
    readonly code: string,
    private hello: () => Hello,
  ) {}

  /** 0 = 沒在比賽、1 = 比賽中但自己斷過線、2 = 比賽中一直都在 */
  matchState(): 0 | 1 | 2 {
    return this.inMatch ? (this.dropped ? 1 : 2) : 0;
  }

  connect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.onStatus(this.retries ? '重新連線中…' : '連線中…', 'wait');
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${ROOM_SERVER}/room/${this.code}?cid=${encodeURIComponent(this.cid)}${this.cap === 4 ? '&cap=4' : ''}${this.spectator ? '&spec=1' : ''}`);
    } catch {
      this.onStatus('連不上伺服器', 'error');
      return;
    }
    this.ws = ws;
    ws.onmessage = (e) => {
      let msg: NetMsg;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByMe) return;
      if (ev.code === 4002) {
        // 同一個連線編號在別的地方連上了（例如另一個分頁按了「回到剛剛的房間」）：這邊不要再搶回來
        this.closedByMe = true;
        this.onStatus('這個房間在另一個分頁（或另一次連線）打開了', 'error');
        this.onGiveUp();
        return;
      }
      // 斷線（例如切到別的 App 分享房號、網路不穩）：自動重連，對方會先看到我離開、我回來後繼續
      this.peer = null;
      this.sentHello = false;
      if (this.inMatch) this.dropped = true;
      if (this.retries >= 8) {
        this.onStatus('跟伺服器斷線了', 'error');
        this.onGiveUp();
        return;
      }
      this.onStatus('連線中斷，重新連線中…', 'wait');
      this.onDisconnect();
      const delay = Math.min(5000, 400 * 2 ** this.retries++);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      if (!this.retries) this.onStatus('連不上伺服器，重試中…', 'error');
    };
  }

  /** 回到遊戲（從別的 App 切回來）：沒連上就馬上重連 */
  wake(): void {
    if (this.closedByMe || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    this.retries = Math.max(1, this.retries);
    this.connect();
  }

  /** 放棄重連之後玩家按「重試」 */
  retry(): void {
    this.closedByMe = false;
    this.retries = 1;
    if (!this.ws) this.connect();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: PeerMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByMe = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.send({ t: 'bye', cid: this.cid });
    this.ws?.close(1000);
    this.ws = null;
  }

  /** 比賽結束後再來一場：兩邊都按了，房主就送 start */
  requestRematch(): void {
    this.wantRematch = true;
    this.send({ t: 'rematch' });
    this.onStatus('等對方也按「再來一場」…', 'wait');
    this.maybeRematch();
  }

  /** 斷線回來：照目前這場的設定請對方重建比賽（接著送 resume） */
  sendRejoinStart(start: StartInfo): void {
    this.send({ t: 'start', ...start, rj: 1 });
  }

  private maybeRematch(): void {
    if (!this.wantRematch || !this.peerRematch || this.role !== 'host' || !this.peer) return;
    this.wantRematch = this.peerRematch = false;
    this.sendStart();
  }

  private sendHello(): void {
    this.sentHello = true;
    this.send({ t: 'hello', v: PROTOCOL, ...this.hello(), cid: this.cid, ms: this.matchState() });
  }

  private sendStart(): void {
    const me = this.hello();
    const start: StartInfo = { points: me.points, games: me.games, venue: me.venue, matchType: me.matchType === 'doubles' ? 'doubles' : 'singles', difficulty: me.difficulty ?? 'normal' };
    this.send({ t: 'start', ...start });
    this.onStart(start, this.peer!, true, false);
  }

  private handle(msg: NetMsg): void {
    if ((msg.t === 'welcome' || msg.t === 'full') && msg.cap === 4) this.cap = 4;
    if (this.spectator) {
      // 觀眾：全部交給 spectate.ts
      if (msg.t === 'welcome') {
        this.role = msg.role;
        this.retries = 0;
      }
      if (msg.t === 'full') this.closedByMe = true;
      this.onSpectate(msg as SpecMsg);
      return;
    }
    if (this.cap === 4) {
      // 4 人房：大廳、比賽都由 main.ts 的 4 人邏輯處理
      if (msg.t === 'welcome') {
        this.role = msg.role;
        this.retries = 0;
      }
      if (msg.t === 'full') this.closedByMe = true;
      this.onQuad(msg);
      return;
    }
    switch (msg.t) {
      case 'welcome':
        this.role = msg.role;
        this.retries = 0;
        if (msg.spec !== undefined) this.onSpectators(msg.spec);
        this.onWelcome();
        if (msg.peers === 0) {
          if (this.inMatch) this.onStatus('重新連上了，等對手回來…', 'wait');
          else if (this.creator) this.onStatus('等待對手加入…（把房號或連結傳給朋友）', 'wait');
          else this.onStatus(`房間 ${this.code} 目前沒有人（房主可能暫時離開，或房號打錯），等對方回來…`, 'wait');
        } else this.sendHello();
        break;
      case 'full':
        this.closedByMe = true;
        this.onStatus('這個房間已經有兩個人了', 'error');
        break;
      case 'peer-join':
        this.peer = null;
        this.onStatus('對手加入了，準備中…', 'ok');
        this.sendHello();
        break;
      case 'peer-left':
      case 'bye':
        this.peer = null;
        this.sentHello = false;
        this.wantRematch = this.peerRematch = false;
        this.onStatus('對手離開了，等待其他人加入…', 'wait');
        this.onPeerLeft(msg.t === 'bye');
        break;
      case 'hello': {
        if (msg.v !== PROTOCOL) {
          this.onStatus('雙方遊戲版本不同，請兩邊都重新整理網頁', 'error');
          return;
        }
        this.peer = { name: msg.name, character: msg.character, racket: msg.racket, points: msg.points, games: msg.games, venue: msg.venue, shirt: msg.shirt, shorts: msg.shorts, partner: msg.partner, partnerRacket: msg.partnerRacket, cid: msg.cid, mv: msg.mv };
        this.peerMs = msg.ms ?? 0;
        if (!this.sentHello) this.sendHello();
        const mine = this.matchState();
        if (mine || this.peerMs) {
          // 有人在比賽中（斷線回來）：比賽狀態最新的那一邊（一直都在 > 斷過線 > 沒有）帶大家繼續，一樣就房主
          this.onRejoin(this.peer, mine > this.peerMs || (mine === this.peerMs && this.role === 'host'));
          return;
        }
        if (this.role === 'host') this.sendStart();
        else this.onStatus('對手準備好了，等房主開始…', 'ok');
        break;
      }
      case 'start':
        if (this.peer) {
          this.wantRematch = this.peerRematch = false;
          this.onStart({ points: msg.points, games: msg.games, venue: msg.venue, matchType: msg.matchType ?? 'singles', difficulty: msg.difficulty ?? 'normal' }, this.peer, false, !!msg.rj);
        }
        break;
      case 'resume':
        this.dropped = false;
        this.peerMs = 2; // 帶大家繼續的是對方：他的狀態最新（觀眾要快照時由他回）
        this.onResume(msg);
        break;
      case 'rematch':
        this.peerRematch = true;
        if (!this.wantRematch) this.onStatus('對手想再來一場！', 'ok');
        this.maybeRematch();
        break;
      case 'spec':
        this.onSpectators(msg.n);
        break;
      case 'spec-hello':
        this.onSpecHello();
        break;
      case 'snap':
      case 'lob':
        break; // 只有觀眾／伺服器會收到
      default:
        this.onGame(msg);
    }
  }
}
