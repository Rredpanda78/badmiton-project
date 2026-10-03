/**
 * 羽球對決線上房間伺服器。
 * 一個房號 = 一個 Durable Object，最多兩人；伺服器不跑遊戲邏輯，只轉送兩邊的訊息
 * （遊戲同步在瀏覽器端：各自模擬，擊球方傳擊球、接球方判定得分）。
 * 用 WebSocket Hibernation：沒有訊息時物件會休眠，不計時間。
 */
import { DurableObject } from 'cloudflare:workers';

interface Env {
  ROOM: DurableObjectNamespace<Room>;
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

export class Room extends DurableObject<Env> {
  async fetch(_req: Request): Promise<Response> {
    const peers = this.ctx.getWebSockets();
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
    server.send(JSON.stringify({ t: 'welcome', role, peers: peers.length }));
    for (const ws of peers) safeSend(ws, JSON.stringify({ t: 'peer-join' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== 'string' || msg.length > MAX_MSG) return;
    for (const other of this.ctx.getWebSockets()) if (other !== ws) safeSend(other, msg);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    for (const other of this.ctx.getWebSockets()) if (other !== ws) safeSend(other, JSON.stringify({ t: 'peer-left' }));
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

function safeSend(ws: WebSocket, data: string): void {
  try {
    ws.send(data);
  } catch {
    /* 對方剛好斷線 */
  }
}
