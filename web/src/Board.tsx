import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, closestCorners, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api, ApiError, fmtDue, isOverdue, type Board as BoardData, type BoardStatus, type EpicSummary, type Tag, type TaskSummary } from "./api";
import { Diamond, EpicFilterButton, EpicFilterPopover, EpicLinkRow } from "./epics";
import { PriorityBadge } from "./priority";
import { boardMovePlacement, sortTaskIdsForBoard } from "./board-order";
import { epicCardTints } from "./epic-colors";
import { CopyTaskLink } from "./CopyTaskLink";
import { Calendar, CommentIcon, Lines, Logo, More, Plus, Search, Check, Close, Snowflake } from "./icons";
import { useLive } from "./live";
import { NewTagPopover, TagPill } from "./tags";
import { TaskPanel } from "./TaskPanel";

const FILTER_KEY = "kanban:filters";
type Columns = Record<BoardStatus, number[]>;

export function useBoardFilters() {
  const [params, setParams] = useSearchParams();
  const tags = useMemo(() => (params.get("tags") ?? "").split(",").map((s) => s.trim()).filter(Boolean), [params]);
  const q = params.get("q") ?? "";
  const epicN = Number(params.get("epic"));
  const epic = Number.isInteger(epicN) && epicN > 0 ? epicN : null;
  // Always start from the CURRENT URL: a delayed call (the search debounce) must not undo a tag/epic click made meanwhile.
  const update = (next: { tags?: string[]; q?: string; epic?: number | null }) => {
    const p = new URLSearchParams(window.location.search);
    const curTags = (p.get("tags") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const curEpic = Number(p.get("epic")) || null;
    const t = next.tags ?? curTags;
    const qq = next.q ?? p.get("q") ?? "";
    const ep = next.epic !== undefined ? next.epic : curEpic;
    if (t.length) p.set("tags", t.join(",")); else p.delete("tags");
    if (qq) p.set("q", qq); else p.delete("q");
    if (ep) p.set("epic", String(ep)); else p.delete("epic");
    setParams(p, { replace: true, state: window.history.state?.usr });
    try { localStorage.setItem(FILTER_KEY, JSON.stringify({ tags: t, q: qq, epic: ep })); } catch { /* ignore */ }
  };
  return { tags, q, epic, update, params, setParams };
}

export default function Board({ onLogout }: { onLogout: () => void }) {
  const { tags: activeTags, q, epic: epicFilter, update, params, setParams } = useBoardFilters();
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState("");
  const [cols, setCols] = useState<Columns>({ inbox: [], in_progress: [], review: [], done: [] });
  const [activeId, setActiveId] = useState<number | null>(null);
  const [quick, setQuick] = useState<BoardStatus | null>(null);
  const [newTag, setNewTag] = useState(false);
  const [epicPop, setEpicPop] = useState(false);
  const epicBtnRef = useRef<HTMLDivElement>(null);
  const [epicPopPos, setEpicPopPos] = useState<React.CSSProperties>({});
  // The popover is fixed-positioned under the button (the filter row scrolls horizontally on phones and would clip it).
  useEffect(() => {
    if (!epicPop) return;
    const place = () => {
      const r = epicBtnRef.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(320, window.innerWidth - 32);
      setEpicPopPos({ top: r.bottom + 6, left: Math.max(16, Math.min(r.right - w, window.innerWidth - w - 16)), width: w });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [epicPop]);
  const [menu, setMenu] = useState(false);
  const [qInput, setQInput] = useState(q);
  const searchRef = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);
  const openTaskId = Number(params.get("task")) || null;

  // restore remembered filters when the URL has none (e.g. opening the bookmark "/")
  useEffect(() => {
    if (!params.has("tags") && !params.has("q") && !params.has("epic")) {
      try {
        const s = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null");
        if (s && (s.tags?.length || s.q || s.epic)) { update({ tags: s.tags ?? [], q: s.q ?? "", epic: Number(s.epic) || null }); setQInput(s.q ?? ""); }
      } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    try {
      const b = await api.board(activeTags, q, epicFilter);
      setData(b);
      if (!dragging.current) {
        const tasks = new Map(b.tasks.map((t) => [t.id, t]));
        const c: Columns = { inbox: [], in_progress: [], review: [], done: [] };
        for (const task of b.tasks) c[task.status].push(task.id);
        for (const status of Object.keys(c) as BoardStatus[]) c[status] = sortTaskIdsForBoard(c[status], tasks);
        setCols(c);
      }
      setError("");
    } catch (e) {
      setError((e as Error).message || "Не удалось загрузить доску");
    }
  }, [activeTags.join(","), q, epicFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [load]);
  useLive(() => { if (!dragging.current) void load(); });

  // debounce search typing into the URL
  useEffect(() => {
    const t = setTimeout(() => { if (qInput !== q) update({ q: qInput }); }, 250);
    return () => clearTimeout(t);
  }, [qInput]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && !el.isContentEditable) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const byId = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data]);
  const epicTints = useMemo(() => epicCardTints(data?.epics ?? []), [data?.epics]);

  const tagByName = useMemo(() => new Map((data?.tags ?? []).map((t) => [t.name.toLocaleLowerCase("ru"), t])), [data]);
  const activeTagObjs = activeTags.map((n) => tagByName.get(n.toLocaleLowerCase("ru"))).filter(Boolean) as Tag[];
  const isActive = (t: Tag) => activeTags.some((n) => n.toLocaleLowerCase("ru") === t.name.toLocaleLowerCase("ru"));
  const toggleTag = (t: Tag) => update({ tags: isActive(t) ? activeTags.filter((n) => n.toLocaleLowerCase("ru") !== t.name.toLocaleLowerCase("ru")) : [...activeTags, t.name] });
  const filtered = activeTags.length > 0 || !!q || !!epicFilter;
  const activeEpic: EpicSummary | undefined = epicFilter ? data?.epics.find((e) => e.id === epicFilter) : undefined;
  const resetAll = () => { update({ tags: [], q: "", epic: null }); setQInput(""); };

  const openTask = (id: number) => {
    const p = new URLSearchParams(params);
    p.set("task", String(id));
    // Switching between tasks while the panel is open replaces the entry, so «Back»/close returns to the board.
    const panelPushed = (location.state as { panel?: boolean } | null)?.panel;
    navigate({ search: p.toString() }, { state: { panel: openTaskId ? !!panelPushed : true }, replace: !!openTaskId });
  };
  const closeTask = () => {
    if ((location.state as { panel?: boolean } | null)?.panel) navigate(-1);
    else {
      const p = new URLSearchParams(params);
      p.delete("task");
      setParams(p, { replace: true });
    }
  };

  // ───────── drag & drop ─────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
  );
  const findCol = (id: number | string): BoardStatus | undefined => {
    if (typeof id === "string" && id.startsWith("col:")) return id.slice(4) as BoardStatus;
    return (Object.keys(cols) as BoardStatus[]).find((s) => cols[s].includes(Number(id)));
  };
  const onDragStart = (e: DragStartEvent) => {
    dragging.current = true;
    setActiveId(Number(e.active.id));
  };
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const from = findCol(active.id);
    const to = findCol(over.id);
    if (!from || !to || from === to) return;
    setCols((c) => {
      const a = Number(active.id);
      const target = c[to].filter((x) => x !== a);
      const overIdx = typeof over.id === "string" ? target.length : target.indexOf(Number(over.id));
      target.splice(overIdx < 0 ? target.length : overIdx, 0, a);
      return { ...c, [from]: c[from].filter((x) => x !== a), [to]: sortTaskIdsForBoard(target, byId) };
    });
  };
  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    const a = Number(active.id);
    setActiveId(null);
    const to = over ? findCol(over.id) : undefined;
    if (!over || !to) {
      dragging.current = false;
      void load();
      return;
    }
    let list = cols[to];
    if (typeof over.id === "number" && over.id !== a) {
      const oi = list.indexOf(over.id);
      const ai = list.indexOf(a);
      if (oi >= 0 && ai >= 0) list = arrayMove(list, ai, oi);
    }
    list = sortTaskIdsForBoard(list, byId);
    setCols((c) => ({ ...c, [to]: list }));
    const orig = byId.get(a);
    const unchanged = orig && orig.status === to && (() => {
      const prev = sortTaskIdsForBoard((data?.tasks ?? []).filter((t) => t.status === to).map((t) => t.id), byId);
      return prev.join() === list.join();
    })();
    try {
      if (!unchanged) {
        await api.move(a, { status: to, ...boardMovePlacement(list, a, byId) });
      }
    } finally {
      dragging.current = false;
      void load();
    }
  };

  const total = data?.total ?? 0;
  const shown = data?.tasks.length ?? 0;
  const activeTask = activeId ? byId.get(activeId) : undefined;

  return (
    <div className={`app${openTaskId ? " with-panel" : ""}`}>
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); resetAll(); }}>
          <Logo />Канбан
        </a>
        <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); update({ q: qInput }); }}>
          <label htmlFor="q" className="sr-only">Поиск</label>
          <Search />
          <input
            id="q" ref={searchRef} type="search" autoComplete="off" placeholder="Поиск по названию, описанию, комментариям"
            value={qInput} onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setQInput(""); update({ q: "" }); (e.target as HTMLInputElement).blur(); } }}
          />
          {qInput ? (
            <button type="button" className="clear" aria-label="Очистить поиск" onClick={() => { setQInput(""); update({ q: "" }); }}><Close size={14} /></button>
          ) : (
            <kbd aria-hidden="true">/</kbd>
          )}
        </form>
        <div className="topbar-actions">
          <button type="button" className="btn btn-primary" onClick={() => setQuick("inbox")}><Plus />Новая задача</button>
          <button type="button" className="icon-btn" aria-label="Меню" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><More /></button>
          {menu && (
            <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
              <div className="menu-note">Агенты подключаются через MCP: <span className="mono">/mcp</span></div>
              <button type="button" role="menuitem" onClick={onLogout}>Выйти</button>
            </div>
          )}
        </div>
      </header>

      <div className="filters" role="group" aria-label="Фильтр по проектам" style={{ position: "relative" }}>
        <span className="filters-label">Проекты:</span>
        {(data?.tags ?? []).map((t) => (
          <button key={t.id} type="button" className={`chip tag-${t.color}`} aria-pressed={isActive(t)} onClick={() => toggleTag(t)}>
            <span className="dot" aria-hidden="true" />
            {t.name}
            {isActive(t) && <Check size={14} />}
          </button>
        ))}
        <button type="button" className="chip chip-add" onClick={() => setNewTag(true)} aria-haspopup="dialog"><Plus size={14} />тег</button>
        {newTag && <NewTagPopover style={{ top: 44, left: 24 }} onClose={() => setNewTag(false)} onCreated={() => void load()} />}
        <span className="filters-hint">Несколько тегов — любой из выбранных</span>
        <span className="filters-divider" aria-hidden="true" />
        <div className="epic-filter-wrap" ref={epicBtnRef}>
          <EpicFilterButton epics={data?.epics ?? []} active={activeEpic} missingId={epicFilter && data && !activeEpic ? epicFilter : null} open={epicPop} onToggle={() => setEpicPop((o) => !o)} />
          {epicFilter && (
            <button type="button" className="epic-filter-x" aria-label="Сбросить фильтр по эпику" onClick={() => { update({ epic: null }); setEpicPop(false); }}><Close size={14} /></button>
          )}
        </div>
      </div>
      {epicPop && data && (
        <div className="epic-filter-anchor" style={epicPopPos}>
          <EpicFilterPopover
            epics={data.epics} active={epicFilter}
            onClose={() => setEpicPop(false)}
            onPick={(id) => { update({ epic: id }); setEpicPop(false); }}
            onCreate={async (title) => {
              try {
                const e = await api.createTask({ title, kind: "epic", status: "inbox", tag_ids: activeTagObjs.map((t) => t.id) });
                setEpicPop(false);
                update({ epic: e.id });
              } catch (x) {
                setError(x instanceof ApiError ? x.message : "Не удалось создать эпик");
              }
            }}
          />
        </div>
      )}

      {filtered && data && (
        <div className="active-filter" role="status">
          <span>
            {epicFilter ? <>Показаны задачи эпика <b>«{activeEpic?.title ?? `#${epicFilter}`}»</b></> : "Показаны задачи:"}
            {epicFilter && (activeTagObjs.length > 0 || q) && <span className="sep"> · </span>}
            {!epicFilter && " "}
            {activeTagObjs.length > 0 && activeTagObjs.map((t, i) => (
              <span key={t.id}>{i > 0 && <span className="sep"> или </span>}<b>{t.name}</b></span>
            ))}
            {activeTagObjs.length > 0 && q && <span className="sep"> · </span>}
            {q && <>поиск «<b>{q}</b>»</>}
            {epicFilter && data && !activeEpic && <span className="muted"> — эпик не найден</span>}
          </span>
          <span className="sep" aria-hidden="true">·</span>
          <span className="muted">{shown} из {total}</span>
          <span className="sep" aria-hidden="true">·</span>
          <button type="button" className="link-btn" onClick={resetAll}>Сбросить</button>
        </div>
      )}

      <main className="board-wrap">
        {error && !data && <div className="center-note">{error}</div>}
        {!data && !error && <div className="center-note">Загрузка…</div>}
        {data && (
          <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => { setActiveId(null); dragging.current = false; void load(); }}>
            <div className="board">
              {data.statuses.map((s) => (
                <Column
                  key={s.id} status={s.id} label={s.label} ids={cols[s.id]} byId={byId} filtered={filtered}
                  selectedId={openTaskId} onOpen={openTask} epicTints={epicTints}
                  quick={quick === s.id} onQuick={() => setQuick(s.id)} onQuickClose={() => setQuick(null)}
                  activeTags={activeTagObjs} activeEpic={activeEpic} onCreated={() => void load()}
                />
              ))}
            </div>
            <DragOverlay dropAnimation={{ duration: 160, easing: "cubic-bezier(.2,.8,.2,1)" }}>
              {activeTask ? <CardBody task={activeTask} className="card lifted" epicTints={epicTints} /> : null}
            </DragOverlay>
          </DndContext>
        )}
      </main>
      <button type="button" className="fab" aria-label="Новая задача" onClick={() => { setQuick("inbox"); window.scrollTo({ top: 0 }); document.querySelector(".board-wrap")?.scrollTo({ left: 0, behavior: "smooth" }); }}><Plus size={22} /></button>

      {openTaskId && data && (
        <TaskPanel key={openTaskId} id={openTaskId} statuses={data.statuses} tags={data.tags} epics={data.epics} onOpen={openTask} onClose={closeTask} onChanged={() => void load()} />
      )}
    </div>
  );
}

