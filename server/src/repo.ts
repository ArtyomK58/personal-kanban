import { EventEmitter } from "node:events";
import { type DB, nowIso } from "./db.js";

export const BOARD_STATUSES = [
  { id: "inbox", label: "Входящие" },
  { id: "in_progress", label: "В работе" },
  { id: "review", label: "На проверке" },
  { id: "done", label: "Готово" },
] as const;
export const FINAL_DONE = { id: "done_final", label: "Готово окончательно", hidden: true, automatic: true } as const;
export const STATUSES = [...BOARD_STATUSES, FINAL_DONE] as const;
export type Status = (typeof STATUSES)[number]["id"];
export const STATUS_IDS = STATUSES.map((s) => s.id) as [Status, ...Status[]];
export const BOARD_STATUS_IDS = BOARD_STATUSES.map((s) => s.id) as [Status, ...Status[]];

export const TAG_COLORS = ["slate", "blue", "teal", "green", "amber", "orange", "rose", "violet"] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export const TASK_KINDS = ["task", "epic"] as const;
export const PRIORITIES = [
  { id: "low", label: "Низкий" },
  { id: "normal", label: "Обычный" },
  { id: "high", label: "Высокий" },
] as const;
export type Priority = (typeof PRIORITIES)[number]["id"];
export const PRIORITY_IDS = PRIORITIES.map((p) => p.id) as [Priority, ...Priority[]];
export function isPriority(p: unknown): p is Priority {
  return typeof p === "string" && (PRIORITY_IDS as string[]).includes(p);
}
export type TaskKind = (typeof TASK_KINDS)[number];

export interface Tag { id: number; name: string; color: TagColor; task_count?: number }
/** Parent epic of a task (null for tasks without an epic and for epics themselves). */
export interface EpicRef { id: number; title: string }
/** Progress of an epic: finished children (including archived) / all children. */
export interface Progress { done: number; total: number }
export interface TaskSummary {
  id: number; title: string; status: Status; position: number; due_date: string | null;
  created_at: string; updated_at: string; tags: Tag[]; comment_count: number; has_description: boolean;
  kind: TaskKind; epic_id: number | null; epic: EpicRef | null; progress: Progress | null; priority: Priority; frozen: boolean;
}
/** What the human UI gets. Never contains agent_notes. Epics also carry their children (summaries). */
export interface TaskDetail extends TaskSummary { human_description: string; comments: Comment[]; children?: TaskSummary[] }
/** Compact epic entry for pickers and filters. */
export interface EpicSummary { id: number; title: string; status: Status; priority: Priority; tags: Tag[]; progress: Progress }
export interface Comment { id: number; task_id: number; author: string; author_kind: "owner" | "agent"; body: string; created_at: string }
export interface AgentNotes { task_id: number; agent_notes: string; agent_notes_updated_at: string | null }

export interface ListFilter {
  tags?: string[];          // tag names (case-insensitive)
  tagMatch?: "any" | "all"; // semantics for several tags; UI always uses "any"
  status?: Status | Status[];
  query?: string;           // full text over title, human description, comments
  kind?: TaskKind;          // only tasks or only epics
  priority?: Priority | Priority[]; // filter only; never changes the order
  frozen?: boolean;
  epicId?: number | "none"; // children of this epic, or "none" = tasks without an epic (epics excluded)
  includeEpic?: boolean;    // with a numeric epicId: also return the epic itself (the board filter does this)
  limit?: number;
}

const STEP = 1024;
const MAX_TITLE = 500;
const MAX_TEXT = 200_000;

function checkText(v: string, field: string, max = MAX_TEXT) {
  if (v.length > max) throw new AppError("too_long", `Поле ${field} длиннее ${max} символов`);
}

export const tagKey = (name: string) => name.normalize("NFKC").trim().toLocaleLowerCase("ru");
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "ru", { sensitivity: "base" });

export function isStatus(s: unknown): s is Status {
  return typeof s === "string" && (STATUS_IDS as string[]).includes(s);
}

export function ftsQuery(q: string): string | null {
  const toks = q
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 12);
  if (!toks.length) return null;
  return toks.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" AND ");
}

