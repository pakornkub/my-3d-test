// bridge.js -- the scene's WebSocket client to the Office Server.
//
// Same shape as MockDriver ({ start, stop, send }) so main.js can swap one for the other.
// Reconnects with backoff; tells main.js when it is live so the UI can switch modes, and
// when it gives up so the mock can take the seat (GitHub Pages has no server at all).

import { validate } from './events.js';

export class Bridge {
  /**
   * @param url      ws(s)://host/office ; default derives from the page origin (Vite proxies /office)
   * @param emit     (event) => void
   * @param onState  ('connecting' | 'live' | 'down', detail) => void
   */
  constructor({ url, emit, onState = () => {}, firstTryMs = 2500 }) {
    this.url = url ?? defaultUrl();
    this.emit = emit;
    this.onState = onState;
    this.firstTryMs = firstTryMs;
    this.ws = null;
    this.live = false;
    this.stopped = false;
    this.attempt = 0;
    this.hello = null;
  }

  start() {
    this.stopped = false;
    this.#connect();
    return this;
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    this.live = false;
  }

  send(msg) {
    if (!this.live || this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  #connect() {
    if (this.stopped) return;
    this.onState('connecting', this.url);
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this.#down(e.message); return; }
    this.ws = ws;
    const timer = setTimeout(() => { if (ws.readyState !== 1) ws.close(); }, this.firstTryMs);
    ws.onopen = () => { clearTimeout(timer); this.attempt = 0; this.live = true; this.onState('live', this.url); };
    ws.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.type === 'hello') this.hello = ev;
      const errs = validate(ev);
      if (errs.length) { console.warn('[bridge] malformed event from server', ev.type, errs); return; }
      this.emit(ev);
    };
    ws.onclose = () => {
      clearTimeout(timer);
      const wasLive = this.live;
      this.live = false;
      if (this.stopped) return;
      this.attempt++;
      this.#down(wasLive ? 'connection lost' : 'no server');
      // keep trying quietly; the mock covers the gap
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(this.attempt, 4));
      setTimeout(() => this.#connect(), delay);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  #down(detail) { this.onState('down', detail); }
}

export function defaultUrl() {
  const q = new URLSearchParams(location.search).get('office');
  if (q) return q;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/office`;
}
