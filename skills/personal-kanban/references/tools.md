# MCP personal-kanban: параметры

Источник истины — live `tools/list`; сохранённые полные схемы в [tools.json](tools.json).
Все изменения выполняются только в объёме поручения. Токены клиент подставляет сам.

| Инструмент | Аргументы |
|---|---|
| list_statuses | `{}` |
| list_tags | `{}` |
| list_tasks | `tags?:string[], tag_match?:"any"\|"all", status?:string\|string[], query?:string, kind?:"task"\|"epic", epic_id?:number\|"none", include_epic?:boolean, frozen?:boolean, priority?:string\|string[], limit?:1..500` |
| get_task | `id:number, include_agent_notes?:boolean` (по умолчанию true) |
| create_task | `title, status?, human_description?, agent_notes?, tags?, create_missing_tags?:boolean, due_date?, place?:"top"\|"bottom", kind?:"task"\|"epic", epic_id?:number\|null, priority?:string, frozen?:boolean` |
| update_task | `id, title?, status?, due_date?, kind?:"task"\|"epic", epic_id?:number\|null, priority?:string, frozen?:boolean` |
| list_epics | `status?:string\|string[], tags?:string[], query?:string, priority?:string\|string[]` |
| get_epic | `id, include_agent_notes?:boolean` (по умолчанию false) |
| set_task_epic | `id, epic_id:number\|null` (оба обязательны) |
| update_human_description | `id, text, mode?:"replace"\|"append"` (по умолчанию replace) |
| get_agent_notes | `id` |
| set_agent_notes | `id, text` |
| append_agent_notes | `id, text` |
| move_task | `id, status?, before_id?, after_id?, index?` |
| list_comments | `id` |
| add_comment | `id, body` |
| create_tag | `name, color?` |
| assign_tags | `id, tags:string[], create_missing?:boolean` (по умолчанию false) |
| unassign_tags | `id, tags:string[]` |

Ручные статусы: `inbox`, `in_progress`, `review`, `done`. Фильтр статуса также понимает скрытый автоматический `done_final`.
Приоритет: только `low`, `normal`, `high` (при создании default `normal`); фильтр принимает одно значение или массив. На доске приоритет определяет группу карточек внутри колонки. Статус и даты сохраняются.
Срок: `YYYY-MM-DD`; `null` очищает срок.
Порядок: указывать один из `before_id`, `after_id` или `index`; опорная карточка должна быть в целевой колонке. При одном `status` задача попадает в начало колонки.
Цвета: `slate, blue, teal, green, amber, orange, rose, violet`.

## Типовые вызовы

Найти открытые задачи проекта:
```json
{"tags":["Инфра"],"tag_match":"any","status":["inbox","in_progress","review"],"limit":100}
```

Создать задачу с разделёнными описаниями (`create_task`):
```json
{"title":"Проверить восстановление резервной копии","tags":["Инфра"],"human_description":"Восстановить копию в отдельном окружении и подтвердить целостность данных.","agent_notes":"Сначала уточнить расположение действующего backup. Production данные не менять."}
```

Сохранить рабочий контекст (`append_agent_notes`):
```json
{"id":42,"text":"Проверено: ...\nОсталось: ...\nСледующий шаг: ..."}
```

Дополнить видимое описание (`update_human_description`):
```json
{"id":42,"mode":"append","text":"Результат проверки: ..."}
```

Создать эпик (`create_task`):
```json
{"title":"Резервные копии","kind":"epic","tags":["Инфра"],"human_description":"Автоматическая копия и проверенное восстановление."}
```

Привязать существующую задачу (`set_task_epic`):
```json
{"id":43,"epic_id":42}
```

Для снятия связи передай `epic_id:null`; для выбора задач без эпика в `list_tasks` — `epic_id:"none"`. Получить эпик и детей одной выборкой: `list_tasks{"epic_id":42,"include_epic":true}`.

## Локальный runtime

Установка Python-клиента описана в [connection.md](connection.md).
