// Live MCP smoke test against a running instance.
//   KANBAN_URL=http://127.0.0.1:8080 KANBAN_TOKEN=pk_... node scripts/mcp-smoke.mjs
// Never prints the token.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.env.KANBAN_URL ?? "http://127.0.0.1:8080";
const token = process.env.KANBAN_TOKEN;
if (!token) { console.error("KANBAN_TOKEN is required"); process.exit(2); }
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); if (!cond) process.exitCode = 1; };
const connect = async (tok) => {
  const c = new Client({ name: "kanban-smoke", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: tok ? { headers: { Authorization: `Bearer ${tok}` } } : {} }));
  return c;
};
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};

try { await connect(); ok("no token rejected", false); } catch (e) { ok("no token rejected", /401|Unauthorized/i.test(String(e)), String(e).slice(0, 80)); }
try { await connect("pk_bad"); ok("bad token rejected", false); } catch (e) { ok("bad token rejected", /401|Unauthorized/i.test(String(e))); }

const c = await connect(token);
ok("initialize", c.getServerVersion()?.name === "personal-kanban", JSON.stringify(c.getServerVersion()));
const tools = (await c.listTools()).tools;
ok("tools/list", tools.length >= 16, tools.map((t) => t.name).join(", "));
const TAG = "smoke-" + Date.now().toString(36);
const t = await call(c, "create_task", { title: "MCP smoke: проверка связи", tags: [TAG], create_missing_tags: true, human_description: "Создано агентом через MCP", agent_notes: "SMOKE-HIDDEN-NOTE" });
const listed = await call(c, "list_tasks", { tags: [TAG] });
ok("list_tasks by tag", listed.count === 1 && listed.tasks[0].id === t.id, `${listed.count} task(s) with ${TAG}`);
await call(c, "append_agent_notes", { id: t.id, text: "второй шаг" });
await call(c, "add_comment", { id: t.id, body: "Комментарий агента из smoke-теста" });
await call(c, "move_task", { id: t.id, status: "review", index: 0 });
const rest = await (await fetch(`${base}/api/tasks/${t.id}`, { headers: { Authorization: `Bearer ${token}` } })).text();
ok("UI/REST sees MCP task", rest.includes("MCP smoke: проверка связи") && rest.includes("Комментарий агента"));
ok("UI/REST payload has no agent notes", !rest.includes("SMOKE-HIDDEN-NOTE") && !rest.includes("agent_notes"));
await fetch(`${base}/api/tasks/${t.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ human_description: "Правка из UI/REST" }) });
const full = await call(c, "get_task", { id: t.id });
ok("MCP sees UI edit", full.human_description === "Правка из UI/REST" && full.status === "review");
ok("agent notes intact after UI edit", full.agent_view.agent_notes.startsWith("SMOKE-HIDDEN-NOTE") && full.agent_view.agent_notes.includes("второй шаг"));
console.log(`task id ${t.id}`);
await c.close();
if (process.env.SMOKE_CLEANUP !== "0") {
  const H = { Authorization: `Bearer ${token}` };
  await fetch(`${base}/api/tasks/${t.id}`, { method: "DELETE", headers: H });
  const tags = await (await fetch(`${base}/api/tags`, { headers: H })).json();
  for (const g of tags.filter((x) => x.name === TAG)) await fetch(`${base}/api/tags/${g.id}`, { method: "DELETE", headers: H });
  const left = await (await fetch(`${base}/api/board`, { headers: H })).json();
  ok("cleanup removed smoke task and tag", !left.tasks.some((x) => x.id === t.id) && !left.tags.some((x) => x.name === TAG));
}
