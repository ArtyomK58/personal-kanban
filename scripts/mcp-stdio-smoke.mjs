// stdio adapter smoke: spawns the given command (e.g. docker compose exec -T kanban node dist/server/mcp-stdio.js)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [command, ...args] = process.argv.slice(2);
const c = new Client({ name: "stdio-smoke", version: "1.0.0" });
await c.connect(new StdioClientTransport({ command, args, stderr: "inherit" }));
const tools = (await c.listTools()).tools.length;
const r = await c.callTool({ name: "list_tasks", arguments: { status: "review" } });
const data = JSON.parse(r.content[0].text);
console.log(`${tools >= 16 && data.count > 0 ? "PASS" : "FAIL"} stdio: ${tools} tools, ${data.count} tasks in review`);
await c.close();
