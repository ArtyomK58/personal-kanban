/**
 * stdio MCP adapter: the same tools, talking to the same SQLite file directly.
 * Useful inside the container:  docker compose exec -T kanban node dist/server/mcp-stdio.js
 * Acts as agent named by MCP_AGENT_NAME (default "agent-stdio"). Access to the DB file = access to the board,
 * so this adapter is meant for processes that already run on the server.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { createMcpServer } from "./mcp.js";
import { Repo } from "./repo.js";

const cfg = loadConfig();
const repo = new Repo(openDb(cfg.dbFile));
const server = createMcpServer(repo, { name: process.env.MCP_AGENT_NAME || "agent-stdio", kind: "agent" });
await server.connect(new StdioServerTransport());
