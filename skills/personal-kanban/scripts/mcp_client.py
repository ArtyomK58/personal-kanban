#!/usr/bin/env python3
"""Personal Kanban: official MCP SDK stdio bridge and direct-call fallback."""
import argparse
import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
import json
import logging
import os
from pathlib import Path
import stat
import sys

import httpx
from mcp import ClientSession, types
from mcp.client.streamable_http import streamable_http_client
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

URL = os.environ.get("PERSONAL_KANBAN_MCP_URL", "http://127.0.0.1:8080/mcp")
TOKEN_FILE = Path(os.environ.get("PERSONAL_KANBAN_TOKEN_FILE", str(Path.home() / ".codex/secrets/personal-kanban-codex.token")))
logging.basicConfig(level=logging.WARNING, stream=sys.stderr)


def credential():
    info = TOKEN_FILE.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError("Kanban agent credential must be a regular file with mode 0600")
    token = TOKEN_FILE.read_text().strip()
    if not token.startswith("pk_") or len(token) != 46:
        raise RuntimeError("Invalid Kanban agent credential format")
    return token


def failure_message(exc):
    pending = [exc]
    seen = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, httpx.HTTPStatusError):
            status = current.response.status_code
            retry = current.response.headers.get("Retry-After", "")
            if status == 429:
                wait = (" Retry-After=" + retry + " seconds.") if retry.isdigit() else " Respect Retry-After."
                return "Kanban MCP HTTP 429: rate limited." + wait
            if status in (401, 403):
                return "Kanban MCP HTTP " + str(status) + ": credential rejected; stop requests and check access."
            return "Kanban MCP HTTP " + str(status) + "."
        pending.extend(getattr(current, "exceptions", ()))
        if current.__cause__:
            pending.append(current.__cause__)
    return "Kanban MCP connection failed; check connectivity and the protected credential file."


@asynccontextmanager
async def upstream():
    async with httpx.AsyncClient(
        headers={"Authorization": "Bearer " + credential()},
        timeout=httpx.Timeout(45, connect=15),
        follow_redirects=False,
    ) as http:
        async with streamable_http_client(URL, http_client=http) as (read, write, _):
            async with ClientSession(
                read, write, read_timeout_seconds=timedelta(seconds=60),
                client_info=types.Implementation(name=os.environ.get("PERSONAL_KANBAN_CLIENT_NAME", "codex-personal-kanban"), version="1.1.0"),
            ) as session:
                initialized = await session.initialize()
                yield session, initialized


async def run(args):
    async with upstream() as (remote, initialized):
        if args.tools:
            result = await remote.list_tools()
            print(result.model_dump_json(exclude_none=True))
            return
        if args.call:
            params = json.load(sys.stdin)
            result = await remote.call_tool(args.call, params)
            print(result.model_dump_json(exclude_none=True))
            if result.isError:
                raise SystemExit(2)
            return

        server = Server(
            "personal-kanban", version="1.0.0",
            instructions=initialized.instructions,
        )

        @server.list_tools()
        async def list_tools():
            return (await remote.list_tools()).tools

        @server.call_tool()
        async def call_tool(name, arguments):
            # Forward exactly once. An interrupted write may already have committed.
            try:
                return await remote.call_tool(name, arguments)
            except Exception as exc:
                return types.CallToolResult(
                    isError=True,
                    content=[types.TextContent(
                        type="text",
                        text=failure_message(exc) + " A write may already have committed; read the task before retrying. No automatic retry was performed.",
                    )],
                )

        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--tools", action="store_true", help="Print live MCP tool schemas")
    modes.add_argument("--call", metavar="TOOL", help="Call an MCP tool with JSON arguments from stdin")
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    except SystemExit:
        raise
    except Exception as exc:
        # Never print the exception, HTTP headers, or credentials.
        print(failure_message(exc) + " No automatic retry was performed.", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
