import { authHeaders, setToken, unauthorizedEvent } from "./token";

type Listener = (e: Event) => void;

/**
 * The part of EventSource the channel view uses, built on fetch because EventSource cannot send an
 * Authorization header. It does not reconnect: a dropped stream closes it and fires onerror, and the
 * view reloads the stored run.
 */
export class AuthedEventSource {
  static readonly CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Listener[]>();
  private abort = new AbortController();

  constructor(url: string) {
    void this.read(url);
  }

  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close() {
    this.readyState = AuthedEventSource.CLOSED;
    this.abort.abort();
  }

  private fail() {
    if (this.readyState === AuthedEventSource.CLOSED) return;
    this.readyState = AuthedEventSource.CLOSED;
    this.onerror?.();
  }

  private emit(type: string, data: string, id: string) {
    const e = new MessageEvent(type, { data, lastEventId: id });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }

  private async read(url: string) {
    try {
      const res = await fetch(url, {
        headers: { accept: "text/event-stream", ...authHeaders() },
        signal: this.abort.signal,
      });
      if (res.status === 401) {
        setToken(null);
        window.dispatchEvent(new Event(unauthorizedEvent));
      }
      if (!res.ok || !res.body) return this.fail();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value.replace(/\r\n?/g, "\n");
        for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
          this.dispatch(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
        }
      }
      this.fail();
    } catch {
      this.fail();
    }
  }

  private dispatch(block: string) {
    let type = "message";
    let id = "";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const val = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") type = val;
      else if (field === "id") id = val;
      else if (field === "data") data.push(val);
    }
    this.emit(type, data.join("\n"), id);
    // "end" is the server's last word; closing here keeps the stream's own close from reading as an error.
    if (type === "end") this.close();
  }
}
