import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AppError, BOARD_STATUS_IDS, PRIORITIES, PRIORITY_IDS, Repo, STATUSES, STATUS_IDS, TAG_COLORS, TASK_KINDS } from "./repo.js";

export const MCP_SERVER_NAME = "personal-kanban";
export const MCP_SERVER_VERSION = "0.3.0";

const INSTRUCTIONS = `Personal kanban board of the owner (all projects on one board, a project = a tag).
Every task has TWO independent text fields:
- human_description: Markdown the OWNER reads in the web UI. Change it only when the owner should see the change.
- agent_notes: private scratchpad for agents. It is NEVER shown in the web UI, not searchable there, and is stored
  separately. Use get_agent_notes / set_agent_notes / append_agent_notes for your working notes, plans, findings.
Editing one field never changes the other. Statuses: ${STATUSES.map((s) => `${s.id} (${s.label})`).join(", ")}.
The server changes ordinary tasks from "done" to "done_final" after one calendar month. The final status
is hidden on the board and can be read or filtered via MCP. Changing it to a board status reopens the task.
Comments are visible to the owner in the UI; your comments are marked as written by an agent.
Tag filter semantics: tag_match "any" (default, same as the UI) = task has at least one of the tags; "all" = every tag.
Epics: a task has kind "task" (default) or "epic". An epic is a card on the same board with its own manual status;
it groups ordinary tasks. A task belongs to at most ONE epic (epic_id); epics cannot be nested; a project is still a tag
(an epic is NOT a tag). Every task/epic in results carries kind, epic_id, epic {id,title} and, for epics,
progress {done,total} = children in "done" or "done_final" / all children (the epic's status is manual).
Use create_task(kind="epic") to create an epic, set_task_epic to attach/move/detach a task, list_epics / get_epic to
browse, list_tasks(epic_id=…) to filter. Attaching never changes the task's tags or texts.
Priority: every task and epic has priority ${PRIORITIES.map((p) => `${p.id} (${p.label})`).join(", ")}; default "normal".
Set it with create_task/update_task(priority=…), filter with list_tasks/list_epics(priority=…). Priority is independent
of status, saved position and the epic/children (no inheritance). The UI groups active cards by priority.
Frozen cards are marked with a snowflake and go below all active cards in their board column. Set frozen=true
to freeze or frozen=false to unfreeze with update_task. This preserves status and priority. list_tasks accepts frozen
as an optional filter.`;

type Actor = { name: string; kind: "owner" | "agent" };

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

function wrap<A>(fn: (args: A) => unknown) {
  return async (args: A) => {
    try {
      return json(await fn(args));
    } catch (e) {
      const msg = e instanceof AppError ? `${e.code}: ${e.message}` : `internal_error: ${(e as Error).message}`;
      return { isError: true, content: [{ type: "text" as const, text: msg }] };
    }
  };
}

const taskId = z.number().int().positive().describe("Task number, e.g. 42 for #42");
const status = z.enum(STATUS_IDS).describe("Status filter, including the hidden done_final status");
const boardStatus = z.enum(BOARD_STATUS_IDS).describe("Destination column on the board");
const tagNames = z.array(z.string().min(1).max(40)).describe("Tag (project) names, case-insensitive");
const priority = z.enum(PRIORITY_IDS).describe(`Priority: ${PRIORITIES.map((p) => `${p.id}=${p.label}`).join(", ")}`);
const kind = z.enum(TASK_KINDS).describe('"task" = ordinary task, "epic" = epic (groups tasks)');
const epicRef = z.number().int().positive().describe("Number of an epic (a task with kind=epic)");

