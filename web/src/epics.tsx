import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, FINAL_DONE_LABEL, progressPct, progressText, type EpicSummary, type Progress, type Status, type Tag, type TaskDetail, type TaskSummary } from "./api";
import { Check, Close, Plus, Search } from "./icons";

/** One diamond for everything epic: filled = «this is an epic», outline = «belongs to an epic». */
export function Diamond({ filled = false, size = 12, className }: { filled?: boolean; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 12 12" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}>
      <path d="M6 1.5 10.5 6 6 10.5 1.5 6z" />
    </svg>
  );
}
export const LinkIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1" />
  </svg>
);
const NoneIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M4.2 11.8l7.6-7.6" /></svg>
);

export const STATUS_DOT: Record<Status, string> = { inbox: "#9C9A92", in_progress: "#2F4FBF", review: "#D9A21B", done: "#3F8F3A", done_final: "#3F8F3A" };

/**
 * «◇ Имя эпика» link row of a child card. It opens the parent and never starts a drag or opens the child card:
 * pointer/mouse/touch/key events stop here.
 */
export function EpicLinkRow({ epic, onOpen, className = "epic-link" }: { epic: { id: number; title: string }; onOpen?: (id: number) => void; className?: string }) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <a
      className={className} href={`/t/${epic.id}`} title={`Эпик: ${epic.title}`}
      onPointerDown={stop} onMouseDown={stop} onTouchStart={stop} onKeyDown={stop}
      onClick={(e) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey || e.shiftKey || !onOpen) return;
        e.preventDefault();
        onOpen(epic.id);
      }}
    >
      <Diamond />
      <span className="sr-only">Эпик: </span>
      <span className="epic-link-name">{epic.title}</span>
    </a>
  );
}

const Track = ({ p, label }: { p: Progress; label: string }) => (
  <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-valuetext={progressText(p)}>
    <div className="progress-fill" style={{ width: `${progressPct(p)}%` }} />
  </div>
);

/** Card: 4px bar + «N из M готово». */
export function ProgressBar({ p }: { p: Progress }) {
  return (
    <div className="progress progress-card">
      <Track p={p} label="Прогресс эпика" />
      <span className="progress-text">{progressText(p)}</span>
    </div>
  );
}

/** Panel/page: «Прогресс … 1 из 3 готово» + 6px bar. */
export function EpicProgressSection({ id, p }: { id: number; p: Progress }) {
  return (
    <section className="section epic-progress" aria-labelledby={`prog-h-${id}`}>
      <div className="section-head">
        <h3 id={`prog-h-${id}`}>Прогресс</h3>
        <span className="spacer" />
        <span className="progress-text">{p.total ? <><b>{p.done} из {p.total}</b> готово</> : "Нет задач"}</span>
      </div>
      <div className="progress progress-panel"><Track p={p} label="Прогресс эпика" /></div>
    </section>
  );
}

function useOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); } };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); };
  }, [ref, onClose]);
}

const norm = (s: string) => s.toLocaleLowerCase("ru").trim();

/** Move focus between buttons of a popover list with ↑/↓ (the search field stays reachable). */
function arrowNav(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const root = e.currentTarget;
  const items = Array.from(root.querySelectorAll<HTMLElement>("input, .ep-item"));
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
  if (next) { e.preventDefault(); next.focus(); }
}

/** Epics grouped: the task's own projects first, then «Другие проекты». */
function groupEpics(epics: EpicSummary[], ownTags: Tag[], q: string) {
  const own = new Set(ownTags.map((t) => t.id));
  const list = epics.filter((e) => !q || norm(e.title).includes(norm(q)));
  const mine = list.filter((e) => e.tags.some((t) => own.has(t.id)));
  const rest = list.filter((e) => !mine.includes(e));
  const groupName = ownTags.length ? ownTags.map((t) => t.name).join(", ") : "";
  return { mine, rest, groupName, empty: !list.length };
}

