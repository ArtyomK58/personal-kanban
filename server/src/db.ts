import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

/**
 * Ordered, append-only migrations. Never edit an applied migration; add a new one.
 * PRAGMA user_version stores the number of applied migrations.
 */
const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'inbox',
    position REAL NOT NULL DEFAULT 0,
    human_description TEXT NOT NULL DEFAULT '',
    agent_notes TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    agent_notes_updated_at TEXT
  );
  CREATE INDEX tasks_status_pos ON tasks(status, position);

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE, -- Unicode case-folded name (SQLite NOCASE is ASCII-only)
    color TEXT NOT NULL DEFAULT 'slate',
    created_at TEXT NOT NULL
  );

  CREATE TABLE task_tags (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, tag_id)
  );
  CREATE INDEX task_tags_tag ON task_tags(tag_id);

  CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('owner','agent')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX comments_task ON comments(task_id, created_at);

  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('owner','agent')),
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    token_id INTEGER NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  -- Full-text index over USER-VISIBLE content only (title, human description, comments).
  -- agent_notes are deliberately never indexed here.
  CREATE VIRTUAL TABLE task_search USING fts5(
    title, human_description, comments,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
  // 2 — remembered sessions without server-side expiry; persistent brute-force limiter
  `
  ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
  -- Sessions no longer expire on the server; expires_at is kept only for compatibility.
  UPDATE sessions SET expires_at = '9999-12-31T23:59:59.999Z', last_seen_at = COALESCE(last_seen_at, created_at);

  -- One row per limiter bucket: 'ip:<addr or /64>' or 'global'. Times are unix milliseconds.
  CREATE TABLE auth_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    strikes INTEGER NOT NULL DEFAULT 0,
    last_failure INTEGER NOT NULL DEFAULT 0
  );
  -- Client addresses that authenticated successfully; they keep logging in during a global lock.
  CREATE TABLE trusted_clients (
    key TEXT PRIMARY KEY,
    last_success INTEGER NOT NULL
  );
  `,
  // 3 — epics: a task of kind 'epic' groups ordinary tasks; at most one parent epic per task, no nesting.
  // Existing rows become ordinary tasks without an epic. Invariants are enforced by the repo AND by triggers,
  // so a second process (stdio MCP adapter) cannot break them either.
  `
  ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','epic'));
  ALTER TABLE tasks ADD COLUMN epic_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
  CREATE INDEX tasks_epic ON tasks(epic_id);

  CREATE TRIGGER tasks_epic_check_insert BEFORE INSERT ON tasks
  WHEN NEW.epic_id IS NOT NULL BEGIN
    SELECT CASE
      WHEN NEW.kind = 'epic' THEN RAISE(ABORT, 'epic_nested')
      WHEN NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id = NEW.epic_id) THEN RAISE(ABORT, 'epic_parent_missing')
      WHEN (SELECT kind FROM tasks p WHERE p.id = NEW.epic_id) != 'epic' THEN RAISE(ABORT, 'epic_parent_not_epic')
    END;
  END;

  CREATE TRIGGER tasks_epic_check_update BEFORE UPDATE OF epic_id, kind ON tasks
  WHEN NEW.epic_id IS NOT NULL BEGIN
    SELECT CASE
      WHEN NEW.epic_id = NEW.id THEN RAISE(ABORT, 'epic_self')
      WHEN NEW.kind = 'epic' THEN RAISE(ABORT, 'epic_nested')
      WHEN NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id = NEW.epic_id) THEN RAISE(ABORT, 'epic_parent_missing')
      WHEN (SELECT kind FROM tasks p WHERE p.id = NEW.epic_id) != 'epic' THEN RAISE(ABORT, 'epic_parent_not_epic')
    END;
  END;

  CREATE TRIGGER tasks_epic_kind_children BEFORE UPDATE OF kind ON tasks
  WHEN OLD.kind = 'epic' AND NEW.kind != 'epic' AND EXISTS (SELECT 1 FROM tasks c WHERE c.epic_id = OLD.id) BEGIN
    SELECT RAISE(ABORT, 'epic_has_children');
  END;
  `,
  // 4 — priority: exactly low | normal | high; every existing and new row is 'normal' unless set explicitly.
  // Priority is NOT the order on the board (that stays the manual position) and not a status.
  `
  ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high'));
  `,
  // 5 — freezing is independent of the task status and priority.
  `
  ALTER TABLE tasks ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0, 1));
  `,
  // 6 — track continuous time in Done. For old rows, updated_at is the latest possible entry time.
  `
  ALTER TABLE tasks ADD COLUMN done_at TEXT;
  UPDATE tasks SET done_at = updated_at WHERE status = 'done';

  CREATE INDEX tasks_done_at ON tasks(done_at) WHERE kind = 'task' AND status = 'done';

  CREATE TRIGGER tasks_done_at_insert AFTER INSERT ON tasks WHEN NEW.status = 'done' BEGIN
    UPDATE tasks SET done_at = NEW.created_at WHERE id = NEW.id;
  END;

  CREATE TRIGGER tasks_done_at_transition AFTER UPDATE OF status ON tasks
  WHEN OLD.status <> NEW.status AND NEW.status <> 'done_final' BEGIN
    UPDATE tasks SET done_at = CASE WHEN NEW.status = 'done' THEN NEW.updated_at END WHERE id = NEW.id;
  END;
  `,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

export function migrate(db: DB): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return MIGRATIONS.length;
}

export const nowIso = () => new Date().toISOString();
