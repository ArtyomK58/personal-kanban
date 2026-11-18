import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, ApiError, drafts, FINAL_DONE_LABEL, fmtTime, isOverdue, type Board, type EpicSummary, type Status, type Tag, type TaskDetail } from "./api";
import { EpicChildren, EpicField, EpicLinkRow, EpicProgressSection } from "./epics";
import { PriorityField } from "./priority";
import { Calendar, Close, Pencil, Plus, Snowflake, Trash } from "./icons";
import { TagPicker, TagPill } from "./tags";
import { useLive } from "./live";

export function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noopener noreferrer" /> }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export function useTask(id: number) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const linked = useRef(false); // an epic (progress/children) or a task with an epic (parent progress) follows other tasks' changes
  const load = useCallback(async () => {
    try {
      setTask(await api.task(id));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? "Задача не найдена — возможно, её удалили." : "Не удалось загрузить задачу");
    }
  }, [id]);
  useEffect(() => {
    setTask(null);
    void load();
  }, [load]);
  linked.current = !!task && (task.kind === "epic" || !!task.epic);
  useLive((e) => {
    if (!e || e.taskId === id || e.kind === "tag" || (e.kind === "task" && (!e.taskId || linked.current))) void load();
  });
  return { task, setTask, error, reload: load };
}

export function TaskView({
  task, setTask, statuses, tags, epics, variant, onDeleted, onOpen, reload,
}: {
  task: TaskDetail; setTask: (t: TaskDetail) => void; statuses: Board["statuses"]; tags: Tag[]; epics: EpicSummary[];
  variant: "panel" | "page"; onDeleted: () => void; onOpen: (id: number) => void; reload: () => void;
}) {
  const isEpic = task.kind === "epic";
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [picker, setPicker] = useState(false);
  const [err, setErr] = useState("");
  const [changingFreeze, setChangingFreeze] = useState(false);
  const allTags = tags;

  const patch = async (b: Parameters<typeof api.updateTask>[1]) => {
    try {
      setTask(await api.updateTask(task.id, b));
      setErr("");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Не удалось сохранить");
    }
  };

  const saveTitle = async () => {
    setEditingTitle(false);
    const t = titleDraft.trim();
    if (t && t !== task.title) await patch({ title: t });
    else setTitleDraft(task.title);
  };

  const props = (
    <dl className="props">
      <dt><label htmlFor={`st-${variant}`}>Статус</label></dt>
      <dd>
        <select id={`st-${variant}`} className="select" value={task.status} onChange={(e) => patch({ status: e.target.value as Status })}>
          {task.status === "done_final" && <option value="done_final" disabled>{FINAL_DONE_LABEL}</option>}
          {statuses.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </dd>
      <dt id={`prio-l-${variant}`}>Приоритет</dt>
      <dd>
        <PriorityField id={`prio-l-${variant}`} value={task.priority ?? "normal"} onChange={(p) => patch({ priority: p })} />
      </dd>
      <dt>Заморозка</dt>
      <dd>
        <button type="button" className={`btn btn-sm${task.frozen ? " frozen-mark" : ""}`} disabled={changingFreeze}
          onClick={async () => {
            setChangingFreeze(true);
            try { await patch({ frozen: !task.frozen }); }
            finally { setChangingFreeze(false); }
          }}>
          <Snowflake />{task.frozen ? "Разморозить" : "Заморозить"}
        </button>
      </dd>
      <dt>Теги</dt>
      <dd style={{ position: "relative" }}>
        {task.tags.map((t) => (
          <TagPill key={t.id} tag={t} onRemove={() => patch({ tag_ids: task.tags.filter((x) => x.id !== t.id).map((x) => x.id) })} />
        ))}
        <button type="button" className="add-tag" onClick={() => setPicker(true)} aria-haspopup="dialog" aria-expanded={picker}>
          <Plus size={12} /> добавить
        </button>
        {picker && (
          <TagPicker
            all={allTags}
            selected={task.tags.map((t) => t.id)}
            style={{ top: 34, left: 0 }}
            onClose={() => setPicker(false)}
            onToggle={(t) => {
              const ids = task.tags.map((x) => x.id);
              void patch({ tag_ids: ids.includes(t.id) ? ids.filter((x) => x !== t.id) : [...ids, t.id] });
            }}
            onCreate={async (name) => {
              try {
                const t = await api.createTag(name);
                await patch({ tag_ids: [...task.tags.map((x) => x.id), t.id] });
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : "Не удалось создать тег");
              }
            }}
          />
        )}
      </dd>
      {!isEpic && (
        <>
          <dt>Эпик</dt>
          <dd style={{ position: "relative" }} className="epic-dd">
            <EpicField task={task} epics={epics} onOpen={onOpen} onChange={(epicId) => patch({ epic_id: epicId })} onError={setErr} />
          </dd>
        </>
      )}
      <dt>Срок</dt>
      <dd>
        <DateField id={`due-${variant}`} value={task.due_date} overdue={isOverdue(task.due_date, task.status)} onChange={(v) => patch({ due_date: v })} />
      </dd>
    </dl>
  );
  const progress = isEpic && <EpicProgressSection id={task.id} p={task.progress ?? { done: 0, total: 0 }} />;

  const main = (
    <div className={`task${isEpic ? " is-epic" : ""}`}>
      {task.epic && <EpicLinkRow epic={task.epic} onOpen={onOpen} className="epic-link epic-link-panel" />}
      {variant === "page" && isEpic && <div className="epic-label page-epic-label"><EpicMark />ЭПИК</div>}
      {editingTitle ? (
        <textarea
          className="title-input" autoFocus rows={1} value={titleDraft} maxLength={500} aria-label="Название задачи"
          onChange={(e) => setTitleDraft(e.target.value)} onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
            if (e.key === "Escape") { e.stopPropagation(); setTitleDraft(task.title); setEditingTitle(false); }
          }}
        />
      ) : (
        <h1 className="task-title" tabIndex={0} title="Нажмите, чтобы изменить"
          onClick={() => { setTitleDraft(task.title); setEditingTitle(true); }}
          onKeyDown={(e) => { if (e.key === "Enter") { setTitleDraft(task.title); setEditingTitle(true); } }}>
          {task.title}
        </h1>
      )}
      {variant === "panel" && props}
      {err && <div className="field-error" role="alert">{err}</div>}
      {progress}
      <Description task={task} onSave={(text) => patch({ human_description: text })} />
      {isEpic && <EpicChildren epic={task} statuses={statuses} onOpen={onOpen} onChanged={reload} onError={setErr} />}
      <Comments task={task} onAdded={(c) => setTask({ ...task, comments: [...task.comments, c], comment_count: task.comment_count + 1 })} />
      {variant === "panel" && <Actions task={task} onDeleted={onDeleted} onKind={(k) => patch({ kind: k })} />}
    </div>
  );

  if (variant === "panel") return main;
  return (
    <>
      {main}
      <aside className="page-side" aria-label="Свойства задачи">
        {props}
        <div className="meta">
          Создана {fmtTime(task.created_at)}<br />Обновлена {fmtTime(task.updated_at)}
        </div>
        <Actions task={task} onDeleted={onDeleted} onKind={(k) => patch({ kind: k })} />
      </aside>
    </>
  );
}