/** Picker for a task's epic: search, own project first, current ticked, «Без эпика», «+ Создать эпик…». */
export function EpicPicker({
  epics, current, ownTags, onPick, onCreate, onClose,
}: {
  epics: EpicSummary[]; current: number | null; ownTags: Tag[];
  onPick: (id: number | null) => void; onCreate: (title: string) => Promise<void>; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  useOutside(ref, onClose);
  useEffect(() => { input.current?.focus(); }, []);
  const g = useMemo(() => groupEpics(epics, ownTags, creating ? "" : q), [epics, ownTags, q, creating]);
  const create = async () => {
    const t = q.trim();
    if (!t || busy) return;
    setBusy(true);
    try { await onCreate(t); } finally { setBusy(false); }
  };
  const item = (e: EpicSummary, other: boolean) => (
    <button key={e.id} type="button" className="ep-item" aria-pressed={current === e.id} onClick={() => onPick(e.id)}>
      <Diamond className="ink" />
      <span className="ep-name">{e.title}</span>
      {other && e.tags[0] ? (
        <span className="ep-meta"><span className={`tag-dot tag-${e.tags[0].color}`} aria-hidden="true" />{e.tags[0].name}</span>
      ) : (
        <span className="ep-meta">{progressText(e.progress, false)}</span>
      )}
      {current === e.id ? <span className="ep-check"><Check size={14} /></span> : <span className="ep-check" aria-hidden="true" />}
    </button>
  );
  return (
    <div ref={ref} className="popover epic-picker" role="dialog" aria-label="Выбор эпика" onKeyDown={arrowNav}>
      <label className="sr-only" htmlFor="epic-q">{creating ? "Название нового эпика" : "Найти эпик"}</label>
      <div className="ep-search">
        {creating ? <Diamond filled className="ink" /> : <Search size={14} />}
        <input
          id="epic-q" ref={input} type="search" autoComplete="off" maxLength={500}
          placeholder={creating ? "Название нового эпика…" : "Найти эпик…"} value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (creating) void create();
              else if (g.mine.length + g.rest.length === 1) onPick((g.mine[0] ?? g.rest[0]).id);
            }
          }}
        />
      </div>
      {creating ? (
        <div className="ep-create-foot">
          <span className="muted small">Эпик получит теги задачи, задача войдёт в него</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setCreating(false); setQ(""); input.current?.focus(); }}>Отмена</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!q.trim() || busy} onClick={() => void create()}>Создать</button>
        </div>
      ) : (
        <>
          <div className="ep-list">
            {g.mine.length > 0 && <p className="ep-group">{g.groupName}</p>}
            {g.mine.map((e) => item(e, false))}
            {g.rest.length > 0 && <p className="ep-group">{g.mine.length ? "Другие проекты" : "Все эпики"}</p>}
            {g.rest.map((e) => item(e, true))}
            {g.empty && <p className="ep-empty">{epics.length ? "Ничего не найдено" : "Эпиков пока нет"}</p>}
          </div>
          <div className="ep-sep" />
          {current !== null && (
            <button type="button" className="ep-item" onClick={() => onPick(null)}><NoneIcon /><span className="ep-name">Без эпика</span></button>
          )}
          <button type="button" className="ep-item ep-create" onClick={() => { if (q.trim()) void create(); else { setCreating(true); input.current?.focus(); } }}>
            <Plus size={14} /><span className="ep-name">{q.trim() ? `Создать эпик «${q.trim()}»` : "Создать эпик…"}</span>
          </button>
        </>
      )}
    </div>
  );
}

/** «Эпик» row in the task properties: link to the parent + «Изменить», or «+ эпик». */
export function EpicField({
  task, epics, onOpen, onChange, onError,
}: {
  task: TaskDetail; epics: EpicSummary[]; onOpen: (id: number) => void;
  onChange: (epicId: number | null) => Promise<void>; onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const cur = task.epic ? epics.find((e) => e.id === task.epic!.id) : undefined;
  const close = () => { setOpen(false); setTimeout(() => btn.current?.focus(), 0); };
  return (
    <>
      {task.epic && (
        <a
          className="epic-chip" href={`/t/${task.epic.id}`}
          onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); onOpen(task.epic!.id); }}
        >
          <Diamond />
          <span className="epic-chip-name">{task.epic.title}</span>
          {cur && <><span aria-hidden="true" className="muted">·</span><span className="muted">{progressText(cur.progress, false)}</span></>}
        </a>
      )}
      {task.epic ? (
        <button ref={btn} type="button" className="epic-change" aria-haspopup="dialog" aria-expanded={open} aria-label="Изменить эпик" onClick={() => setOpen((o) => !o)}>Изменить</button>
      ) : (
        <button ref={btn} type="button" className="add-tag" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Plus size={12} /> эпик</button>
      )}
      {open && (
        <EpicPicker
          epics={epics} current={task.epic?.id ?? null} ownTags={task.tags}
          onClose={close}
          onPick={async (id) => { close(); if (id !== (task.epic?.id ?? null)) await onChange(id); }}
          onCreate={async (title) => {
            try {
              const e = await api.createTask({ title, kind: "epic", status: "inbox", tag_ids: task.tags.map((t) => t.id) });
              close();
              await onChange(e.id);
            } catch (x) {
              onError(x instanceof ApiError ? x.message : "Не удалось создать эпик");
            }
          }}
        />
      )}
    </>
  );
}

