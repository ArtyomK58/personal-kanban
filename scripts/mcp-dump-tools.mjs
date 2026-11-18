// Dump the live tool list (names, descriptions, JSON schemas) for docs.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "dump", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL(`${process.env.KANBAN_URL}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.KANBAN_TOKEN}` } } }));
const { tools } = await c.listTools();
const md = ["# MCP tools (generated from the running server)", "", "Instructions sent on initialize:", "", "```", c.getInstructions(), "```", ""];
for (const t of tools) {
  md.push(`## \`${t.name}\` — ${t.title ?? ""}`, "", t.description ?? "", "", "```json", JSON.stringify(t.inputSchema, null, 2), "```", "");
}
process.stdout.write(md.join("\n"));
await c.close();