const EpicMark = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M6 1.5 10.5 6 6 10.5 1.5 6z" /></svg>
);

/** Kind switch (with the rule explained when it is impossible) and delete. */
function Actions({ task, onDeleted, onKind }: { task: TaskDetail; onDeleted: () => void; onKind: (k: "task" | "epic") => void }) {
  const isEpic = task.kind === "epic";
  const blocked = isEpic ? (task.children?.length ?? 0) > 0 : !!task.epic;
  const why = isEpic ? "Сначала отвяжите задачи эпика" : "Задача входит в эпик — сначала уберите эпик";
  return (
    <div className="task-actions">
      <button
        type="button" className="btn btn-sm btn-ghost" disabled={blocked} title={blocked ? why : undefined}
        aria-describedby={blocked ? `kind-why-${task.id}` : undefined}
        onClick={() => onKind(isEpic ? "task" : "epic")}
      >
        {isEpic ? "Сделать обычной задачей" : <><EpicMark /> Сделать эпиком</>}
      </button>
      {blocked && <span id={`kind-why-${task.id}`} className="sr-only">{why}</span>}
      <DeleteButton id={task.id} isEpic={isEpic} onDeleted={onDeleted} />
    </div>
  );
}

function DeleteButton({ id, isEpic, onDeleted }: { id: number; isEpic: boolean; onDeleted: () => void }) {
  return (
    <div>
      <button
        type="button" className="btn btn-sm btn-ghost btn-danger"
        onClick={async () => {
          const msg = isEpic
            ? `Удалить эпик #${id}? Его задачи останутся на доске без эпика. Это действие нельзя отменить.`
            : `Удалить задачу #${id}? Это действие нельзя отменить.`;
          if (!window.confirm(msg)) return;
          await api.deleteTask(id);
          drafts.del(`desc:${id}`);
          drafts.del(`comment:${id}`);
          onDeleted();
        }}
      >
        <Trash size={14} /> {isEpic ? "Удалить эпик" : "Удалить задачу"}
      </button>
    </div>
  );
}