/** «Задачи эпика»: children with status, «+ Новая задача в эпике», «Привязать существующую…». */
export function EpicChildren({
  epic, statuses, onOpen, onChanged, onError,
}: {
  epic: TaskDetail; statuses: { id: Status; label: string }[]; onOpen: (id: number) => void; onChanged: () => void; onError: (m: string) => void;
}) {
  const children = epic.children ?? [];
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [attach, setAttach] = useState(false);
  const label = (s: Status) => s === "done_final" ? FINAL_DONE_LABEL : statuses.find((x) => x.id === s)?.label ?? s;
  const addRef = useRef<HTMLTextAreaElement>(null);
  const attachBtn = useRef<HTMLButtonElement>(null);
  const add = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await api.createTask({ title: t, status: "inbox", epic_id: epic.id, tag_ids: epic.tags.map((x) => x.id) });
      setTitle("");
      onChanged();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "Не удалось создать задачу");
    } finally {
      setBusy(false);
      addRef.current?.focus();
    }
  };
  return (
    <section className="section" aria-labelledby={`kids-h-${epic.id}`}>
      <div className="section-head">
        <h3 id={`kids-h-${epic.id}`}>Задачи эпика <span className="sub" style={{ fontWeight: 400 }}>{children.length || ""}</span></h3>
      </div>
      <div className="kids">
        {children.length > 0 ? (
          <ul className="kids-list">
            {children.map((c) => (
              <li key={c.id}>
                <a className="kid" href={`/t/${c.id}`} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); onOpen(c.id); }}>
                  <span className="kid-num mono">#{c.id}</span>
                  <span className="kid-title">{c.title}</span>
                  <span className="kid-status"><span className="dot" aria-hidden="true" style={{ background: STATUS_DOT[c.status] }} />{label(c.status)}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="kids-empty">В эпике пока нет задач</p>
        )}
        {adding && (
          <div className="kids-add">
            <label htmlFor={`kid-new-${epic.id}`} className="sr-only">Название новой задачи эпика</label>
            <textarea
              id={`kid-new-${epic.id}`} ref={addRef} autoFocus rows={1} maxLength={500} placeholder="Название задачи…" value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void add(); }
                if (e.key === "Escape") { e.stopPropagation(); setAdding(false); setTitle(""); }
              }}
            />
            <span className="hint">Enter — создать, Esc — отмена</span>
          </div>
        )}
        <div className="kids-foot">
          <button type="button" className="btn btn-sm" onClick={() => { setAdding(true); setTimeout(() => addRef.current?.focus(), 0); }}><Plus size={14} />Новая задача в эпике</button>
          <button ref={attachBtn} type="button" className="btn btn-sm btn-quiet" aria-haspopup="dialog" aria-expanded={attach} onClick={() => setAttach((a) => !a)}><LinkIcon />Привязать существующую…</button>
        </div>
        {attach && (
          <AttachPopover
            epic={epic}
            onClose={() => { setAttach(false); setTimeout(() => attachBtn.current?.focus(), 0); }}
            onAttach={async (t) => {
              try {
                await api.updateTask(t.id, { epic_id: epic.id });
                onChanged();
              } catch (e) {
                onError(e instanceof ApiError ? e.message : "Не удалось привязать задачу");
              }
            }}
          />
        )}
      </div>
    </section>
  );
}

/** Search ordinary tasks (not epics, not already in this epic) and attach them. Tasks of another epic are moved. */
function AttachPopover({ epic, onAttach, onClose }: { epic: TaskDetail; onAttach: (t: TaskSummary) => Promise<void>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [all, setAll] = useState<TaskSummary[] | null>(null);
  const [err, setErr] = useState("");
  useOutside(ref, onClose);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api.board([], q).then((b) => { if (alive) { setAll(b.tasks); setErr(""); } }).catch(() => alive && setErr("Не удалось загрузить задачи"));
    }, q ? 200 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);
  const list = (all ?? []).filter((t) => t.kind === "task" && t.epic_id !== epic.id).slice(0, 50);
  return (
    <div ref={ref} className="popover epic-picker attach-pop" role="dialog" aria-label="Привязать задачу к эпику" onKeyDown={arrowNav}>
      <label className="sr-only" htmlFor={`attach-q-${epic.id}`}>Найти задачу</label>
      <div className="ep-search">
        <Search size={14} />
        <input id={`attach-q-${epic.id}`} type="search" autoFocus autoComplete="off" placeholder="Найти задачу…" value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="ep-list">
        {err && <p className="ep-empty">{err}</p>}
        {!all && !err && <p className="ep-empty">Загрузка…</p>}
        {all && !list.length && <p className="ep-empty">{q ? "Ничего не найдено" : "Нет задач для привязки"}</p>}
        {list.map((t) => (
          <button key={t.id} type="button" className="ep-item" onClick={() => void onAttach(t)}>
            <span className="kid-num mono">#{t.id}</span>
            <span className="ep-name">{t.title}</span>
            <span className="ep-meta">{t.epic ? <>из «{t.epic.title}»</> : t.tags[0] ? <><span className={`tag-dot tag-${t.tags[0].color}`} aria-hidden="true" />{t.tags[0].name}</> : null}</span>
          </button>
        ))}
      </div>
      <div className="ep-sep" />
      <button type="button" className="ep-item" onClick={onClose}><Close size={14} /><span className="ep-name">Готово</span></button>
    </div>
  );
}