function Column(p: {
  status: BoardStatus; label: string; ids: number[]; byId: Map<number, TaskSummary>; filtered: boolean; selectedId: number | null;
  epicTints: Map<number, string>;
  onOpen: (id: number) => void; quick: boolean; onQuick: () => void; onQuickClose: () => void; activeTags: Tag[]; activeEpic?: EpicSummary; onCreated: () => void;
}) {
  const { setNodeRef } = useDroppable({ id: `col:${p.status}` });
  const tasks = p.ids.map((id) => p.byId.get(id)).filter(Boolean) as TaskSummary[];
  return (
    <section className="column" aria-label={p.label}>
      <div className="column-head">
        <h2>{p.label}</h2>
        <span className="n">{tasks.length}</span>
        <button type="button" className="icon-btn ghost sm" aria-label={`Добавить задачу в колонку «${p.label}»`} onClick={p.onQuick}><Plus /></button>
      </div>
      {p.quick && <QuickAdd status={p.status} tags={p.activeTags} epic={p.activeEpic} onClose={p.onQuickClose} onCreated={p.onCreated} />}
      <SortableContext id={`col:${p.status}`} items={p.ids} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="column-list">
          {tasks.map((t) => <SortableCard key={t.id} task={t} selected={p.selectedId === t.id} onOpen={p.onOpen} epicTints={p.epicTints} />)}
        </div>
      </SortableContext>
      {!tasks.length && !p.quick && <p className="column-empty">{p.filtered ? "Нет задач по фильтру" : "Пусто"}</p>}
    </section>
  );
}

