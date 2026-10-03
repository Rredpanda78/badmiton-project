import type { Difficulty, Venue } from '../config';
import { PROTOCOL, type NetMsg, type PeerMsg } from './protocol';

/** 房間伺服器（Cloudflare Worker）；網址加 ?server=local 改連本機的 wrangler dev */
const PROD_SERVER = 'wss://badminton-rooms.rredpanda78.workers.dev';
export const ROOM_SERVER = new URLSearchParams(location.search).get('server') === 'local' ? 'ws://127.0.0.1:8787' : PROD_SERVER;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 不用 0/O、1/I 這種容易看錯的
export function newRoomCode(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

export interface Hello {
  name: string;
  character: string;
  racket: string;
  points: 11 | 15 | 21;
  games: 1 | 3;
  venue: Venue;
  matchType?: 'singles' | 'doubles'; // 房主建房時選的（加入的人用房主的）
  difficulty?: Difficulty; // 雙打 AI 隊友的強度
  shirt?: number; // 自己選的球衣顏色
  shorts?: number;
  partner?: string; // 雙打：自己的 AI 隊友（球員 id、球拍）
  partnerRacket?: string;
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
 */
export class RoomClient {
  role: 'host' | 'guest' | null = null;
  peer: Hello | null = null;
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
  onStart: (start: StartInfo, peer: Hello, host: boolean) => void = () => {};
  /** 比賽中的訊息（狀態、擊球、判定、ping） */
  onGame: (msg: PeerMsg) => void = () => {};
  /** 對方離開或斷線 */
  onPeerLeft: () => void = () => {};
  /** 自己跟伺服器斷線（會自動重連） */
  onDisconnect: () => void = () => {};
  /** 比賽中對方（重新）連上：host = 自己是房主（由房主送「繼續比賽」） */
  onRejoin: (peer: Hello, host: boolean) => void = () => {};
  /** 房主送來的「繼續比賽」 */
  onResume: (msg: Extract<PeerMsg, { t: 'resume' }>) => void = () => {};

  constructor(readonly code: string, private hello: () => Hello) {}

  connect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.onStatus(this.retries ? '重新連線中…' : '連線中…', 'wait');
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${ROOM_SERVER}/room/${this.code}`);
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
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByMe) return;
      // 斷線（例如切到別的 App 分享房號、網路不穩）：自動重連，對方會先看到我離開、我回來後繼續
      this.peer = null;
      this.sentHello = false;
      if (this.retries >= 8) {
        this.onStatus('跟伺服器斷線了，請回主選單重新進房', 'error');
        this.onPeerLeft();
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

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: PeerMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByMe = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.send({ t: 'bye' });
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

  private maybeRematch(): void {
    if (!this.wantRematch || !this.peerRematch || this.role !== 'host' || !this.peer) return;
    this.wantRematch = this.peerRematch = false;
    this.sendStart();
  }

  private sendHello(): void {
    this.sentHello = true;
    this.send({ t: 'hello', v: PROTOCOL, ...this.hello() });
  }

  private sendStart(): void {
    const me = this.hello();
    const start: StartInfo = { points: me.points, games: me.games, venue: me.venue, matchType: me.matchType ?? 'singles', difficulty: me.difficulty ?? 'normal' };
    this.send({ t: 'start', ...start });
    this.onStart(start, this.peer!, true);
  }

  private handle(msg: NetMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.role = msg.role;
        this.retries = 0;
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
        this.onPeerLeft();
        break;
      case 'hello':
        if (msg.v !== PROTOCOL) {
          this.onStatus('雙方遊戲版本不同，請兩邊都重新整理網頁', 'error');
          return;
        }
        this.peer = { name: msg.name, character: msg.character, racket: msg.racket, points: msg.points, games: msg.games, venue: msg.venue, shirt: msg.shirt, shorts: msg.shorts, partner: msg.partner, partnerRacket: msg.partnerRacket };
        if (!this.sentHello) this.sendHello();
        if (this.inMatch) {
          this.onRejoin(this.peer, this.role === 'host');
          return;
        }
        if (this.role === 'host') this.sendStart();
        else this.onStatus('對手準備好了，等房主開始…', 'ok');
        break;
      case 'start':
        if (this.peer) {
          this.wantRematch = this.peerRematch = false;
          this.onStart({ points: msg.points, games: msg.games, venue: msg.venue, matchType: msg.matchType ?? 'singles', difficulty: msg.difficulty ?? 'normal' }, this.peer, false);
        }
        break;
      case 'resume':
        this.onResume(msg);
        break;
      case 'rematch':
        this.peerRematch = true;
        if (!this.wantRematch) this.onStatus('對手想再來一場！', 'ok');
        this.maybeRematch();
        break;
      default:
        this.onGame(msg);
    }
  }
}