const EPIC_ERRORS: Record<string, string> = {
  epic_self: "Задача не может быть эпиком самой себе",
  epic_nested: "Эпик не может входить в другой эпик",
  epic_parent_missing: "Эпик не найден",
  epic_parent_not_epic: "Родителем может быть только эпик",
  epic_has_children: "У эпика есть задачи — сначала отвяжите их",
};
/** Turn a trigger RAISE (see migration 3) into a readable AppError. */
function epicError(e: unknown): never {
  const m = (e as Error)?.message ?? "";
  const code = Object.keys(EPIC_ERRORS).find((k) => m.includes(k));
  if (code) throw new AppError(code, EPIC_ERRORS[code], 409);
  throw e;
}

export class Repo {
  readonly events = new EventEmitter();

  constructor(readonly db: DB) {
    this.events.setMaxListeners(100);
  }

  private changed(kind: string, taskId?: number) {
    this.events.emit("change", { kind, taskId, at: nowIso() });
  }

  archiveDoneTasks(now = nowIso()): number {
    // Calendar month in Moscow time. Clamp to the target month's last day when needed.
    // SQLite's default +1 month rolls into the following month for dates such as January 31.
    const { changes } = this.db.prepare(`
      UPDATE tasks SET status = 'done_final', updated_at = ?
      WHERE kind = 'task' AND status = 'done' AND done_at IS NOT NULL
        AND (min(date(done_at, '+3 hours', '+1 month'),
                 date(done_at, '+3 hours', 'start of month', '+2 months', '-1 day'))
             || 'T' || strftime('%H:%M:%f', done_at, '+3 hours'))
          <= strftime('%Y-%m-%dT%H:%M:%f', ?, '+3 hours')
    `).run(now, now);
    if (changes) this.changed("task");
    return changes;
  }

  // ───────────────────────── tags ─────────────────────────
  listTags(): Tag[] {
    return (this.db
      .prepare(
        `SELECT t.id, t.name, t.color, COUNT(tt.task_id) AS task_count
         FROM tags t LEFT JOIN task_tags tt ON tt.tag_id = t.id
         GROUP BY t.id`,
      )
      .all() as Tag[]).sort(byName);
  }

  findTag(name: string): Tag | undefined {
    return this.db.prepare(`SELECT id, name, color FROM tags WHERE name_key = ?`).get(tagKey(name)) as Tag | undefined;
  }

  createTag(name: string, color?: string): Tag {
    const n = (name ?? "").trim();
    if (!n) throw new AppError("invalid", "Имя тега не может быть пустым");
    if (n.length > 40) throw new AppError("too_long", "Имя тега длиннее 40 символов");
    if (this.findTag(n)) throw new AppError("conflict", `Тег «${n}» уже существует`, 409);
    const c = color ?? this.nextColor();
    if (!(TAG_COLORS as readonly string[]).includes(c)) throw new AppError("invalid", `Цвет должен быть одним из: ${TAG_COLORS.join(", ")}`);
    const r = this.db.prepare(`INSERT INTO tags(name, name_key, color, created_at) VALUES (?,?,?,?)`).run(n, tagKey(n), c, nowIso());
    this.changed("tag");
    return { id: Number(r.lastInsertRowid), name: n, color: c as TagColor };
  }

  updateTag(id: number, patch: { name?: string; color?: string }): Tag {
    const tag = this.db.prepare(`SELECT id, name, color FROM tags WHERE id = ?`).get(id) as Tag | undefined;
    if (!tag) throw new AppError("not_found", `Тег ${id} не найден`, 404);
    const name = patch.name !== undefined ? patch.name.trim() : tag.name;
    const color = patch.color ?? tag.color;
    if (!name) throw new AppError("invalid", "Имя тега не может быть пустым");
    if (!(TAG_COLORS as readonly string[]).includes(color)) throw new AppError("invalid", "Недопустимый цвет");
    const other = this.findTag(name);
    if (other && other.id !== id) throw new AppError("conflict", `Тег «${name}» уже существует`, 409);
    this.db.prepare(`UPDATE tags SET name = ?, name_key = ?, color = ? WHERE id = ?`).run(name, tagKey(name), color, id);
    this.changed("tag");
    return { id, name, color: color as TagColor };
  }

  deleteTag(id: number) {
    const r = this.db.prepare(`DELETE FROM tags WHERE id = ?`).run(id);
    if (!r.changes) throw new AppError("not_found", `Тег ${id} не найден`, 404);
    this.changed("tag");
  }

