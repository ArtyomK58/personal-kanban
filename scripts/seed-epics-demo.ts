// Synthetic board from the approved Claude Design artboards «Эпики — предложение» (+ a few priorities) — for local UI checks ONLY.
//   DB_FILE=/tmp/x/kanban.db npx tsx scripts/seed-epics-demo.ts
// Refuses to touch a non-empty board (never run against production).
import { openDb } from "../server/src/db.js";
import { Repo, type Status } from "../server/src/repo.js";

const file = process.env.DB_FILE;
if (!file) throw new Error("DB_FILE is required");
const repo = new Repo(openDb(file));
if (repo.listTasks({ limit: 1 }).length || repo.listTags().length) {
  console.error("board is not empty — nothing done");
  process.exit(1);
}
for (const [n, c] of [["Дом", "amber"], ["Портфолио", "blue"], ["Пет-бот", "teal"], ["Чтение", "violet"], ["Здоровье", "green"], ["Инфра", "slate"]] as const) repo.createTag(n, c);
const day = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const mk = (title: string, status: Status, tags: string[], extra: Record<string, unknown> = {}) =>
  repo.createTask({ title, status, tags, place: "bottom", ...extra });

const remind = mk("Напоминания", "in_progress", ["Пет-бот"], { kind: "epic", human_description: "Команда `/remind` и отправка по таймеру.\n\nГотово, когда повторяющиеся напоминания работают после перезапуска бота.", agent_notes: "Эпик: план по шагам в дочерних задачах." });
const backup = mk("Резервные копии", "inbox", ["Пет-бот"], {
  kind: "epic", due_date: day(14), priority: "high",
  human_description: "Ежедневная копия базы бота вне VPS и **проверенное** восстановление.\n\nЭпик закрыт, когда копия уходит в хранилище по таймеру, а восстановление проверено на чистой машине.",
});
const c1 = mk("Команда /remind с интервалами", "done", ["Пет-бот"], { epic_id: remind.id });
mk("Хранить напоминания в SQLite", "done", ["Пет-бот"], { epic_id: remind.id });
const timer = mk("Отправка по таймеру", "in_progress", ["Пет-бот"], { epic_id: remind.id, priority: "high", human_description: "Планировщик раз в 30 с." });
mk("Повторяющиеся напоминания", "inbox", ["Пет-бот"], { epic_id: remind.id, priority: "low", human_description: "cron-подобный синтаксис не нужен." });
mk("Скрипт бэкапа SQLite", "done", ["Пет-бот"], { epic_id: backup.id });
const s3 = mk("Загрузка в S3-совместимое хранилище", "review", ["Пет-бот", "Инфра"], {
  epic_id: backup.id, agent_notes: "Ключ хранилища только на запись.",
  human_description: "Загружать сжатую копию в бакет раз в сутки, хранить последние 14 копий.\n\n- [x] Ключ только на запись\n- [ ] Удаление старых копий правилом жизненного цикла\n\n```\nrclone copy /tmp/bot.db.gz backup:bot/\n```",
});
mk("Проверить восстановление на чистой машине", "inbox", ["Пет-бот"], { epic_id: backup.id });
mk("Обновить токен бота", "inbox", ["Пет-бот"]);
const logs = mk("Разобрать логи падений", "review", ["Пет-бот"], { human_description: "Причина — таймаут Telegram API." });
mk("Записаться к стоматологу", "inbox", ["Здоровье"], { due_date: day(-2), priority: "high" });
mk("Купить лампы в коридор", "inbox", ["Дом"], { priority: "low" });
mk("Переписать раздел «Обо мне»", "in_progress", ["Портфолио"], { human_description: "Короче и по делу." });
mk("Дочитать DDIA, гл. 7", "in_progress", ["Чтение"], { priority: "low" });
mk("Починить кран на кухне", "in_progress", ["Дом"]);
mk("Продлить домен", "review", ["Инфра"], { due_date: day(5) });
mk("Очень длинное название задачи, чтобы проверить перенос строк и обрезку на карточке и в списках эпика", "inbox", ["Чтение"]);
mk("Пустой эпик для проверки", "done", ["Чтение"], { kind: "epic" });
repo.addComment(timer.id, { author: "Вы", author_kind: "owner", body: "Интервалы больше недели не нужны." });
repo.addComment(timer.id, { author: "claude", author_kind: "agent", body: "Планировщик готов, жду ревью." });
repo.addComment(backup.id, { author: "Вы", author_kind: "owner", body: "Разбил на три шага. Восстановление проверяем последним." });
repo.addComment(backup.id, { author: "codex", author_kind: "agent", body: "Скрипт бэкапа готов, загрузку в хранилище отправил на проверку." });
repo.addComment(s3.id, { author: "codex", author_kind: "agent", body: "Загрузка работает, проверка контрольной суммы проходит." });
repo.addComment(logs.id, { author: "claude", author_kind: "agent", body: "Добавил ретраи с backoff." });
void c1;
console.log(`seeded: epics #${remind.id}, #${backup.id}`);
