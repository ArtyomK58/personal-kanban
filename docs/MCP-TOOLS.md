# MCP tools (generated from the running server)

Instructions sent on initialize:

```
Personal kanban board of the owner (all projects on one board, a project = a tag).
Every task has TWO independent text fields:
- human_description: Markdown the OWNER reads in the web UI. Change it only when the owner should see the change.
- agent_notes: private scratchpad for agents. It is NEVER shown in the web UI, not searchable there, and is stored
  separately. Use get_agent_notes / set_agent_notes / append_agent_notes for your working notes, plans, findings.
Editing one field never changes the other. Statuses: inbox (Входящие), in_progress (В работе), review (На проверке), done (Готово), done_final (Готово окончательно).
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
Priority: every task and epic has priority low (Низкий), normal (Обычный), high (Высокий); default "normal".
Set it with create_task/update_task(priority=…), filter with list_tasks/list_epics(priority=…). Priority is independent
of status, saved position and the epic/children (no inheritance). The UI groups active cards by priority.
Frozen cards are marked with a snowflake and go below all active cards in their board column. Set frozen=true
to freeze or frozen=false to unfreeze with update_task. This preserves status and priority. list_tasks accepts frozen
as an optional filter.
```

## `list_tasks` — List / search tasks

List tasks on the board, optionally filtered by tags (projects), status and a full-text query over title, human_description and comments (agent_notes are not searched). Returns summaries ordered by column and position.

