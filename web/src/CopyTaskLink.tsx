import { useEffect, useRef, useState } from "react";
import { Check, CopyLink, Alert } from "./icons";

/** Older browsers without Clipboard API still get a one-click copy in the user gesture. */
function legacyCopy(text: string) {
  const focused = document.activeElement as HTMLElement | null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    if (!document.execCommand("copy")) throw new Error("Copy denied");
  } finally {
    input.remove();
    focused?.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); ranges.forEach((range) => selection.addRange(range)); }
  }
}

export function CopyTaskLink({ id }: { id: number }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);

  const copy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const url = new URL(`/t/${id}`, window.location.origin).href;
    clearTimeout(reset.current);
    try {
      // Start writeText inside the click gesture (required by Safari), before any other await.
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
      else legacyCopy(url);
      setState("copied");
    } catch {
      setState("error");
    }
    reset.current = setTimeout(() => setState("idle"), 2000);
  };
  const feedback = state === "copied" ? "Ссылка скопирована" : state === "error" ? "Не удалось скопировать ссылку. Нажмите, чтобы повторить." : "";
  return (
    <button
      type="button" className={`copy-link-btn ${state}`} data-task-id={id}
      aria-label={`Скопировать ссылку на задачу #${id}`} title={feedback || "Скопировать ссылку"}
      onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}
      onClick={copy}
    >
      {state === "copied" ? <Check size={14} /> : state === "error" ? <Alert size={14} /> : <CopyLink size={14} />}
      <span className="sr-only" role="status">{feedback}</span>
    </button>
  );
}