  private nextColor(): TagColor {
    const n = (this.db.prepare(`SELECT COUNT(*) AS n FROM tags`).get() as { n: number }).n;
    return TAG_COLORS[n % TAG_COLORS.length];
  }

  /** Resolve names to tags; optionally create the missing ones. */
  resolveTags(names: string[], createMissing: boolean): Tag[] {
    const out: Tag[] = [];
    for (const raw of names) {
      const n = raw.trim();
      if (!n) continue;
      let t = this.findTag(n);
      if (!t) {
        if (!createMissing) throw new AppError("not_found", `Тег «${n}» не найден (создайте его или передайте create_missing)`, 404);
        t = this.createTag(n);
      }
      if (!out.some((x) => x.id === t!.id)) out.push(t);
    }
    return out;
  }

  assignTags(taskId: number, names: string[], createMissing = false): TaskSummary {
    this.requireTask(taskId);
    const tags = this.resolveTags(names, createMissing);
    const ins = this.db.prepare(`INSERT OR IGNORE INTO task_tags(task_id, tag_id) VALUES (?,?)`);
    this.db.transaction(() => {
      for (const t of tags) ins.run(taskId, t.id);
      this.touch(taskId);
    })();
    this.changed("task", taskId);
    return this.getSummary(taskId)!;
  }

  unassignTags(taskId: number, names: string[]): TaskSummary {
    this.requireTask(taskId);
    const del = this.db.prepare(`DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?`);
    this.db.transaction(() => {
      for (const n of names) {
        const t = this.findTag(n);
        if (t) del.run(taskId, t.id);
      }
      this.touch(taskId);
    })();
    this.changed("task", taskId);
    return this.getSummary(taskId)!;
  }

  setTaskTags(taskId: number, tagIds: number[]) {
    this.requireTask(taskId);
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM task_tags WHERE task_id = ?`).run(taskId);
      const ins = this.db.prepare(`INSERT OR IGNORE INTO task_tags(task_id, tag_id) SELECT ?, id FROM tags WHERE id = ?`);
      for (const id of tagIds) ins.run(taskId, id);
      this.touch(taskId);
    })();
    this.changed("task", taskId);
  }

  // ───────────────────────── tasks ─────────────────────────
  private requireTask(id: number) {
    const r = this.db.prepare(`SELECT id, status, epic_id FROM tasks WHERE id = ?`).get(id) as { id: number; status: Status; epic_id: number | null } | undefined;
    if (!r) throw new AppError("not_found", `Задача #${id} не найдена`, 404);
    return r;
  }

  private touch(id: number) {
    this.db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(nowIso(), id);
  }