/** Board filter by one epic: «◇ Эпик: все ▾» → popover; active: «◆ Имя ×». */
export function EpicFilterButton({
  epics, active, missingId, open, onToggle,
}: { epics: EpicSummary[]; active: EpicSummary | undefined; missingId: number | null; open: boolean; onToggle: () => void }) {
  void epics;
  if (active || missingId) {
    const name = active ? active.title : `#${missingId}`;
    return (
      <button type="button" className="epic-filter on" aria-haspopup="dialog" aria-expanded={open} onClick={onToggle} title={`Эпик: ${name}`}>
        <Diamond filled />
        <span className="epic-filter-name">{name}</span>
      </button>
    );
  }
  return (
    <button type="button" className="epic-filter" aria-haspopup="dialog" aria-expanded={open} onClick={onToggle}>
      <Diamond />
      <span>Эпик<span className="epic-filter-all">: все</span></span>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="chev"><path d="M4 6l4 4 4-4" /></svg>
    </button>
  );
}

export function EpicFilterPopover({
  epics, active, onPick, onClose, onCreate,
}: { epics: EpicSummary[]; active: number | null; onPick: (id: number | null) => void; onClose: () => void; onCreate: (title: string) => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  useOutside(ref, onClose);
  const list = epics.filter((e) => !q || norm(e.title).includes(norm(q)));
  // group by the first project tag, epics without tags last
  const groups = new Map<string, EpicSummary[]>();
  for (const e of creating ? [] : list) {
    const k = e.tags[0]?.name ?? "Без проекта";
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return (
    <div ref={ref} className="popover epic-picker epic-filter-pop" role="dialog" aria-label="Фильтр по эпику" onKeyDown={arrowNav}>
      <label className="sr-only" htmlFor="epic-filter-q">{creating ? "Название нового эпика" : "Найти эпик"}</label>
      <div className="ep-search">
        {creating ? <Diamond filled className="ink" /> : <Search size={14} />}
        <input
          id="epic-filter-q" type="search" autoFocus autoComplete="off" maxLength={500} placeholder={creating ? "Название нового эпика…" : "Найти эпик…"} value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (creating && q.trim()) void onCreate(q.trim());
              else if (!creating && list.length === 1) onPick(list[0].id);
            }
          }}
        />
      </div>
      {creating ? (
        <div className="ep-create-foot">
          <span className="muted small">Эпик появится во «Входящих»</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setCreating(false); setQ(""); }}>Отмена</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!q.trim()} onClick={() => void onCreate(q.trim())}>Создать</button>
        </div>
      ) : (
        <>
          <div className="ep-list">
            <button type="button" className="ep-item" aria-pressed={active === null} onClick={() => onPick(null)}>
              <span className="ep-name">Все задачи</span>
              {active === null ? <span className="ep-check"><Check size={14} /></span> : <span className="ep-check" aria-hidden="true" />}
            </button>
            {[...groups.entries()].map(([g, es]) => (
              <div key={g} role="group" aria-label={g}>
                <p className="ep-group">{g}</p>
                {es.map((e) => (
                  <button key={e.id} type="button" className="ep-item" aria-pressed={active === e.id} onClick={() => onPick(e.id)}>
                    <Diamond className="ink" />
                    <span className="ep-name">{e.title}</span>
                    <span className="ep-meta">{progressText(e.progress, false)}</span>
                    {active === e.id ? <span className="ep-check"><Check size={14} /></span> : <span className="ep-check" aria-hidden="true" />}
                  </button>
                ))}
              </div>
            ))}
            {!list.length && <p className="ep-empty">{epics.length ? "Ничего не найдено" : "Эпиков пока нет"}</p>}
          </div>
          <div className="ep-sep" />
          <button type="button" className="ep-item ep-create" onClick={() => (q.trim() ? void onCreate(q.trim()) : setCreating(true))}>
            <Plus size={14} /><span className="ep-name">{q.trim() ? `Создать эпик «${q.trim()}»` : "Создать эпик…"}</span>
          </button>
        </>
      )}
    </div>
  );
}