function SortableCard({ task, selected, onOpen, epicTints }: { task: TaskSummary; selected: boolean; onOpen: (id: number) => void; epicTints: Map<number, string> }) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <CardBody
      ref={setNodeRef}
      task={task}
      epicTints={epicTints}
      className={`card${selected ? " selected" : ""}${isDragging ? " ghost" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      listeners={listeners}
      onOpen={onOpen}
    />
  );
}

function CardBody({
  task, className, style, listeners, onOpen, ref, epicTints,
}: {
  task: TaskSummary; className: string; style?: React.CSSProperties; listeners?: Record<string, unknown>; onOpen?: (id: number) => void; ref?: React.Ref<HTMLElement>;
  epicTints: Map<number, string>;
}) {
  const overdue = isOverdue(task.due_date, task.status);
  const isEpic = task.kind === "epic";
  const groupId = isEpic ? task.id : task.epic_id;
  const tint = groupId ? epicTints.get(groupId) : undefined;
  const cardStyle = { ...style, ...(tint ? { "--card-tint": tint, "--edge-fill": tint } : {}) } as React.CSSProperties;
  const dueEl = task.due_date && (
    <span className={`m due${overdue ? " overdue" : ""}`} title={(overdue ? "Срок прошёл: " : "Срок: ") + fmtDue(task.due_date)}>
      <Calendar />{fmtDue(task.due_date)}
    </span>
  );
  const onClick = (e: React.MouseEvent) => { if ((e.target as HTMLElement).closest("a") && (e.metaKey || e.ctrlKey || e.shiftKey)) return; e.preventDefault(); onOpen?.(task.id); };
  const title = <h3 className="card-title"><a href={`/t/${task.id}`} onClick={(e) => { if (!(e.metaKey || e.ctrlKey || e.shiftKey)) e.preventDefault(); }}>{task.title}</a></h3>;
  return (
    <article
      ref={ref as React.Ref<HTMLElement>} className={`${className}${isEpic ? " epic" : ""}`} style={cardStyle} {...(listeners ?? {})}
      onClick={onClick} aria-label={isEpic ? `Эпик «${task.title}»` : undefined}
    >
      {isEpic ? <div className="epic-heading"><div className="epic-label"><Diamond filled />ЭПИК</div>{title}</div> : <>{task.epic && <EpicLinkRow epic={task.epic} onOpen={onOpen} />}{title}</>}
      {!isEpic && task.tags.length > 0 && <div className="card-tags">{task.tags.map((t) => <TagPill key={t.id} tag={t} />)}</div>}
      <div className="card-meta">
        <span className="mono">#{task.id}</span>
        {isEpic && task.tags.length > 0 && <span className="card-tags epic-meta-tags">{task.tags.map((t) => <TagPill key={t.id} tag={t} />)}</span>}
        {task.frozen && <span className="m frozen-mark" role="img" aria-label="Заморожена" title="Заморожена"><Snowflake /></span>}
        <PriorityBadge p={task.priority} compact={isEpic} />
        {task.comment_count > 0 && <span className="m" title={`Комментариев: ${task.comment_count}`}><CommentIcon />{task.comment_count}</span>}
        {task.has_description && <span className="m" title="Есть описание"><Lines role="img" aria-label="Есть описание" /></span>}
        <span className="card-meta-right">{dueEl}<CopyTaskLink id={task.id} /></span>
      </div>
    </article>
  );
}

function QuickAdd({ status, tags, epic, onClose, onCreated }: { status: BoardStatus; tags: Tag[]; epic?: EpicSummary; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [asEpic, setAsEpic] = useState(false);
  const [err, setErr] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      // In the epic filter a new task joins that epic (and gets its project tags if no tag filter is set).
      const tagIds = tags.length || asEpic || !epic ? tags.map((x) => x.id) : epic.tags.map((x) => x.id);
      await api.createTask({ title: t, status, tag_ids: tagIds, ...(asEpic ? { kind: "epic" as const } : epic ? { epic_id: epic.id } : {}) });
      setTitle("");
      setErr("");
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Не удалось создать");
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };
  return (
    <div className={`quick-add${asEpic ? " as-epic" : ""}`}>
      <label htmlFor={`qa-${status}`} className="sr-only">{asEpic ? "Название нового эпика" : "Название новой задачи"}</label>
      <textarea
        id={`qa-${status}`} ref={ref} rows={2} placeholder={asEpic ? "Название эпика…" : "Название задачи…"} value={title} maxLength={500}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
          if (e.key === "Escape") { e.stopPropagation(); onClose(); }
        }}
        onBlur={(e) => {
          // keep the form while the focus moves to its own «Эпик» toggle
          if ((e.relatedTarget as HTMLElement | null)?.closest(".quick-add")) return;
          if (!title.trim()) setTimeout(onClose, 120);
        }}
      />
      {err && <div className="field-error" role="alert">{err}</div>}
      <div className="qa-foot">
        <button
          type="button" className="qa-kind" aria-pressed={asEpic} title="Создать как эпик"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { setAsEpic((v) => !v); ref.current?.focus(); }}
        ><Diamond filled={asEpic} />Эпик</button>
        {epic && !asEpic && <span className="qa-epic"><Diamond />{epic.title}</span>}
        {tags.map((t) => <TagPill key={t.id} tag={t} />)}
        <span className="hint">Enter — создать, Esc — отмена</span>
      </div>
    </div>
  );
}