  private tagsFor(ids: number[]): Map<number, Tag[]> {
    const m = new Map<number, Tag[]>();
    if (!ids.length) return m;
    const rows = this.db
      .prepare(
        `SELECT tt.task_id, t.id, t.name, t.color FROM task_tags tt JOIN tags t ON t.id = tt.tag_id
         WHERE tt.task_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as (Tag & { task_id: number })[];
    rows.sort(byName);
    for (const r of rows) {
      const arr = m.get(r.task_id) ?? [];
      arr.push({ id: r.id, name: r.name, color: r.color });
      m.set(r.task_id, arr);
    }
    return m;
  }

  // Explicit column list: agent_notes is never selected for summaries / UI payloads.
  private static SUMMARY_COLS = `t.id, t.title, t.status, t.position, t.due_date, t.created_at, t.updated_at,
    (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count,
    (length(t.human_description) > 0) AS has_description,
    t.kind, t.epic_id, t.priority, t.frozen, (SELECT e.title FROM tasks e WHERE e.id = t.epic_id) AS epic_title,
    CASE WHEN t.kind = 'epic' THEN (SELECT COUNT(*) FROM tasks ch WHERE ch.epic_id = t.id) END AS child_total,
    CASE WHEN t.kind = 'epic' THEN (SELECT COUNT(*) FROM tasks ch WHERE ch.epic_id = t.id AND ch.status IN ('done', 'done_final')) END AS child_done`;

  private static toSummary(r: RawSummary, tags: Tag[]): TaskSummary {
    const { has_description, epic_title, child_total, child_done, frozen, ...rest } = r;
    return {
      ...rest,
      has_description: !!has_description,
      frozen: frozen === 1,
      tags,
      epic: r.epic_id !== null && epic_title !== null ? { id: r.epic_id, title: epic_title } : null,
      progress: r.kind === "epic" ? { done: child_done ?? 0, total: child_total ?? 0 } : null,
    };
  }

  listTasks(f: ListFilter = {}): TaskSummary[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.status) {
      const sts = Array.isArray(f.status) ? f.status : [f.status];
      for (const s of sts) if (!isStatus(s)) throw new AppError("invalid", `Неизвестный статус ${s}`);
      if (sts.length) {
        where.push(`t.status IN (${sts.map(() => "?").join(",")})`);
        args.push(...sts);
      }
    }
    const tagNames = (f.tags ?? []).map((s) => s.trim()).filter(Boolean);
    if (tagNames.length) {
      const ids: number[] = [];
      for (const n of tagNames) {
        const t = this.findTag(n);
        if (t) ids.push(t.id);
        else if ((f.tagMatch ?? "any") === "all") return []; // impossible to match an unknown tag
      }
      if (!ids.length) return [];
      const ph = ids.map(() => "?").join(",");
      if ((f.tagMatch ?? "any") === "all") {
        where.push(`(SELECT COUNT(DISTINCT tag_id) FROM task_tags x WHERE x.task_id = t.id AND x.tag_id IN (${ph})) = ?`);
        args.push(...ids, ids.length);
      } else {
        where.push(`EXISTS (SELECT 1 FROM task_tags x WHERE x.task_id = t.id AND x.tag_id IN (${ph}))`);
        args.push(...ids);
      }
    }
    if (f.priority !== undefined) {
      const ps = Array.isArray(f.priority) ? f.priority : [f.priority];
      for (const p of ps) if (!isPriority(p)) throw new AppError("invalid", `Неизвестный приоритет ${p}; допустимо: ${PRIORITY_IDS.join(", ")}`);
      if (ps.length) {
        where.push(`t.priority IN (${ps.map(() => "?").join(",")})`);
        args.push(...ps);
      }
    }
    if (f.frozen !== undefined) {
      where.push("t.frozen = ?");
      args.push(Number(f.frozen));
    }
    if (f.kind) {
      if (!(TASK_KINDS as readonly string[]).includes(f.kind)) throw new AppError("invalid", `Неизвестный тип ${f.kind}`);
      where.push(`t.kind = ?`);
      args.push(f.kind);
    }
    if (f.epicId === "none") {
      where.push(`t.epic_id IS NULL AND t.kind = 'task'`);
    } else if (f.epicId !== undefined) {
      where.push(f.includeEpic ? `(t.epic_id = ? OR (t.id = ? AND t.kind = 'epic'))` : `t.epic_id = ?`);
      args.push(f.epicId, ...(f.includeEpic ? [f.epicId] : []));
    }
    if (f.query && f.query.trim()) {
      const q = ftsQuery(f.query);
      if (q) {
        where.push(`t.id IN (SELECT rowid FROM task_search WHERE task_search MATCH ?)`);
        args.push(q);
      }
    }
    const order = `CASE t.status ${STATUSES.map((s, i) => `WHEN '${s.id}' THEN ${i}`).join(" ")} END, t.position, t.id`;
    const limit = Math.min(Math.max(f.limit ?? 1000, 1), 5000);
    const rows = this.db
      .prepare(`SELECT ${Repo.SUMMARY_COLS} FROM tasks t ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT ${limit}`)
      .all(...args) as RawSummary[];
    const tags = this.tagsFor(rows.map((r) => r.id));
    return rows.map((r) => Repo.toSummary(r, tags.get(r.id) ?? []));
  }

  getSummary(id: number): TaskSummary | undefined {
    const r = this.db.prepare(`SELECT ${Repo.SUMMARY_COLS} FROM tasks t WHERE t.id = ?`).get(id) as RawSummary | undefined;
    if (!r) return undefined;
    return Repo.toSummary(r, this.tagsFor([id]).get(id) ?? []);
  }

  /** Human-facing task: summary + human_description + comments (+ children for an epic). No agent_notes. */
  getTask(id: number): TaskDetail {
    const s = this.getSummary(id);
    if (!s) throw new AppError("not_found", `Задача #${id} не найдена`, 404);
    const { human_description } = this.db.prepare(`SELECT human_description FROM tasks WHERE id = ?`).get(id) as { human_description: string };
    const d: TaskDetail = { ...s, human_description, comments: this.listComments(id) };
    if (s.kind === "epic") d.children = this.listTasks({ epicId: id, limit: 5000 });
    return d;
  }

  /** All epics with progress (for pickers, the epic filter and MCP list_epics). */
  listEpics(f: { status?: Status | Status[]; tags?: string[]; query?: string; priority?: Priority | Priority[] } = {}): EpicSummary[] {
    return this.listTasks({ ...f, kind: "epic", limit: 5000 }).map((e) => ({
      id: e.id, title: e.title, status: e.status, priority: e.priority, tags: e.tags, progress: e.progress ?? { done: 0, total: 0 },
    }));
  }

  /** Validate a prospective parent inside the current transaction. */
  private checkParent(childId: number | null, childKind: TaskKind, epicId: number) {
    if (childId !== null && epicId === childId) throw new AppError("epic_self", EPIC_ERRORS.epic_self, 409);
    if (childKind === "epic") throw new AppError("epic_nested", EPIC_ERRORS.epic_nested, 409);
    const p = this.db.prepare(`SELECT kind FROM tasks WHERE id = ?`).get(epicId) as { kind: TaskKind } | undefined;
    if (!p) throw new AppError("epic_parent_missing", `Эпик #${epicId} не найден`, 404);
    if (p.kind !== "epic") throw new AppError("epic_parent_not_epic", `#${epicId} — не эпик; родителем может быть только эпик`, 409);
  }

  /** Attach a task to an epic, move it to another one, or detach it (epicId = null). Tags are not touched. */
  setTaskEpic(id: number, epicId: number | null): TaskSummary {
    let prev: number | null = null;
    try {
      this.db.transaction(() => {
        const cur = this.db.prepare(`SELECT kind, epic_id FROM tasks WHERE id = ?`).get(id) as { kind: TaskKind; epic_id: number | null } | undefined;
        if (!cur) throw new AppError("not_found", `Задача #${id} не найдена`, 404);
        prev = cur.epic_id;
        if (epicId !== null) this.checkParent(id, cur.kind, epicId);
        if (cur.epic_id === epicId) return;
        this.db.prepare(`UPDATE tasks SET epic_id = ?, updated_at = ? WHERE id = ?`).run(epicId, nowIso(), id);
      }).immediate();
    } catch (e) {
      if (e instanceof AppError) throw e;
      epicError(e);
    }
    this.changed("task", id);
    if (prev !== null && prev !== epicId) this.changed("task", prev);
    if (epicId !== null) this.changed("task", epicId);
    return this.getSummary(id)!;
  }

  /** Turn a task into an epic or back. A task with an epic cannot become an epic; an epic with children cannot become a task. */
  private setKindTx(id: number, kind: TaskKind) {
    if (!(TASK_KINDS as readonly string[]).includes(kind)) throw new AppError("invalid", `Неизвестный тип ${kind}`);
    const cur = this.db.prepare(`SELECT kind, epic_id FROM tasks WHERE id = ?`).get(id) as { kind: TaskKind; epic_id: number | null };
    if (cur.kind === kind) return;
    if (kind === "epic" && cur.epic_id !== null) throw new AppError("epic_nested", "Задача входит в эпик — сначала уберите эпик, потом делайте её эпиком", 409);
    if (kind === "task") {
      const n = (this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE epic_id = ?`).get(id) as { n: number }).n;
      if (n) throw new AppError("epic_has_children", `У эпика ${n} задач(и) — сначала отвяжите их`, 409);
    }
    this.db.prepare(`UPDATE tasks SET kind = ?, updated_at = ? WHERE id = ?`).run(kind, nowIso(), id);
  }

  createTask(input: {
    title: string; status?: Status; human_description?: string; agent_notes?: string;
    tags?: string[]; tag_ids?: number[]; due_date?: string | null; place?: "top" | "bottom"; create_missing_tags?: boolean;
    kind?: TaskKind; epic_id?: number | null; priority?: Priority; frozen?: boolean;
  }): TaskSummary {
    const title = (input.title ?? "").trim();
    if (!title) throw new AppError("invalid", "Название задачи не может быть пустым");
    checkText(title, "title", MAX_TITLE);
    const status = input.status ?? "inbox";
    if (!BOARD_STATUS_IDS.includes(status)) throw new AppError("invalid", `Недоступный статус ${status}`);
    const hd = input.human_description ?? "";
    const an = input.agent_notes ?? "";
    checkText(hd, "human_description");
    checkText(an, "agent_notes");
    const due = normDate(input.due_date);
    const kind: TaskKind = input.kind ?? "task";
    if (!(TASK_KINDS as readonly string[]).includes(kind)) throw new AppError("invalid", `Неизвестный тип ${kind}`);
    const epicId = input.epic_id ?? null;
    if (epicId !== null) this.checkParent(null, kind, epicId);
    const priority: Priority = input.priority ?? "normal";
    if (!isPriority(priority)) throw new AppError("invalid", `Неизвестный приоритет ${priority}; допустимо: ${PRIORITY_IDS.join(", ")}`);
    const tags = input.tags?.length ? this.resolveTags(input.tags, !!input.create_missing_tags) : [];
    const ext = this.db
      .prepare(`SELECT MIN(position) AS lo, MAX(position) AS hi FROM tasks WHERE status = ?`)
      .get(status) as { lo: number | null; hi: number | null };
    const pos = (input.place ?? "top") === "top" ? (ext.lo ?? STEP) - STEP : (ext.hi ?? 0) + STEP;
    const now = nowIso();
    let id = 0;
    try {
    this.db.transaction(() => {
      const r = this.db
        .prepare(
          `INSERT INTO tasks(title, status, position, human_description, agent_notes, due_date, created_at, updated_at, agent_notes_updated_at, kind, epic_id, priority, frozen)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(title, status, pos, hd, an, due, now, now, an ? now : null, kind, epicId, priority, Number(input.frozen ?? false));
      id = Number(r.lastInsertRowid);
      const ins = this.db.prepare(`INSERT OR IGNORE INTO task_tags(task_id, tag_id) VALUES (?,?)`);
      for (const t of tags) ins.run(id, t.id);
      if (input.tag_ids) {
        const insId = this.db.prepare(`INSERT OR IGNORE INTO task_tags(task_id, tag_id) SELECT ?, id FROM tags WHERE id = ?`);
        for (const tid of input.tag_ids) insId.run(id, tid);
      }
      this.reindex(id);
    }).immediate();
    } catch (e) {
      if (e instanceof AppError) throw e;
      epicError(e);
    }
    this.changed("task", id);
    if (epicId !== null) this.changed("task", epicId);
    return this.getSummary(id)!;
  }

  /** Partial update of human-visible fields. agent_notes is NOT accepted here. */
  updateTask(id: number, patch: { title?: string; status?: Status; due_date?: string | null; human_description?: string; kind?: TaskKind; epic_id?: number | null; priority?: Priority; frozen?: boolean }): TaskSummary {
    if (patch.status !== undefined && !BOARD_STATUS_IDS.includes(patch.status)) {
      throw new AppError("invalid", `Недоступный статус ${patch.status}`);
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new AppError("invalid", "Название задачи не может быть пустым");
      checkText(t, "title", MAX_TITLE);
      sets.push("title = ?");
      args.push(t);
    }
    if (patch.human_description !== undefined) {
      checkText(patch.human_description, "human_description");
      sets.push("human_description = ?");
      args.push(patch.human_description);
    }
    if (patch.due_date !== undefined) {
      sets.push("due_date = ?");
      args.push(normDate(patch.due_date));
    }
    if (patch.priority !== undefined) {
      if (!isPriority(patch.priority)) throw new AppError("invalid", `Неизвестный приоритет ${patch.priority}; допустимо: ${PRIORITY_IDS.join(", ")}`);
      sets.push("priority = ?");
      args.push(patch.priority);
    }
    if (patch.frozen !== undefined) {
      sets.push("frozen = ?");
      args.push(Number(patch.frozen));
    }
    // Kind and epic changes go first (detach before turning into an epic, convert before attaching is impossible anyway).
    const epicChange = patch.epic_id !== undefined;
    let previousEpic: number | null = null;
    try {
      this.db.transaction(() => {
        const cur = this.requireTask(id);
        previousEpic = cur.epic_id;
        if (epicChange && patch.epic_id === null) this.db.prepare(`UPDATE tasks SET epic_id = NULL WHERE id = ?`).run(id);
        if (patch.kind !== undefined) this.setKindTx(id, patch.kind);
        if (epicChange && patch.epic_id !== null) {
          const k = (this.db.prepare(`SELECT kind FROM tasks WHERE id = ?`).get(id) as { kind: TaskKind }).kind;
          this.checkParent(id, k, patch.epic_id!);
          this.db.prepare(`UPDATE tasks SET epic_id = ? WHERE id = ?`).run(patch.epic_id, id);
        }
        if (sets.length) {
          sets.push("updated_at = ?");
          args.push(nowIso(), id);
          this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args);
        } else if (epicChange) this.touch(id);
        if (patch.status !== undefined && patch.status !== cur.status) {
          this.moveTaskTx(id, { status: patch.status });
        }
        this.reindex(id);
      }).immediate();
    } catch (e) {
      if (e instanceof AppError) throw e;
      epicError(e);
    }
    this.changed("task", id);
    if (previousEpic !== null) this.changed("task", previousEpic);
    if (epicChange && patch.epic_id) this.changed("task", patch.epic_id);
    return this.getSummary(id)!;
  }

