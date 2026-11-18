import { useEffect, useRef } from "react";

export type LiveEvent = { kind: string; taskId?: number; at: string } | null; // null = "refetch everything"
type Fn = (e: LiveEvent) => void;

const subs = new Set<Fn>();
let es: EventSource | null = null;
let timer: number | undefined;

function emit(e: LiveEvent) {
  for (const f of subs) f(e);
}

function connect() {
  if (es || !subs.size) return;
  es = new EventSource("/api/events");
  let opened = false;
  es.addEventListener("open", () => {
    if (opened) emit(null); // reconnected: we may have missed changes
    opened = true;
  });
  es.addEventListener("change", (m) => {
    try {
      emit(JSON.parse((m as MessageEvent).data));
    } catch {
      emit(null);
    }
  });
  // Changes made by processes that do not share this server's event bus (e.g. the stdio MCP adapter)
  // are picked up on focus and by a slow poll.
  window.addEventListener("focus", onFocus);
  timer = window.setInterval(() => emit(null), 60_000);
}
const onFocus = () => emit(null);

function disconnect() {
  if (subs.size) return;
  es?.close();
  es = null;
  window.removeEventListener("focus", onFocus);
  window.clearInterval(timer);
}

export function useLive(fn: Fn) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const f: Fn = (e) => ref.current(e);
    subs.add(f);
    connect();
    return () => {
      subs.delete(f);
      disconnect();
    };
  }, []);
}

export function closeLive() {
  subs.clear();
  disconnect();
}
