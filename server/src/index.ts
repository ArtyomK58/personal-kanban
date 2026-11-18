import { createApp } from "./app.js";
import { Auth } from "./auth.js";
import { loadConfig, log } from "./config.js";
import { openDb } from "./db.js";
import { Repo } from "./repo.js";

const cfg = loadConfig();
const db = openDb(cfg.dbFile);
const repo = new Repo(db);
const auth = new Auth(db);
auth.bootstrap(cfg.dataDir, log);

const archiveDoneTasks = () => {
  try {
    const count = repo.archiveDoneTasks();
    if (count) log(`Автоматически завершено задач: ${count}`);
  } catch (e) {
    log(`Не удалось автоматически завершить задачи: ${(e as Error).message}`);
  }
};
archiveDoneTasks();
const archiveTimer = setInterval(archiveDoneTasks, 60_000).unref();

const app = createApp({ repo, auth, webDir: cfg.webDir, cookieSecure: cfg.cookieSecure, trustProxy: cfg.trustProxy, log });
const server = app.listen(cfg.port, cfg.host, () => log(`Канбан слушает http://${cfg.host}:${cfg.port} (MCP: /mcp, БД: ${cfg.dbFile})`));

const stop = () => {
  clearInterval(archiveTimer);
  log("остановка…");
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
