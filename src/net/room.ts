import type { Venue } from '../config';
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
}
export interface StartInfo {
  points: 11 | 15 | 21;
  games: 1 | 3;
  venue: Venue;
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

  /** 狀態文字（給 UI 顯示） */
  onStatus: (text: string, kind: 'wait' | 'ok' | 'error') => void = () => {};
  onStart: (start: StartInfo, peer: Hello, host: boolean) => void = () => {};
  /** 比賽中的訊息（狀態、擊球、判定、ping） */
  onGame: (msg: PeerMsg) => void = () => {};
  /** 對方離開或斷線 */
  onPeerLeft: () => void = () => {};

  constructor(readonly code: string, private hello: () => Hello) {}

  connect(): void {
    this.onStatus('連線中…', 'wait');
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
      if (!this.closedByMe) {
        this.onStatus('跟伺服器斷線了', 'error');
        this.onPeerLeft();
      }
    };
    ws.onerror = () => this.onStatus('連不上伺服器', 'error');
  }

  send(msg: PeerMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByMe = true;
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
    const start: StartInfo = { points: me.points, games: me.games, venue: me.venue };
    this.send({ t: 'start', ...start });
    this.onStart(start, this.peer!, true);
  }

  private handle(msg: NetMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.role = msg.role;
        if (msg.peers === 0) this.onStatus('等待對手加入…（把房號或連結傳給朋友）', 'wait');
        else this.sendHello();
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
        this.peer = { name: msg.name, character: msg.character, racket: msg.racket, points: msg.points, games: msg.games, venue: msg.venue };
        if (!this.sentHello) this.sendHello();
        if (this.role === 'host') this.sendStart();
        else this.onStatus('對手準備好了，等房主開始…', 'ok');
        break;
      case 'start':
        if (this.peer) {
          this.wantRematch = this.peerRematch = false;
          this.onStart({ points: msg.points, games: msg.games, venue: msg.venue }, this.peer, false);
        }
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
