import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Tag, type TagColor } from "./api";
import { Check, Close, Plus } from "./icons";

export const COLORS: TagColor[] = ["slate", "blue", "teal", "green", "amber", "orange", "rose", "violet"];
export const COLOR_NAMES: Record<TagColor, string> = {
  slate: "графит", blue: "синий", teal: "бирюзовый", green: "зелёный", amber: "янтарный", orange: "оранжевый", rose: "розовый", violet: "фиолетовый",
};

export function TagPill({ tag, onRemove }: { tag: Tag; onRemove?: () => void }) {
  return (
    <span className={`tag tag-${tag.color}`}>
      <span className="dot" aria-hidden="true" />
      {tag.name}
      {onRemove && (
        <button type="button" className="x" aria-label={`Убрать тег ${tag.name}`} onClick={onRemove}>
          <Close size={12} />
        </button>
      )}
    </span>
  );
}

function useOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [ref, onClose]);
}

/** Create a tag (name + color). */
export function NewTagPopover({ onCreated, onClose, style }: { onCreated: (t: Tag) => void; onClose: () => void; style?: React.CSSProperties }) {
  const ref = useRef<HTMLFormElement>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>("blue");
  const [err, setErr] = useState("");
  useOutside(ref, onClose);
  return (
    <form
      ref={ref}
      className="popover"
      style={style}
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          onCreated(await api.createTag(name, color));
          onClose();
        } catch (x) {
          setErr(x instanceof ApiError ? x.message : "Не удалось создать тег");
        }
      }}
    >
      <label className="sr-only" htmlFor="new-tag-name">Имя тега</label>
      <input id="new-tag-name" type="text" autoFocus placeholder="Имя проекта" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
      <div className="swatches" role="group" aria-label="Цвет">
        {COLORS.map((c) => (
          <button key={c} type="button" className={`swatch tag-${c}`} aria-pressed={color === c} aria-label={COLOR_NAMES[c]} title={COLOR_NAMES[c]} onClick={() => setColor(c)} />
        ))}
      </div>
      {err && <div className="field-error" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10 }}>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>Отмена</button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!name.trim()}>Создать</button>
      </div>
    </form>
  );
}

/** Pick tags for a task; can create a new one from the search text. */
export function TagPicker({
  all, selected, onToggle, onCreate, onClose, style,
}: {
  all: Tag[]; selected: number[]; onToggle: (t: Tag) => void; onCreate: (name: string) => Promise<void>; onClose: () => void; style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  useOutside(ref, onClose);
  const list = useMemo(() => all.filter((t) => t.name.toLocaleLowerCase("ru").includes(q.trim().toLocaleLowerCase("ru"))), [all, q]);
  const exact = all.some((t) => t.name.toLocaleLowerCase("ru") === q.trim().toLocaleLowerCase("ru"));
  return (
    <div ref={ref} className="popover" style={style} role="dialog" aria-label="Теги задачи">
      <label className="sr-only" htmlFor="tag-search">Найти или создать тег</label>
      <input
        id="tag-search" type="text" autoFocus placeholder="Найти или создать…" value={q} maxLength={40}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (list.length === 1) onToggle(list[0]);
            else if (q.trim() && !exact) { await onCreate(q.trim()); setQ(""); }
          }
        }}
      />
      <div className="pick-list">
        {list.map((t) => (
          <button key={t.id} type="button" className="pick-item" aria-pressed={selected.includes(t.id)} onClick={() => onToggle(t)}>
            <TagPill tag={t} />
            {selected.includes(t.id) && <span className="check"><Check size={14} /></span>}
          </button>
        ))}
        {q.trim() && !exact && (
          <button type="button" className="pick-item" onClick={async () => { await onCreate(q.trim()); setQ(""); }}>
            <Plus size={14} /> Создать тег «{q.trim()}»
          </button>
        )}
        {!list.length && !q.trim() && <div className="muted small" style={{ padding: 8 }}>Тегов пока нет</div>}
      </div>
    </div>
  );
}
