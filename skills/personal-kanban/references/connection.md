# Подключение Personal Kanban

MCP использует Streamable HTTP и Bearer-токен агента. Для локального экземпляра адрес `http://127.0.0.1:8080/mcp`. Для удалённого укажи свой HTTPS-адрес с путём `/mcp` либо используй локальный SSH-туннель.

## Нативный MCP

Подключи сервер под именем `personal-kanban`. Готовый шаблон для Codex есть в `examples/mcp/codex-config.toml` репозитория. В нём `bearer_token_env_var` содержит имя переменной окружения клиента, а значение хранится отдельно. Проверь `tools/list` и вызов `list_statuses`.

## Python-клиент и stdio-мост

Выдай отдельный агентский токен через CLI доски и сохрани его в файл с правами `0600`. Путь по умолчанию — `~/.codex/secrets/personal-kanban-codex.token`. Для другого пути задай `PERSONAL_KANBAN_TOKEN_FILE`.

Из каталога навыка:

```sh
python3 -m venv "$HOME/.local/share/personal-kanban/venv"
"$HOME/.local/share/personal-kanban/venv/bin/python" -m pip install -r scripts/requirements.txt
export PERSONAL_KANBAN_MCP_URL=http://127.0.0.1:8080/mcp
"$HOME/.local/share/personal-kanban/venv/bin/python" scripts/mcp_client.py --tools
```

Передай `--call list_statuses` и JSON-объект `{}` через stdin для отдельного вызова. Для stdio запускай тот же скрипт без аргументов, указывая абсолютные пути к Python и скрипту в настройках клиента. При 401 или 403 проверь адрес и файл токена до повторного вызова.
