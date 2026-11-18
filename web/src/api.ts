export type BoardStatus = "inbox" | "in_progress" | "review" | "done";
export type Status = BoardStatus | "done_final";
export const FINAL_DONE_LABEL = "Готово окончательно";
export type TagColor = "slate" | "blue" | "teal" | "green" | "amber" | "orange" | "rose" | "violet";
export type TaskKind = "task" | "epic";
export type Priority = "low" | "normal" | "high";
export interface Tag { id: number; name: string; color: TagColor; task_count?: number }
export interface Progress { done: number; total: number }
export interface TaskSummary {
  id: number; title: string; status: Status; position: number; due_date: string | null;
  created_at: string; updated_at: string; tags: Tag[]; comment_count: number; has_description: boolean;
  kind: TaskKind; epic_id: number | null; epic: { id: number; title: string } | null; progress: Progress | null; priority: Priority; frozen: boolean;
}
export interface EpicSummary { id: number; title: string; status: Status; priority: Priority; tags: Tag[]; progress: Progress }
export interface Comment { id: number; task_id: number; author: string; author_kind: "owner" | "agent"; body: string; created_at: string }
/** The UI task payload intentionally has no agent notes. */
export interface TaskDetail extends TaskSummary { human_description: string; comments: Comment[]; children?: TaskSummary[] }
export interface Board { statuses: { id: BoardStatus; label: string }[]; priorities?: { id: Priority; label: string }[]; tags: Tag[]; colors: TagColor[]; tasks: (TaskSummary & { status: BoardStatus })[]; total: number; epics: EpicSummary[] }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number, public scope?: string) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

async function req<T>(method: string, url: string, body?: unknown, opts: { auth401?: boolean } = {}): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "X-Kanban-Client": "web", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && opts.auth401 !== false) onUnauthorized();
  const data = r.headers.get("content-type")?.includes("json") ? await r.json() : null;
  if (!r.ok) {
    const ra = data?.retry_after ?? (Number(r.headers.get("retry-after")) || undefined);
    throw new ApiError(r.status, data?.error ?? "error", data?.message ?? `Ошибка ${r.status}`, ra, data?.scope);
  }
  return data as T;
}

export const api = {
  me: () => req<{ authenticated: boolean; name: string }>("GET", "/api/auth/me", undefined, { auth401: false }),
  login: (token: string) => req<{ ok: true }>("POST", "/api/auth/login", { token }, { auth401: false }),
  logout: () => req<{ ok: true }>("POST", "/api/auth/logout", undefined, { auth401: false }),
  board: (tags: string[], q: string, epic?: number | null) => {
    const p = new URLSearchParams();
    if (tags.length) p.set("tags", tags.join(","));
    if (q.trim()) p.set("q", q.trim());
    if (epic) p.set("epic", String(epic));
    return req<Board>("GET", `/api/board${p.size ? "?" + p : ""}`);
  },
  task: (id: number) => req<TaskDetail>("GET", `/api/tasks/${id}`),
  createTask: (b: { title: string; status?: Status; tag_ids?: number[]; human_description?: string; kind?: TaskKind; epic_id?: number | null; priority?: Priority; frozen?: boolean }) =>
    req<TaskSummary>("POST", "/api/tasks", b),
  updateTask: (id: number, b: Partial<{ title: string; status: Status; human_description: string; due_date: string | null; tag_ids: number[]; kind: TaskKind; epic_id: number | null; priority: Priority; frozen: boolean }>) =>
    req<TaskDetail>("PATCH", `/api/tasks/${id}`, b),
  deleteTask: (id: number) => req<{ ok: true }>("DELETE", `/api/tasks/${id}`),
  move: (id: number, b: { status?: Status; before_id?: number; after_id?: number; index?: number }) => req<TaskSummary>("POST", `/api/tasks/${id}/move`, b),
  comment: (id: number, body: string) => req<Comment>("POST", `/api/tasks/${id}/comments`, { body }),
  createTag: (name: string, color?: TagColor) => req<Tag>("POST", "/api/tags", { name, color }),
};

/** Local drafts survive closing the panel, reload and navigation. */
export const drafts = {
  get: (key: string) => { try { return localStorage.getItem("kanban:draft:" + key); } catch { return null; } },
  set: (key: string, v: string) => { try { localStorage.setItem("kanban:draft:" + key, v); } catch { /* quota */ } },
  del: (key: string) => { try { localStorage.removeItem("kanban:draft:" + key); } catch { /* ignore */ } },
};

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
export function fmtDue(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  const now = new Date();
  return `${day} ${MONTHS[m - 1]}${y !== now.getFullYear() ? " " + y : ""}`;
}
export function isOverdue(d: string | null, status: Status) {
  if (!d || status === "done" || status === "done_final") return false;
  return d < new Date().toISOString().slice(0, 10);
}
export function fmtTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 864e5;
  if (diff === 0) return `сегодня, ${hm}`;
  if (diff === 1) return `вчера, ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : ""}, ${hm}`;
}

/** «2 из 4 готово»; an empty epic has no NaN: «Нет задач». */
export const progressText = (p: Progress, suffix = true) => (p.total ? `${p.done} из ${p.total}${suffix ? " готово" : ""}` : "Нет задач");
export const progressPct = (p: Progress) => (p.total ? Math.round((p.done / p.total) * 100) : 0);
