import { useRef } from "react";
import type { Priority } from "./api";

export const PRIORITY_LABEL: Record<Priority, string> = { low: "Низкий", normal: "Обычный", high: "Высокий" };
const ORDER: Priority[] = ["low", "normal", "high"];

/** Chevron up = high, flat line = normal, chevron down = low (shape carries the meaning, not only the colour). */
export function PriorityIcon({ p, size = 14 }: { p: Priority; size?: number }) {
  const d = p === "high" ? "M4 10l4-4 4 4" : p === "low" ? "M4 6l4 4 4-4" : "M4.5 8h7";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}>
      <path d={d} />
    </svg>
  );
}

/**
 * Small mark on a card. «Обычный» is the default and is not shown on the board.
 * compact (epic header row): chevron only, the word stays in the tooltip and for screen readers.
 */
export function PriorityBadge({ p, compact = false }: { p: Priority; compact?: boolean }) {
  if (p === "normal") return null;
  const label = `Приоритет: ${PRIORITY_LABEL[p].toLowerCase()}`;
  return (
    <span className={`prio prio-${p}${compact ? " compact" : ""}`} title={label}>
      <PriorityIcon p={p} size={compact ? 14 : 12} />
      {compact ? <span className="sr-only">{label}</span> : PRIORITY_LABEL[p]}
    </span>
  );
}

/** Three-way segmented control (radio group): saves immediately, arrows move the choice. */
export function PriorityField({ id, value, onChange }: { id: string; value: Priority; onChange: (p: Priority) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const pick = (p: Priority, focus = false) => {
    if (p !== value) onChange(p);
    if (focus) refs.current[ORDER.indexOf(p)]?.focus();
  };
  return (
    <div className="prio-field" role="radiogroup" aria-labelledby={id}
      onKeyDown={(e) => {
        const i = ORDER.indexOf(value);
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); pick(ORDER[Math.min(2, i + 1)], true); }
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); pick(ORDER[Math.max(0, i - 1)], true); }
      }}
    >
      {ORDER.map((p, i) => (
        <button
          key={p} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={value === p}
          tabIndex={value === p ? 0 : -1} className={`prio-opt prio-${p}`} onClick={() => pick(p)}
        >
          <PriorityIcon p={p} />{PRIORITY_LABEL[p]}
        </button>
      ))}
    </div>
  );
}