```json
{
  "type": "object",
  "properties": {
    "tags": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 40
      },
      "description": "Tag (project) names, case-insensitive"
    },
    "tag_match": {
      "default": "any",
      "description": "any = at least one tag (UI semantics), all = every tag",
      "type": "string",
      "enum": [
        "any",
        "all"
      ]
    },
    "status": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "inbox",
            "in_progress",
            "review",
            "done",
            "done_final"
          ],
          "description": "Status filter, including the hidden done_final status"
        },
        {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "inbox",
              "in_progress",
              "review",
              "done",
              "done_final"
            ],
            "description": "Status filter, including the hidden done_final status"
          }
        }
      ]
    },
    "query": {
      "description": "Full-text query, prefix matching per word",
      "type": "string",
      "maxLength": 200
    },
    "kind": {
      "description": "Only ordinary tasks (\"task\") or only epics (\"epic\")",
      "type": "string",
      "enum": [
        "task",
        "epic"
      ]
    },
    "priority": {
      "description": "Only these priorities (filter; the order stays column + manual position)",
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "low",
            "normal",
            "high"
          ],
          "description": "Priority: low=Низкий, normal=Обычный, high=Высокий"
        },
        {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "low",
              "normal",
              "high"
            ],
            "description": "Priority: low=Низкий, normal=Обычный, high=Высокий"
          }
        }
      ]
    },
    "frozen": {
      "description": "Filter by frozen state",
      "type": "boolean"
    },
    "epic_id": {
      "description": "Tasks of this epic, or \"none\" = ordinary tasks without an epic",
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "description": "Number of an epic (a task with kind=epic)"
        },
        {
          "type": "string",
          "const": "none"
        }
      ]
    },
    "include_epic": {
      "default": false,
      "description": "With a numeric epic_id: also return the epic itself (like the UI filter)",
      "type": "boolean"
    },
    "limit": {
      "default": 200,
      "type": "integer",
      "minimum": 1,
      "maximum": 500
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `get_task` — Get a task

Full task: title, status, kind, parent epic, tags, due date, human_description (visible to the owner), comments, and — clearly separated — agent_notes (hidden from the UI). For an epic also progress and children. Set include_agent_notes=false to skip them.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "description": "Task number, e.g. 42 for #42"
    },
    "include_agent_notes": {
      "default": true,
      "type": "boolean"
    }
  },
  "required": [
    "id"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `create_task` — Create a task

Create a task or an epic (kind='epic'). human_description is shown to the owner; agent_notes stay hidden from the UI. epic_id puts a new ordinary task into an epic. New cards go to the top of the column unless place='bottom'.

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "status": {
      "default": "inbox",
      "type": "string",
      "enum": [
        "inbox",
        "in_progress",
        "review",
        "done"
      ],
      "description": "Destination column on the board"
    },
    "human_description": {
      "type": "string",
      "maxLength": 200000
    },
    "agent_notes": {
      "type": "string",
      "maxLength": 200000
    },
    "tags": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 40
      },
      "description": "Tag (project) names, case-insensitive"
    },
    "create_missing_tags": {
      "default": false,
      "description": "Create tags that do not exist yet",
      "type": "boolean"
    },
    "due_date": {
      "description": "YYYY-MM-DD",
      "anyOf": [
        {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "place": {
      "default": "top",
      "type": "string",
      "enum": [
        "top",
        "bottom"
      ]
    },
    "kind": {
      "default": "task",
      "type": "string",
      "enum": [
        "task",
        "epic"
      ],
      "description": "\"task\" = ordinary task, \"epic\" = epic (groups tasks)"
    },
    "epic_id": {
      "description": "Parent epic for a new ordinary task",
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "description": "Number of an epic (a task with kind=epic)"
        },
        {
          "type": "null"
        }
      ]
    },
    "priority": {
      "default": "normal",
      "type": "string",
      "enum": [
        "low",
        "normal",
        "high"
      ],
      "description": "Priority: low=Низкий, normal=Обычный, high=Высокий"
    },
    "frozen": {
      "type": "boolean"
    }
  },
  "required": [
    "title"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `update_task` — Update task fields

Partial update of title, status, due date, priority, frozen state, kind and parent epic (works for tasks and epics). Omitted fields keep their values. kind='epic' turns a task without an epic into an epic; kind='task' turns an epic without children back. epic_id=null detaches. Does not touch tags, human_description or agent_notes (use the dedicated tools).

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "description": "Task number, e.g. 42 for #42"
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "status": {
      "type": "string",
      "enum": [
        "inbox",
        "in_progress",
        "review",
        "done"
      ],
      "description": "Destination column on the board"
    },
    "due_date": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "kind": {
      "type": "string",
      "enum": [
        "task",
        "epic"
      ],
      "description": "\"task\" = ordinary task, \"epic\" = epic (groups tasks)"
    },
    "epic_id": {
      "description": "Parent epic; null = remove from its epic",
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "description": "Number of an epic (a task with kind=epic)"
        },
        {
          "type": "null"
        }
      ]
    },
    "priority": {
      "type": "string",
      "enum": [
        "low",
        "normal",
        "high"
      ],
      "description": "Priority: low=Низкий, normal=Обычный, high=Высокий"
    },
    "frozen": {
      "description": "true freezes the card; false unfreezes it",
      "type": "boolean"
    }
  },
  "required": [
    "id"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `update_human_description` — Update the human-visible description

Change human_description (Markdown the owner sees). mode=replace overwrites it, mode=append adds a paragraph at the end. agent_notes are never affected.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "description": "Task number, e.g. 42 for #42"
    },
    "text": {
      "type": "string",
      "maxLength": 200000
    },
    "mode": {
      "default": "replace",
      "type": "string",
      "enum": [
        "replace",
        "append"
      ]
    }
  },
  "required": [
    "id",
    "text"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `get_agent_notes` — Read agent notes

Read the hidden agent_notes of a task (never shown in the web UI).

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "description": "Task number, e.g. 42 for #42"
    }
  },
  "required": [
    "id"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `set_agent_notes` — Replace agent notes

Overwrite the hidden agent_notes of a task. human_description is not changed.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "description": "Task number, e.g. 42 for #42"
    },
    "text": {
      "type": "string",
      "maxLength": 200000
    }
  },
  "required": [
    "id",
    "text"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `append_agent_notes` — Append to agent notes

Append a timestamped entry (with your agent name) to the hidden agent_notes. human_description is not changed.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "description": "Task number, e.g. 42 for #42"
    },
    "text": {
      "type": "string",
      "minLength": 1,
      "maxLength": 50000
    }
  },
  "required": [
    "id",
    "text"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `move_task` — Move / reorder a task

Move a task to a column and/or position. Give before_id or after_id (a task in the target column) or index (0 = top). With only status, the task goes to the top of that column.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "description": "Task number, e.g. 42 for #42"
    },
    "status": {
      "type": "string",
      "enum": [
        "inbox",
        "in_progress",
        "review",
        "done"
      ],
      "description": "Destination column on the board"
    },
    "before_id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "after_id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "index": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `list_comments` — List comments

Comments of a task (visible to the owner), oldest first.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "description": "Task number, e.g. 42 for #42"
    }
  },
  "required": [
    "id"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `add_comment` — Add a comment

Add a comment the owner will see in the task's comment thread. Authored by your token's name and marked as an agent.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "description": "Task number, e.g. 42 for #42"
    },
    "body": {
      "type": "string",
      "minLength": 1,
      "maxLength": 50000
    }
  },
  "required": [
    "id",
    "body"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `list_tags` — List tags

All tags (projects) with colors and task counts.

```json
{
  "type": "object",
  "properties": {},
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `create_tag` — Create a tag

Create a tag (project). Colors: slate, blue, teal, green, amber, orange, rose, violet; omitted = next free color.

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 40
    },
    "color": {
      "type": "string",
      "enum": [
        "slate",
        "blue",
        "teal",
        "green",
        "amber",
        "orange",
        "rose",
        "violet"
      ]
    }
  },
  "required": [
    "name"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `assign_tags` — Assign tags to a task

Add tags to a task (existing tags are kept).

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "description": "Task number, e.g. 42 for #42"
    },
    "tags": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 40
      },
      "description": "Tag (project) names, case-insensitive"
    },
    "create_missing": {
      "default": false,
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "tags"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `unassign_tags` — Remove tags from a task

Remove tags from a task. Unknown names are ignored.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "description": "Task number, e.g. 42 for #42"
    },
    "tags": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 40
      },
      "description": "Tag (project) names, case-insensitive"
    }
  },
  "required": [
    "id",
    "tags"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `list_epics` — List epics

All epics with status, priority, project tags and progress {done,total}. Optional filters by status, priority, tags (any) and a full-text query.

```json
{
  "type": "object",
  "properties": {
    "status": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "inbox",
            "in_progress",
            "review",
            "done",
            "done_final"
          ],
          "description": "Status filter, including the hidden done_final status"
        },
        {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "inbox",
              "in_progress",
              "review",
              "done",
              "done_final"
            ],
            "description": "Status filter, including the hidden done_final status"
          }
        }
      ]
    },
    "priority": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "low",
            "normal",
            "high"
          ],
          "description": "Priority: low=Низкий, normal=Обычный, high=Высокий"
        },
        {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "low",
              "normal",
              "high"
            ],
            "description": "Priority: low=Низкий, normal=Обычный, high=Высокий"
          }
        }
      ]
    },
    "tags": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 40
      },
      "description": "Tag (project) names, case-insensitive"
    },
    "query": {
      "type": "string",
      "maxLength": 200
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `get_epic` — Get an epic with its tasks

An epic: fields, human_description, comments, progress and its tasks (children, ordered by column and position). Errors if the number is not an epic. include_agent_notes adds the epic's own hidden agent_notes.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "description": "Number of an epic (a task with kind=epic)"
    },
    "include_agent_notes": {
      "default": false,
      "type": "boolean"
    }
  },
  "required": [
    "id"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `set_task_epic` — Attach / move / detach a task to an epic

Put an ordinary task into an epic (or move it to another epic), or remove it from its epic with epic_id=null. Tags, texts, status and position are not changed. Epics cannot be put into epics.

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991,
      "description": "Task number, e.g. 42 for #42"
    },
    "epic_id": {
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991,
          "description": "Number of an epic (a task with kind=epic)"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "epic_id"
  ],
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

## `list_statuses` — List statuses

The board's columns in order, followed by the hidden automatic final status.

```json
{
  "type": "object",
  "properties": {},
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```