export function createMcpServer(repo: Repo, actor: Actor): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS, capabilities: { tools: {} } },
  );
  const author = actor.kind === "agent" ? actor.name : "Вы";

  server.registerTool(
    "list_tasks",
    {
      title: "List / search tasks",
      description:
        "List tasks on the board, optionally filtered by tags (projects), status and a full-text query over title, human_description and comments (agent_notes are not searched). Returns summaries ordered by column and position.",
      inputSchema: {
        tags: tagNames.optional(),
        tag_match: z.enum(["any", "all"]).default("any").describe("any = at least one tag (UI semantics), all = every tag"),
        status: z.union([status, z.array(status)]).optional(),
        query: z.string().max(200).optional().describe("Full-text query, prefix matching per word"),
        kind: kind.optional().describe('Only ordinary tasks ("task") or only epics ("epic")'),
        priority: z.union([priority, z.array(priority)]).optional().describe("Only these priorities (filter; the order stays column + manual position)"),
        frozen: z.boolean().optional().describe("Filter by frozen state"),
        epic_id: z.union([epicRef, z.literal("none")]).optional().describe('Tasks of this epic, or "none" = ordinary tasks without an epic'),
        include_epic: z.boolean().default(false).describe("With a numeric epic_id: also return the epic itself (like the UI filter)"),
        limit: z.number().int().min(1).max(500).default(200),
      },
      annotations: { readOnlyHint: true },
    },
    wrap((a: { tags?: string[]; tag_match: "any" | "all"; status?: any; query?: string; kind?: "task" | "epic"; priority?: any; frozen?: boolean; epic_id?: number | "none"; include_epic: boolean; limit: number }) => {
      const tasks = repo.listTasks({ tags: a.tags, tagMatch: a.tag_match, status: a.status, query: a.query, kind: a.kind, priority: a.priority, frozen: a.frozen, epicId: a.epic_id, includeEpic: a.include_epic, limit: a.limit });
      return { count: tasks.length, tasks };
    }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get a task",
      description:
        "Full task: title, status, kind, parent epic, tags, due date, human_description (visible to the owner), comments, and — clearly separated — agent_notes (hidden from the UI). For an epic also progress and children. Set include_agent_notes=false to skip them.",
      inputSchema: { id: taskId, include_agent_notes: z.boolean().default(true) },
      annotations: { readOnlyHint: true },
    },
    wrap((a: { id: number; include_agent_notes: boolean }) => {
      const t = repo.getTask(a.id);
      const out: Record<string, unknown> = { ...t, url_path: `/t/${t.id}` };
      if (a.include_agent_notes) out.agent_view = repo.getAgentNotes(a.id);
      return out;
    }),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create a task",
      description: "Create a task or an epic (kind='epic'). human_description is shown to the owner; agent_notes stay hidden from the UI. epic_id puts a new ordinary task into an epic. New cards go to the top of the column unless place='bottom'.",
      inputSchema: {
        title: z.string().min(1).max(500),
        status: boardStatus.default("inbox"),
        human_description: z.string().max(200_000).optional(),
        agent_notes: z.string().max(200_000).optional(),
        tags: tagNames.optional(),
        create_missing_tags: z.boolean().default(false).describe("Create tags that do not exist yet"),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe("YYYY-MM-DD"),
        place: z.enum(["top", "bottom"]).default("top"),
        kind: kind.default("task"),
        epic_id: epicRef.nullable().optional().describe("Parent epic for a new ordinary task"),
        priority: priority.default("normal"),
        frozen: z.boolean().optional(),
      },
    },
    wrap((a: any) => repo.createTask(a)),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task fields",
      description:
        "Partial update of title, status, due date, priority, frozen state, kind and parent epic (works for tasks and epics). Omitted fields keep their values. kind='epic' turns a task without an epic into an epic; kind='task' turns an epic without children back. epic_id=null detaches. Does not touch tags, human_description or agent_notes (use the dedicated tools).",
      inputSchema: {
        id: taskId,
        title: z.string().min(1).max(500).optional(),
        status: boardStatus.optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        kind: kind.optional(),
        epic_id: epicRef.nullable().optional().describe("Parent epic; null = remove from its epic"),
        priority: priority.optional(),
        frozen: z.boolean().optional().describe("true freezes the card; false unfreezes it"),
      },
    },
    wrap((a: { id: number; title?: string; status?: any; due_date?: string | null; kind?: "task" | "epic"; epic_id?: number | null; priority?: any; frozen?: boolean }) =>
      repo.updateTask(a.id, { title: a.title, status: a.status, due_date: a.due_date, kind: a.kind, epic_id: a.epic_id, priority: a.priority, frozen: a.frozen }),
    ),
  );

  server.registerTool(
    "update_human_description",
    {
      title: "Update the human-visible description",
      description:
        "Change human_description (Markdown the owner sees). mode=replace overwrites it, mode=append adds a paragraph at the end. agent_notes are never affected.",
      inputSchema: { id: taskId, text: z.string().max(200_000), mode: z.enum(["replace", "append"]).default("replace") },
    },
    wrap((a: { id: number; text: string; mode: "replace" | "append" }) => {
      const s = a.mode === "append" ? repo.appendHumanDescription(a.id, a.text) : repo.updateTask(a.id, { human_description: a.text });
      return { ...s, human_description: repo.getTask(a.id).human_description };
    }),
  );

  server.registerTool(
    "get_agent_notes",
    {
      title: "Read agent notes",
      description: "Read the hidden agent_notes of a task (never shown in the web UI).",
      inputSchema: { id: taskId },
      annotations: { readOnlyHint: true },
    },
    wrap((a: { id: number }) => repo.getAgentNotes(a.id)),
  );

  server.registerTool(
    "set_agent_notes",
    {
      title: "Replace agent notes",
      description: "Overwrite the hidden agent_notes of a task. human_description is not changed.",
      inputSchema: { id: taskId, text: z.string().max(200_000) },
    },
    wrap((a: { id: number; text: string }) => repo.setAgentNotes(a.id, a.text)),
  );

  server.registerTool(
    "append_agent_notes",
    {
      title: "Append to agent notes",
      description: "Append a timestamped entry (with your agent name) to the hidden agent_notes. human_description is not changed.",
      inputSchema: { id: taskId, text: z.string().min(1).max(50_000) },
    },
    wrap((a: { id: number; text: string }) => repo.appendAgentNotes(a.id, a.text, actor.kind === "agent" ? actor.name : undefined)),
  );

  server.registerTool(
    "move_task",
    {
      title: "Move / reorder a task",
      description:
        "Move a task to a column and/or position. Give before_id or after_id (a task in the target column) or index (0 = top). With only status, the task goes to the top of that column.",
      inputSchema: {
        id: taskId,
        status: boardStatus.optional(),
        before_id: z.number().int().positive().optional(),
        after_id: z.number().int().positive().optional(),
        index: z.number().int().min(0).optional(),
      },
    },
    wrap((a: { id: number; status?: any; before_id?: number; after_id?: number; index?: number }) => {
      const hints = [a.before_id, a.after_id, a.index].filter((x) => x !== undefined).length;
      if (hints > 1) throw new AppError("invalid", "Use only one of before_id, after_id, index");
      return repo.moveTask(a.id, a);
    }),
  );

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description: "Comments of a task (visible to the owner), oldest first.",
      inputSchema: { id: taskId },
      annotations: { readOnlyHint: true },
    },
    wrap((a: { id: number }) => {
      repo.getSummary(a.id) ?? (() => { throw new AppError("not_found", `Задача #${a.id} не найдена`, 404); })();
      return repo.listComments(a.id);
    }),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add a comment",
      description: "Add a comment the owner will see in the task's comment thread. Authored by your token's name and marked as an agent.",
      inputSchema: { id: taskId, body: z.string().min(1).max(50_000) },
    },
    wrap((a: { id: number; body: string }) => repo.addComment(a.id, { body: a.body, author, author_kind: actor.kind })),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description: "All tags (projects) with colors and task counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(() => repo.listTags()),
  );

  server.registerTool(
    "create_tag",
    {
      title: "Create a tag",
      description: `Create a tag (project). Colors: ${TAG_COLORS.join(", ")}; omitted = next free color.`,
      inputSchema: { name: z.string().min(1).max(40), color: z.enum(TAG_COLORS).optional() },
    },
    wrap((a: { name: string; color?: string }) => repo.createTag(a.name, a.color)),
  );

  server.registerTool(
    "assign_tags",
    {
      title: "Assign tags to a task",
      description: "Add tags to a task (existing tags are kept).",
      inputSchema: { id: taskId, tags: tagNames.min(1), create_missing: z.boolean().default(false) },
    },
    wrap((a: { id: number; tags: string[]; create_missing: boolean }) => repo.assignTags(a.id, a.tags, a.create_missing)),
  );

  server.registerTool(
    "unassign_tags",
    {
      title: "Remove tags from a task",
      description: "Remove tags from a task. Unknown names are ignored.",
      inputSchema: { id: taskId, tags: tagNames.min(1) },
    },
    wrap((a: { id: number; tags: string[] }) => repo.unassignTags(a.id, a.tags)),
  );

  server.registerTool(
    "list_epics",
    {
      title: "List epics",
      description: "All epics with status, priority, project tags and progress {done,total}. Optional filters by status, priority, tags (any) and a full-text query.",
      inputSchema: {
        status: z.union([status, z.array(status)]).optional(),
        priority: z.union([priority, z.array(priority)]).optional(),
        tags: tagNames.optional(),
        query: z.string().max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    wrap((a: { status?: any; priority?: any; tags?: string[]; query?: string }) => {
      const epics = repo.listEpics({ status: a.status, priority: a.priority, tags: a.tags, query: a.query });
      return { count: epics.length, epics };
    }),
  );

  server.registerTool(
    "get_epic",
    {
      title: "Get an epic with its tasks",
      description: "An epic: fields, human_description, comments, progress and its tasks (children, ordered by column and position). Errors if the number is not an epic. include_agent_notes adds the epic's own hidden agent_notes.",
      inputSchema: { id: epicRef, include_agent_notes: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    wrap((a: { id: number; include_agent_notes: boolean }) => {
      const t = repo.getTask(a.id);
      if (t.kind !== "epic") throw new AppError("not_epic", `#${a.id} — обычная задача, не эпик`, 409);
      const out: Record<string, unknown> = { ...t, url_path: `/t/${t.id}` };
      if (a.include_agent_notes) out.agent_view = repo.getAgentNotes(a.id);
      return out;
    }),
  );

  server.registerTool(
    "set_task_epic",
    {
      title: "Attach / move / detach a task to an epic",
      description: "Put an ordinary task into an epic (or move it to another epic), or remove it from its epic with epic_id=null. Tags, texts, status and position are not changed. Epics cannot be put into epics.",
      inputSchema: { id: taskId, epic_id: epicRef.nullable() },
    },
    wrap((a: { id: number; epic_id: number | null }) => repo.setTaskEpic(a.id, a.epic_id)),
  );

  server.registerTool(
    "list_statuses",
    {
      title: "List statuses",
      description: "The board's columns in order, followed by the hidden automatic final status.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(() => STATUSES),
  );

  return server;
}
