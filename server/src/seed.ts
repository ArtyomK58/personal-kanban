import type { Repo, Status } from "./repo.js";

/** Synthetic demo data (no real companies or tasks). Only runs on an empty board. */
export function seedDemo(repo: Repo): boolean {
  if (repo.listTasks({ limit: 1 }).length || repo.listTags().length) return false;
  const tags: [string, string][] = [
    ["Дом", "amber"], ["Портфолио", "blue"], ["Пет-бот", "teal"], ["Чтение", "violet"], ["Здоровье", "green"], ["Инфра", "slate"],
  ];
  for (const [n, c] of tags) repo.createTag(n, c);
  const day = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  const tasks: { t: string; s: Status; tags: string[]; d?: string; due?: string; c?: [string, "owner" | "agent", string][]; notes?: string }[] = [
    { t: "Починить кран на кухне", s: "inbox", tags: ["Дом"], due: day(3) },
    { t: "Купить лампы в коридор", s: "inbox", tags: ["Дом"] },
    { t: "Записаться к стоматологу", s: "inbox", tags: ["Здоровье"], due: day(-1) },
    { t: "Обновить зависимости", s: "inbox", tags: ["Инфра"], d: "Пройтись по `npm outdated`, обновить минорные версии, мажорные — отдельными задачами." },
    {
      t: "Добавить команду /remind", s: "in_progress", tags: ["Пет-бот"],
      d: "## Что нужно\n\nКоманда `/remind 30m купить хлеб` ставит напоминание.\n\n- [x] Парсер интервалов (`10m`, `2h`, `1d`)\n- [ ] Хранение в SQLite\n- [ ] Отправка по таймеру\n\n```\n/remind 2h позвонить маме\n```",
      c: [["Вы", "owner", "Интервалы больше недели не нужны."], ["claude", "agent", "Парсер готов, покрыт тестами. Дальше — таблица reminders и планировщик."]],
      notes: "План: таблица reminders(id, chat_id, fire_at, text). Планировщик — setInterval 30 с, выборка fire_at <= now.",
    },
    {
      t: "Переписать раздел «Обо мне»", s: "in_progress", tags: ["Портфолио"], due: day(5),
      d: "Короче и по делу: чем занимаюсь, 3 проекта, контакты. Без «люблю сложные задачи».",
    },
    {
      t: "Настроить бэкап SQLite в S3-совместимое хранилище", s: "in_progress", tags: ["Инфра", "Пет-бот"],
      d: "Ежедневно `sqlite3 .backup`, хранить 14 копий.", c: [["codex", "agent", "Скрипт бэкапа готов, жду ключи хранилища."]],
    },
    { t: "Дочитать «Designing Data-Intensive Applications», гл. 7", s: "in_progress", tags: ["Чтение"] },
    { t: "Сверстать страницу кейса", s: "review", tags: ["Портфолио"], d: "Макет в Figma, адаптив до 375px." , c: [["Вы", "owner", "Проверю на телефоне вечером."]] },
    { t: "Разобрать логи падений бота", s: "review", tags: ["Пет-бот"], c: [["claude", "agent", "Причина — таймаут Telegram API при 429. Добавил ретраи с backoff, нужен ревью."]] },
    { t: "Выбрать беговые кроссовки", s: "inbox", tags: ["Здоровье"] },
    { t: "Конспект: репликация и партиционирование", s: "review", tags: ["Чтение"] },
    { t: "Повесить полку в прихожей", s: "done", tags: ["Дом"] },
    { t: "Перенести домен на нового регистратора", s: "done", tags: ["Инфра", "Портфолио"] },
    { t: "Сделать /start с кнопками", s: "done", tags: ["Пет-бот"] },
  ];
  for (const x of tasks) {
    const s = repo.createTask({ title: x.t, status: x.s, tags: x.tags, human_description: x.d ?? "", due_date: x.due ?? null, place: "bottom", agent_notes: x.notes });
    for (const [author, kind, body] of x.c ?? []) repo.addComment(s.id, { author, author_kind: kind, body });
  }
  return true;
}
