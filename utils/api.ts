// Server API client + WebSocket hook for real-time events

const API_BASE = '';

export async function apiGet<T = any>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function apiPost<T = any>(path: string, body?: any): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `API ${path}: ${res.status}`);
  }
  return res.json();
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

export type WsMessage =
  | { type: 'sipStatus'; data: string }
  | { type: 'callState'; data: any }
  | { type: 'callEnded'; data: any }
  | { type: 'transcript'; data: { callId: string; speaker: 'agent' | 'user'; text: string } }
  | { type: 'activeCalls'; data: any[] }
  | { type: 'log'; data: { level: string; msg: string; time: string } };

type WsListener = (msg: WsMessage) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<WsListener>();
  private reconnectTimer: number | null = null;
  private _connected = false;

  connect() {
    if (this.ws) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this._connected = true;
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg: WsMessage = JSON.parse(ev.data);
        for (const listener of this.listeners) {
          listener(msg);
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    this.ws.onclose = () => {
      this._connected = false;
      this.ws = null;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  subscribe(listener: WsListener): () => void {
    this.listeners.add(listener);
    if (!this.ws) this.connect();
    return () => this.listeners.delete(listener);
  }

  get connected() {
    return this._connected;
  }
}

export const wsClient = new WsClient();