  appendHumanDescription(id: number, text: string): TaskSummary {
    this.requireTask(id);
    const { human_description } = this.db.prepare(`SELECT human_description FROM tasks WHERE id = ?`).get(id) as { human_description: string };
    const next = human_description ? `${human_description.replace(/\s+$/, "")}\n\n${text}` : text;
    return this.updateTask(id, { human_description: next });
  }

  /** Deleting an epic keeps its tasks: they simply lose the epic (FK ON DELETE SET NULL). */
  deleteTask(id: number) {
    const cur = this.requireTask(id);
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
      this.db.prepare(`DELETE FROM task_search WHERE rowid = ?`).run(id);
    })();
    this.changed("task", id);
    if (cur.epic_id !== null) this.changed("task", cur.epic_id);
  }

  // ───────────────────────── agent notes (separate channel) ─────────────────────────
  getAgentNotes(id: number): AgentNotes {
    this.requireTask(id);
    const r = this.db.prepare(`SELECT agent_notes, agent_notes_updated_at FROM tasks WHERE id = ?`).get(id) as {
      agent_notes: string; agent_notes_updated_at: string | null;
    };
    return { task_id: id, ...r };
  }

  setAgentNotes(id: number, text: string): AgentNotes {
    this.requireTask(id);
    checkText(text, "agent_notes");
    const now = nowIso();
    // Only agent_notes columns are touched: human_description and updated_at stay as they are.
    this.db.prepare(`UPDATE tasks SET agent_notes = ?, agent_notes_updated_at = ? WHERE id = ?`).run(text, now, id);
    this.changed("agent_notes", id);
    return this.getAgentNotes(id);
  }

  appendAgentNotes(id: number, text: string, author?: string): AgentNotes {
    const cur = this.getAgentNotes(id);
    const stamp = `### ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC${author ? ` · ${author}` : ""}`;
    const entry = `${stamp}\n${text.trim()}`;
    const next = cur.agent_notes ? `${cur.agent_notes.replace(/\s+$/, "")}\n\n${entry}` : entry;
    return this.setAgentNotes(id, next);
  }

  // ───────────────────────── ordering ─────────────────────────
  /**
   * Move a task to a status and place it relative to neighbours.
   * Exactly one placement hint is used: before_id, after_id, index (0 = top) or, if none, the top of the column.
   */
  moveTask(id: number, to: { status?: Status; before_id?: number; after_id?: number; index?: number }): TaskSummary {
    const cur = this.requireTask(id);
    this.db.transaction(() => this.moveTaskTx(id, to))();
    this.changed("task", id);
    if (cur.epic_id !== null) this.changed("task", cur.epic_id);
    return this.getSummary(id)!;
  }

  private moveTaskTx(id: number, to: { status?: Status; before_id?: number; after_id?: number; index?: number }) {
    const cur = this.requireTask(id);
    let status: Status = to.status ?? cur.status;
    const neighbourId = to.before_id ?? to.after_id;
    if (neighbourId !== undefined) {
      if (neighbourId === id) throw new AppError("invalid", "Нельзя поставить задачу относительно самой себя");
      const n = this.requireTask(neighbourId);
      if (to.status && n.status !== to.status) throw new AppError("invalid", `Задача #${neighbourId} в другой колонке`);
      status = n.status;
    }
    if (!BOARD_STATUS_IDS.includes(status)) throw new AppError("invalid", `Недоступный статус ${status}`);
    const col = () =>
      this.db.prepare(`SELECT id, position FROM tasks WHERE status = ? AND id != ? ORDER BY position, id`).all(status, id) as {
        id: number; position: number;
      }[];
    let others = col();
    let idx: number;
    if (to.before_id !== undefined) idx = others.findIndex((o) => o.id === to.before_id);
    else if (to.after_id !== undefined) idx = others.findIndex((o) => o.id === to.after_id) + 1;
    else if (to.index !== undefined) idx = Math.max(0, Math.min(Math.trunc(to.index), others.length));
    else idx = 0;
    const posAt = (list: typeof others, i: number) => {
      const prev = list[i - 1]?.position;
      const next = list[i]?.position;
      if (prev === undefined && next === undefined) return 0;
      if (prev === undefined) return next! - STEP;
      if (next === undefined) return prev + STEP;
      return (prev + next) / 2;
    };
    let pos = posAt(others, idx);
    const prev = others[idx - 1]?.position;
    const next = others[idx]?.position;
    if ((prev !== undefined && pos - prev < 1e-6) || (next !== undefined && next - pos < 1e-6)) {
      // renormalise the column, then recompute
      const upd = this.db.prepare(`UPDATE tasks SET position = ? WHERE id = ?`);
      others.forEach((o, i) => upd.run((i + 1) * STEP, o.id));
      others = col();
      pos = posAt(others, idx);
    }
    this.db.prepare(`UPDATE tasks SET status = ?, position = ?, updated_at = ? WHERE id = ?`).run(status, pos, nowIso(), id);
  }

  // ───────────────────────── comments ─────────────────────────
  listComments(taskId: number): Comment[] {
    return this.db
      .prepare(`SELECT id, task_id, author, author_kind, body, created_at FROM comments WHERE task_id = ? ORDER BY created_at, id`)
      .all(taskId) as Comment[];
  }

  addComment(taskId: number, c: { body: string; author: string; author_kind: "owner" | "agent" }): Comment {
    this.requireTask(taskId);
    const body = (c.body ?? "").trim();
    if (!body) throw new AppError("invalid", "Комментарий не может быть пустым");
    checkText(body, "comment", 50_000);
    const author = (c.author ?? "").trim().slice(0, 60) || (c.author_kind === "owner" ? "Вы" : "агент");
    const now = nowIso();
    let id = 0;
    this.db.transaction(() => {
      id = Number(
        this.db.prepare(`INSERT INTO comments(task_id, author, author_kind, body, created_at) VALUES (?,?,?,?,?)`)
          .run(taskId, author, c.author_kind, body, now).lastInsertRowid,
      );
      this.touch(taskId);
      this.reindex(taskId);
    })();
    this.changed("comment", taskId);
    return { id, task_id: taskId, author, author_kind: c.author_kind, body, created_at: now };
  }

  // ───────────────────────── search index ─────────────────────────
  private reindex(id: number) {
    const t = this.db.prepare(`SELECT title, human_description FROM tasks WHERE id = ?`).get(id) as
      | { title: string; human_description: string }
      | undefined;
    this.db.prepare(`DELETE FROM task_search WHERE rowid = ?`).run(id);
    if (!t) return;
    const comments = (this.db.prepare(`SELECT body FROM comments WHERE task_id = ? ORDER BY id`).all(id) as { body: string }[])
      .map((c) => c.body)
      .join("\n");
    this.db.prepare(`INSERT INTO task_search(rowid, title, human_description, comments) VALUES (?,?,?,?)`).run(id, t.title, t.human_description, comments);
  }
}

function normDate(d: string | null | undefined): string | null {
  if (d === undefined || d === null || d === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new AppError("invalid", "Срок должен быть датой в формате ГГГГ-ММ-ДД");
  return d;
}

type RawSummary = Omit<TaskSummary, "tags" | "has_description" | "epic" | "progress" | "frozen"> & {
  frozen: 0 | 1;
  has_description: number; epic_title: string | null; child_total: number | null; child_done: number | null;
};