function Description({ task, onSave }: { task: TaskDetail; onSave: (text: string) => Promise<void> }) {
  const key = `desc:${task.id}`;
  const stored = drafts.get(key);
  const [editing, setEditing] = useState(stored !== null && stored !== task.human_description);
  const [text, setText] = useState(stored ?? task.human_description);
  const [restored] = useState(stored !== null && stored !== task.human_description);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setText(task.human_description);
  }, [task.human_description, editing]);

  const start = () => {
    setText(drafts.get(key) ?? task.human_description);
    setEditing(true);
    setTimeout(() => ref.current?.focus(), 0);
  };
  const cancel = () => {
    drafts.del(key);
    setText(task.human_description);
    setEditing(false);
  };
  const save = async () => {
    setSaving(true);
    try {
      await onSave(text);
      drafts.del(key);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="section" aria-labelledby={`desc-h-${task.id}`}>
      <div className="section-head">
        <h3 id={`desc-h-${task.id}`}>Описание</h3>
        <span className="spacer" />
        {!editing && task.human_description && (
          <button type="button" className="btn btn-sm" onClick={start}><Pencil size={14} /> Изменить</button>
        )}
      </div>
      {editing ? (
        <>
          {restored && <div className="draft-banner">Восстановлен несохранённый черновик описания.</div>}
          <label htmlFor={`desc-${task.id}`} className="sr-only">Описание в Markdown</label>
          <textarea
            id={`desc-${task.id}`} ref={ref} className="editor" value={text} autoFocus
            placeholder="Markdown: ## заголовки, - списки, - [ ] чекбоксы, `код`"
            onChange={(e) => { setText(e.target.value); drafts.set(key, e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.stopPropagation(); if (text === task.human_description) cancel(); }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
            }}
          />
          <div className="editor-foot">
            <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={save}>Сохранить</button>
            <button type="button" className="btn btn-sm" onClick={cancel}>Отмена</button>
            <span className="note">{text !== task.human_description ? "Черновик сохранён локально · ⌘/Ctrl+Enter — сохранить" : "Markdown"}</span>
          </div>
        </>
      ) : task.human_description ? (
        <div className="desc-view" onDoubleClick={start}><Md text={task.human_description} /></div>
      ) : (
        <button type="button" className="desc-empty" onClick={start}>Добавить описание…</button>
      )}
    </section>
  );
}

function Comments({ task, onAdded }: { task: TaskDetail; onAdded: (c: TaskDetail["comments"][number]) => void }) {
  const key = `comment:${task.id}`;
  const [body, setBody] = useState(() => drafts.get(key) ?? "");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      onAdded(await api.comment(task.id, body));
      setBody("");
      drafts.del(key);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="section comments-section" aria-labelledby={`com-h-${task.id}`}>
      <div className="section-head">
        <h3 id={`com-h-${task.id}`}>Комментарии <span className="sub" style={{ fontWeight: 400 }}>{task.comments.length || ""}</span></h3>
      </div>
      {task.comments.length > 0 && (
        <ol className="comments" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {task.comments.map((c) => (
            <li key={c.id} className="comment">
              <div className="comment-head">
                <span className="author">{c.author}</span>
                {c.author_kind === "agent" && <span className="agent-badge">агент</span>}
                <time dateTime={c.created_at}>{fmtTime(c.created_at)}</time>
              </div>
              <Md text={c.body} />
            </li>
          ))}
        </ol>
      )}
      <div className="composer">
        <label htmlFor={`cm-${task.id}`} className="sr-only">Новый комментарий</label>
        <textarea
          id={`cm-${task.id}`} placeholder="Написать комментарий…" value={body}
          onChange={(e) => { setBody(e.target.value); if (e.target.value) drafts.set(key, e.target.value); else drafts.del(key); }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
        />
        <div className="foot">
          <span className="note">{body ? "Черновик сохраняется · ⌘/Ctrl+Enter" : ""}</span>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || !body.trim()} onClick={send}>Отправить</button>
        </div>
      </div>
    </section>
  );
}

const LONG_MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
function fmtLong(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return `${day} ${LONG_MONTHS[m - 1]}${y !== new Date().getFullYear() ? " " + y : ""}`;
}

/** Shows the date as text («18 ноября»); the native picker appears only while editing. */
function DateField({ id, value, overdue, onChange }: { id: string; value: string | null; overdue: boolean; onChange: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        id={id} type="date" className="date" autoFocus defaultValue={value ?? ""} aria-label="Срок"
        onBlur={(e) => { setEditing(false); const v = e.target.value || null; if (v !== value) onChange(v); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { e.stopPropagation(); setEditing(false); } }}
      />
    );
  }
  if (!value) {
    return <button id={id} type="button" className="date-btn empty" onClick={() => setEditing(true)}><Plus size={12} /> срок</button>;
  }
  return (
    <>
      <button id={id} type="button" className={`date-btn${overdue ? " overdue" : ""}`} aria-label={`Срок: ${fmtLong(value)}, изменить`} onClick={() => setEditing(true)}>
        <Calendar />{fmtLong(value)}
      </button>
      <button type="button" className="icon-btn ghost sm" aria-label="Убрать срок" onClick={() => onChange(null)}><Close size={14} /></button>
    </>
  );
}
