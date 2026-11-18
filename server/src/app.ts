import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Auth, COOKIE_MAX_AGE_MS, SESSION_COOKIE, parseCookies, type TokenRow } from "./auth.js";
import { AuthLimiter, type LimitDecision } from "./limiter.js";
import { createMcpServer } from "./mcp.js";
import { AppError, BOARD_STATUSES, BOARD_STATUS_IDS, FINAL_DONE, PRIORITIES, PRIORITY_IDS, Repo, TAG_COLORS, TASK_KINDS } from "./repo.js";

export interface AppOptions {
  repo: Repo;
  auth: Auth;
  webDir?: string;          // built SPA; omitted in tests
  cookieSecure?: boolean;   // true behind HTTPS
  /** Express "trust proxy" value: false (default), or a list of proxy addresses/subnets that may set X-Forwarded-For. */
  trustProxy?: boolean | string | string[];
  limiter?: AuthLimiter;
  log?: (m: string) => void;
}

declare module "express-serve-static-core" {
  interface Request { actor?: TokenRow; viaCookie?: boolean }
}

const CLIENT_HEADER = "x-kanban-client";

export function createApp(o: AppOptions) {
  const { repo, auth } = o;
  const log = o.log ?? (() => {});
  const app = express();
  app.disable("x-powered-by");
  // Only explicitly listed proxy hops may set the client address; a client-supplied X-Forwarded-For is ignored otherwise.
  if (o.trustProxy) app.set("trust proxy", o.trustProxy);
  const limiter = o.limiter ?? new AuthLimiter(repo.db);
  const tooMany = (res: Response, d: Extract<LimitDecision, { allowed: false }>, json: Record<string, unknown>) => {
    res.setHeader("Retry-After", String(d.retryAfter));
    res.status(429).json({ ...json, retry_after: d.retryAfter, scope: d.scope });
  };

  // security headers
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    next();
  });

  // request log: method, path (no query, no headers, no bodies → no secrets)
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on("finish", () => {
      if (req.path !== "/healthz" && req.path !== "/api/events") log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms`);
    });
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // ───────────────────────── auth helpers ─────────────────────────
  const bearer = (req: Request) => {
    const h = req.headers.authorization;
    return h && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "").trim() : null;
  };

  type AuthResult = { row: TokenRow } | { row: null; limited?: Extract<LimitDecision, { allowed: false }> };

  /**
   * Bearer tokens go through the persistent limiter (shared with the login form, so switching endpoint does not help):
   * a locked client is refused BEFORE the token is even looked up. Session cookies are 256-bit random ids and are
   * not counted; an unknown/stale cookie is simply cleared.
   */
  function authenticate(req: Request, res: Response, allowCookie: boolean): AuthResult {
    const b = bearer(req);
    if (b) {
      const d = limiter.check(req.ip);
      if (!d.allowed) return { row: null, limited: d };
      const row = auth.verifyToken(b);
      if (!row) {
        limiter.fail(req.ip); // this attempt was evaluated → 401; the following ones get 429 if a lock started
        return { row: null };
      }
      limiter.success(req.ip);
      return { row };
    }
    if (allowCookie) {
      const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!sid) return { row: null };
      const s = auth.verifySession(sid);
      if (!s) {
        res.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "strict", secure: !!o.cookieSecure });
        return { row: null };
      }
      req.viaCookie = true;
      if (s.refreshCookie) setCookie(res, sid); // sliding renewal of the browser-side cap
      const { refreshCookie: _r, ...row } = s;
      return { row };
    }
    return { row: null };
  }

  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const a = authenticate(req, res, true);
    if (!a.row) {
      if ("limited" in a && a.limited) return tooMany(res, a.limited, { error: "rate_limited", message: `Слишком много неудачных попыток, повторите через ${a.limited.retryAfter} с` });
      res.status(401).json({ error: "unauthorized", message: "Требуется вход" });
      return;
    }
    const row = a.row;
    // CSRF: cookie-authenticated mutations must carry the custom header (cross-site forms cannot set it).
    if (req.viaCookie && !["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers[CLIENT_HEADER] !== "web") {
      res.status(403).json({ error: "csrf", message: "Отсутствует заголовок клиента" });
      return;
    }
    req.actor = row;
    next();
  };

  function setCookie(res: Response, value: string) {
    res.cookie(SESSION_COOKIE, value, {
      httpOnly: true,
      sameSite: "strict",
      secure: !!o.cookieSecure,
      path: "/",
      maxAge: COOKIE_MAX_AGE_MS,
    });
  }

  // ───────────────────────── /api/auth ─────────────────────────
  const api = express.Router();
  api.use(express.json({ limit: "1mb" }));
  api.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  api.post("/auth/login", (req, res) => {
    // The limiter is consulted before the token is looked up; the whole check→verify→record runs synchronously.
    const d = limiter.check(req.ip);
    if (!d.allowed) return tooMany(res, d, { error: "rate_limited", message: `Слишком много попыток, повторите через ${d.retryAfter} с` });
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    const row = auth.verifyToken(token);
    if (!row) {
      const next = limiter.fail(req.ip);
      res.status(401).json({ error: "invalid_token", message: "Неверный токен", ...(next.allowed ? {} : { retry_after: next.retryAfter }) });
      return;
    }
    limiter.success(req.ip);
    const s = auth.createSession(row.id);
    setCookie(res, s.id);
    res.json({ ok: true, name: row.name });
  });

  api.post("/auth/logout", (req, res) => {
    auth.deleteSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "strict", secure: !!o.cookieSecure });
    res.json({ ok: true });
  });

  api.get("/auth/me", (req, res) => {
    const a = authenticate(req, res, true);
    if (!a.row) {
      if ("limited" in a && a.limited) return tooMany(res, a.limited, { authenticated: false });
      res.status(401).json({ authenticated: false });
      return;
    }
    res.json({ authenticated: true, name: a.row.name, kind: a.row.kind });
  });

  // ───────────────────────── protected API ─────────────────────────
  api.use(requireAuth);

  const id = (req: Request) => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n) || n <= 0) throw new AppError("invalid", "Некорректный номер");
    return n;
  };
  const csv = (v: unknown) => (typeof v === "string" && v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

  api.get("/board", (req, res) => {
    // ?epic=<id> shows the epic itself and its tasks; combines with tags (any) and the search (AND).
    const epicRaw = typeof req.query.epic === "string" && req.query.epic ? Number(req.query.epic) : undefined;
    if (epicRaw !== undefined && (!Number.isInteger(epicRaw) || epicRaw <= 0)) throw new AppError("invalid", "Некорректный номер эпика");
    const tasks = repo.listTasks({
      tags: csv(req.query.tags), tagMatch: "any", query: typeof req.query.q === "string" ? req.query.q : undefined,
      status: BOARD_STATUS_IDS, epicId: epicRaw, includeEpic: true, limit: 5000,
    });
    const total = (repo.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status <> ?`).get(FINAL_DONE.id) as { n: number }).n;
    res.json({ statuses: BOARD_STATUSES, priorities: PRIORITIES, tags: repo.listTags(), colors: TAG_COLORS, tasks, total, epics: repo.listEpics() });
  });

  api.get("/tasks/:id", (req, res) => {
    res.json(repo.getTask(id(req)));
  });

  const taskCreate = z.object({
    title: z.string(),
    status: z.enum(BOARD_STATUS_IDS).optional(),
    human_description: z.string().optional(),
    tag_ids: z.array(z.number().int()).optional(),
    due_date: z.string().nullable().optional(),
    place: z.enum(["top", "bottom"]).optional(),
    kind: z.enum(TASK_KINDS).optional(),
    epic_id: z.number().int().positive().nullable().optional(),
    priority: z.enum(PRIORITY_IDS).optional(),
    frozen: z.boolean().optional(),
  }).strict();
  api.post("/tasks", (req, res) => {
    const b = taskCreate.parse(req.body);
    res.status(201).json(repo.createTask(b));
  });

  const taskPatch = z.object({
    title: z.string().optional(),
    status: z.enum(BOARD_STATUS_IDS).optional(),
    human_description: z.string().optional(),
    due_date: z.string().nullable().optional(),
    tag_ids: z.array(z.number().int()).optional(),
    kind: z.enum(TASK_KINDS).optional(),
    epic_id: z.number().int().positive().nullable().optional(),
    priority: z.enum(PRIORITY_IDS).optional(),
    frozen: z.boolean().optional(),
  }).strict(); // agent_notes is not accepted from the UI API
  api.patch("/tasks/:id", (req, res) => {
    const tid = id(req);
    const { tag_ids, ...rest } = taskPatch.parse(req.body);
    if (tag_ids) repo.setTaskTags(tid, tag_ids);
    repo.updateTask(tid, rest);
    res.json(repo.getTask(tid));
  });

  api.delete("/tasks/:id", (req, res) => {
    repo.deleteTask(id(req));
    res.json({ ok: true });
  });

  const move = z.object({
    status: z.enum(BOARD_STATUS_IDS).optional(),
    before_id: z.number().int().optional(),
    after_id: z.number().int().optional(),
    index: z.number().int().min(0).optional(),
  }).strict();
  api.post("/tasks/:id/move", (req, res) => {
    res.json(repo.moveTask(id(req), move.parse(req.body)));
  });

  api.post("/tasks/:id/comments", (req, res) => {
    const b = z.object({ body: z.string() }).strict().parse(req.body);
    const actor = req.actor!;
    res.status(201).json(repo.addComment(id(req), { body: b.body, author: actor.kind === "owner" ? "Вы" : actor.name, author_kind: actor.kind }));
  });

  api.get("/tags", (_req, res) => {
    res.json(repo.listTags());
  });
  api.post("/tags", (req, res) => {
    const b = z.object({ name: z.string(), color: z.enum(TAG_COLORS).optional() }).strict().parse(req.body);
    res.status(201).json(repo.createTag(b.name, b.color));
  });
  api.patch("/tags/:id", (req, res) => {
    const b = z.object({ name: z.string().optional(), color: z.enum(TAG_COLORS).optional() }).strict().parse(req.body);
    res.json(repo.updateTag(id(req), b));
  });
  api.delete("/tags/:id", (req, res) => {
    repo.deleteTag(id(req));
    res.json({ ok: true });
  });

  // Server-sent events: a tiny "something changed" signal (no task content) so the UI refetches.
  api.get("/events", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`retry: 3000\n\n`);
    const onChange = (e: { kind: string; taskId?: number; at: string }) => res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
    repo.events.on("change", onChange);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      repo.events.off("change", onChange);
    });
  });

  api.use((_req, res) => {
    res.status(404).json({ error: "not_found", message: "Нет такого метода API" });
  });

  app.use("/api", api);

  // ───────────────────────── MCP (Streamable HTTP, stateless) ─────────────────────────
  app.post("/mcp", express.json({ limit: "4mb" }), async (req, res) => {
    const a = authenticate(req, res, false); // Bearer only; browser cookies are never accepted here
    if (a.row === null && "limited" in a && a.limited) {
      res.setHeader("Retry-After", String(a.limited.retryAfter));
      res.status(429).json({ jsonrpc: "2.0", error: { code: -32029, message: `Too many failed attempts, retry after ${a.limited.retryAfter}s` }, id: null });
      return;
    }
    const row = a.row;
    if (!row) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="personal-kanban"');
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: send Authorization: Bearer <token>" }, id: null });
      return;
    }
    const server = createMcpServer(repo, { name: row.name, kind: row.kind });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log(`mcp error: ${(e as Error).message}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  const mcpNotAllowed = (req: Request, res: Response) => {
    const a = authenticate(req, res, false);
    if (!a.row) {
      if ("limited" in a && a.limited) return tooMany(res, a.limited, { jsonrpc: "2.0", error: { code: -32029, message: "Too many failed attempts" }, id: null });
      res.setHeader("WWW-Authenticate", 'Bearer realm="personal-kanban"');
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    res.setHeader("Allow", "POST");
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)" }, id: null });
  };
  app.get("/mcp", mcpNotAllowed);
  app.delete("/mcp", mcpNotAllowed);

  // ───────────────────────── SPA ─────────────────────────
  if (o.webDir && fs.existsSync(path.join(o.webDir, "index.html"))) {
    app.use("/assets", express.static(path.join(o.webDir, "assets"), { immutable: true, maxAge: "1y", index: false }));
    app.use(express.static(o.webDir, { index: false, maxAge: "1h" }));
    const indexHtml = fs.readFileSync(path.join(o.webDir, "index.html"), "utf8");
    app.get(/^\/(?!api\/|mcp$).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.type("html").send(indexHtml);
    });
  }

  // ───────────────────────── errors ─────────────────────────
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "invalid", message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
      return;
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid_json", message: "Некорректный JSON" });
      return;
    }
    log(`error: ${e?.message}`);
    res.status(e?.status && e.status < 500 ? e.status : 500).json({ error: "internal", message: "Внутренняя ошибка" });
  });

  return app;
}
