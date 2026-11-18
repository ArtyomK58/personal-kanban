import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Board, EpicSummary, Tag } from "./api";
import { Diamond } from "./epics";
import { Close, External } from "./icons";
import { CopyTaskLink } from "./CopyTaskLink";
import { TaskView, useTask } from "./TaskView";

/** Right-hand side panel. The board stays mounted underneath, so its filters and scroll position are kept. */
export function TaskPanel({
  id, statuses, tags, epics, onOpen, onClose, onChanged,
}: { id: number; statuses: Board["statuses"]; tags: Tag[]; epics: EpicSummary[]; onOpen: (id: number) => void; onClose: () => void; onChanged: () => void }) {
  const { task, setTask, error, reload } = useTask(id);
  const isEpic = task?.kind === "epic";
  const [closing, setClosing] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const prevFocus = useRef<Element | null>(document.activeElement);

  const close = () => {
    if (closing) return;
    setClosing(true);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(onClose, reduce ? 0 : 130);
  };

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        const el = e.target as HTMLElement;
        if (["TEXTAREA", "INPUT", "SELECT"].includes(el.tagName)) return;
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    const pf = prevFocus.current;
    return () => {
      window.removeEventListener("keydown", onKey);
      if (pf instanceof HTMLElement) pf.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className={`panel-backdrop${closing ? " closing" : ""}`} onClick={close} aria-hidden="true" />
      <aside ref={ref} className={`panel${closing ? " closing" : ""}`} role="dialog" aria-modal="false" aria-label={task ? `${isEpic ? "Эпик" : "Задача"} #${task.id}` : "Задача"} tabIndex={-1}>
        <div className="panel-head">
          {isEpic && <span className="panel-kind"><Diamond filled />Эпик</span>}
          <span className="num mono">#{id}</span>
          <span className="spacer" />
          <CopyTaskLink id={id} />
          <Link className="btn btn-sm btn-ghost" to={`/t/${id}`}>Открыть страницей <External size={14} /></Link>
          <button type="button" className="icon-btn ghost" aria-label="Закрыть панель" onClick={close}><Close /></button>
        </div>
        <div className="panel-body">
          {error && <div className="center-note">{error}</div>}
          {!task && !error && <div className="center-note">Загрузка…</div>}
          {task && (
            <TaskView
              key={task.id} task={task} statuses={statuses} tags={tags} epics={epics} variant="panel" onOpen={onOpen}
              reload={() => { void reload(); onChanged(); }}
              setTask={(t) => { setTask(t); onChanged(); if (t.kind !== task.kind || t.epic_id !== task.epic_id) void reload(); }}
              onDeleted={() => { onChanged(); close(); }}
            />
          )}
        </div>
      </aside>
    </>
  );
}
