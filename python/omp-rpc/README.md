# omp-rpc

Typed Python bindings for the `omp --mode rpc` stdio protocol.

The underlying OMP protocol is newline-delimited JSON over stdin/stdout. It is not JSON-RPC. This package is a convenience client: it owns the subprocess, correlates command responses, parses known event frames into Python dataclasses/typed dictionaries, and exposes Python callbacks for host-owned tools and URI schemes.

## What the Python helper provides

- typed command methods for the common RPC command surface
- startup options for `omp --mode rpc` flags such as model selection, thinking level, tool selection, prompt appends, provider session IDs, and session isolation
- typed protocol models for state, protocol/security posture, host surfaces, bash results, compaction, messages, todos, events, and session stats
- a process-backed client that manages request correlation over stdio
- per-event listeners plus catch-all notification and unknown-notification hooks
- lifecycle helpers: `prompt_and_wait()`, `wait_for_idle()`, and `collect_events()`
- extension UI request handling helpers for manual or headless operation
- host-tool helpers so Python hosts can expose JSON Schema tools to the agent
- host-URI helpers so Python hosts can expose virtual read/write URL schemes

## Basic usage

```python
from omp_rpc import RpcClient

with RpcClient(provider="anthropic", model="claude-sonnet-4-5") as client:
    state = client.get_state()
    print(state.model.id if state.model else "no model")

    turn = client.prompt_and_wait("Reply with just the word hello")
    print(turn.require_assistant_text())
```

`prompt_and_wait()` sends a `prompt` command, waits for a later `agent_end` event, and returns a `PromptTurn`. The command ACK itself is not completion.

## Launch options

By default the client starts:

```bash
omp --mode rpc --no-title
```

`--no-title` is added by default because `rpc_defaults=True` and `no_title` was not explicitly set.

```python
from omp_rpc import RpcClient

with RpcClient(
    model="openrouter/anthropic/claude-sonnet-4.6",
    thinking="high",
    no_session=True,
    no_skills=True,
    no_rules=True,
    tools=("read", "edit", "write"),
    append_system_prompt="Focus on reproducible benchmark behavior.",
) as client:
    print(client.get_state().thinking_level)
```

Constructor launch behavior:

- `executable="omp"` is used when `command` is omitted.
- `command=[...]` is used verbatim; wrapper flags such as `model=`, `no_session=`, and `tools=` are ignored when `command` is supplied.
- `provider`, `model`, `session_dir`, `thinking`, `append_system_prompt`, `provider_session_id`, `tools`, `no_session`, `no_skills`, `no_rules`, `no_title`, and `extra_args` are translated into CLI args when `command` is omitted.
- `tools=()` emits `--no-tools`; a non-empty tuple emits `--tools a,b,c`.
- `cwd`, `env`, `user`, `group`, and `extra_groups` are passed to `subprocess.Popen`; `env` is merged with `os.environ`.
- `startup_timeout` bounds waiting for the `ready` frame. `request_timeout` bounds individual request/response commands.

Repo-local development example:

```python
from omp_rpc import RpcClient

with RpcClient(
    command=[
        "bun",
        "packages/coding-agent/src/cli.ts",
        "--mode",
        "rpc",
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4-5",
    ],
) as client:
    print(client.get_state().session_id)
```

## Helper behavior vs raw protocol behavior

The raw OMP protocol is a bidirectional frame stream. The Python helper is request/response and callback oriented:

- `_request(...)`/typed methods generate `req_N` ids and wait for matching `response` frames.
- `request_raw(command_type, **payload)` sends an arbitrary command envelope and returns that command's `data` object. It is not a raw-frame iterator.
- `request_raw("prompt", ...)` and `request_raw("abort_and_prompt", ...)` are ACK-only raw commands. They do not mark the client's prompt lifecycle counters, so `wait_for_idle()` may return before the turn completes. Use `prompt()`, `abort_and_prompt()`, or `prompt_and_wait()` when you need lifecycle tracking.
- The stdout reader thread consumes every frame internally, dispatching responses, host tool calls/cancellations, host URI requests/cancellations, then parsing the remaining frames as notifications/events.
- Known notifications are parsed into typed objects. Unknown non-special notifications are exposed through `on_unknown_notification(...)` as `UnknownNotification`.
- Id-less `parse` and unknown-command failures are correlated back to a pending request when the client can match them unambiguously. Unmatched protocol errors are retained in `client.protocol_errors` and sent to `on_protocol_error(...)`.

Use a lower-level subprocess reader if you need every wire frame exactly as emitted.

## Prompt lifecycle and events

```python
from omp_rpc import MessageUpdateEvent, RpcClient


def on_message_update(event: MessageUpdateEvent) -> None:
    assistant_event = event.assistant_message_event
    if assistant_event.get("type") == "text_delta":
        print(assistant_event["delta"], end="", flush=True)


with RpcClient(model="openrouter/anthropic/claude-sonnet-4.6", no_session=True) as client:
    client.on_message_update(on_message_update)
    client.set_todos(
        [
            "Map the read and edit tool surface.",
            "Exercise the supported edit paths.",
            "Write concrete findings and gaps.",
        ]
    )
    turn = client.prompt_and_wait("Evaluate the current tool behavior.")
    print("\nfinal:", turn.assistant_text)
```

Lifecycle facts:

- `prompt()` and `abort_and_prompt()` return after the command response ACK and then mark an agent run as scheduled.
- `prompt_and_wait()` waits for the first subsequent `agent_end` and returns collected events/messages.
- `wait_for_idle()` returns immediately if no scheduled run is pending; otherwise it waits for `agent_end`.
- `collect_events()` waits for `agent_end` without sending a prompt.
- Only one of `prompt_and_wait()`, `wait_for_idle()`, or `collect_events()` may be active on a client at a time. Overlap raises `RpcConcurrencyError`.
- If a late async `prompt` / `abort_and_prompt` failure arrives, wait helpers raise instead of timing out.
- Event history is bounded by `max_event_history`; if a prompt would need trimmed events, the wait helper raises so the host can increase the limit.

Listener exceptions do not kill the stdout reader. They are recorded in `client.listener_errors` and emitted through `on_listener_error(...)`.

## Host-owned custom tools

RPC hosts can expose custom tools to the agent with JSON Schema metadata.

```python
from typing import TypedDict

from omp_rpc import RpcClient, host_tool


class EchoArgs(TypedDict):
    message: str


def echo_host(args: EchoArgs, context) -> str:
    context.send_update(f"working:{args['message']}")
    return f"host:{args['message']}"


with RpcClient(
    no_session=True,
    custom_tools=(
        host_tool(
            name="echo_host",
            description="Echo a value from the Python host",
            parameters={
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
                "additionalProperties": False,
            },
            execute=echo_host,
        ),
    ),
) as client:
    client.prompt_and_wait("Use the echo_host tool with the value hello")
```

Host-tool helper behavior:

- `set_custom_tools()` before `start()` only stores definitions and returns local names.
- After `start()`, `set_custom_tools()` sends `set_host_tools` and returns normalized tool names from the server.
- The server emits `host_tool_call`; the Python client runs the handler in a daemon thread.
- `HostToolContext.send_update(...)` emits `host_tool_update` unless the call was cancelled.
- Return strings are normalized into text `host_tool_result` frames. Rich result dictionaries are also accepted.
- Exceptions become `host_tool_result` frames with `isError: true`.
- `host_tool_cancel` is cooperative: the context cancellation flag is set, and late updates/final results are suppressed.

Pass `decode=` to `host_tool(...)` when you want to convert the incoming JSON argument object into a dataclass/model before execution.

## Host-owned URI schemes

Hosts can expose virtual files through custom URL schemes. Registered schemes are routed through the agent's `read` tool, and writable schemes through the `write` tool with full replacement content.

```python
from omp_rpc import RpcClient, host_uri

rows: dict[str, str] = {"42": "id=42\nname=Alice\n"}


def read_row(url: str, _ctx) -> str:
    row_id = url.removeprefix("db://users/")
    return rows[row_id]


def write_row(url: str, content: str, _ctx) -> None:
    row_id = url.removeprefix("db://users/")
    rows[row_id] = content


with RpcClient(
    no_session=True,
    host_uris=(
        host_uri(
            scheme="db",
            description="Virtual db row files",
            read=read_row,
            write=write_row,
        ),
    ),
) as client:
    client.prompt_and_wait("Read db://users/42 and rewrite it with name=Bob")
```

Host-URI helper behavior:

- `host_uri(...)` trims/lowercases the scheme and rejects an empty scheme.
- A scheme is sent as writable only when a `write=` handler is provided.
- `set_host_uris()` before `start()` stores definitions locally; after `start()` it sends `set_host_uri_schemes`.
- Read handlers may return a string or a mapping with `content`, optional `content_type`, optional `notes`, and optional `immutable`.
- Allowed content types are `text/markdown`, `application/json`, and `text/plain`.
- Write handlers receive `(url, content, context)`; missing wire content is treated as an empty string.
- Handler exceptions produce `host_uri_result` with `isError: true`.
- `host_uri_cancel` sets `HostUriContext.cancelled` cooperatively and suppresses late responses.

Read-only schemes reject `write` calls with an error. The agent's `edit` tool does not target host URIs; hosts that want mutation expose `write`, and the model uses the `write` tool with complete replacement content.

## Extension UI requests

Extensions can ask the host for input or report passive UI state. Typed `ExtensionUiRequest` methods currently accepted by the Python parser are:

- Response-requiring: `select`, `confirm`, `input`, `editor`, `cancel`
- Passive/event-style: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, `open_url`

Manual handling:

```python
request = client.next_ui_request(timeout=5.0)

if request.method == "confirm":
    client.send_ui_confirmation(request.id, True)
elif request.method in {"input", "editor", "select"}:
    client.send_ui_value(request.id, "approved")
```

Headless policy:

```python
with RpcClient(model="anthropic/claude-sonnet-4-5") as client:
    client.install_headless_ui()
    turn = client.prompt_and_wait("needs ui-safe automation")
    print(turn.assistant_text)
```

`install_headless_ui()` ignores passive UI notifications (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, `open_url`), answers `confirm` with `False` by default, and cancels `select`/`input`/`editor` unless explicit values are supplied.

OAuth/login flows are supported when the server exposes provider commands:

```python
with RpcClient() as client:
    providers = client.get_login_providers()
    if providers:
        client.login(providers[0]["id"])
```

## Error handling and retained history

The client surfaces protocol edge cases instead of hiding them:

- id-less `parse` and unknown-command failures are correlated back to a waiting request when possible
- late `prompt` / `abort_and_prompt` scheduling failures cause `prompt_and_wait()` and `wait_for_idle()` to raise
- unmatched background error responses are exposed through `client.protocol_errors` and `client.on_protocol_error(...)`
- listener exceptions are exposed through `client.listener_errors` and `client.on_listener_error(...)`

For long-lived hosts, retained event and stderr history is bounded by default:

```python
from omp_rpc import RpcClient

with RpcClient(max_event_history=20_000, max_stderr_chunks=256) as client:
    ...
```

If a single prompt streams more events than `max_event_history` allows, `prompt_and_wait()` raises a clear error so hosts can increase the limit.

## Text helpers

`assistant_text()` and `message_text()` return visible text blocks only. If a host needs reasoning text too, use the `*_with_thinking` helpers:

```python
from omp_rpc import assistant_text, assistant_text_with_thinking

visible = assistant_text(message)
full = assistant_text_with_thinking(message)
```

## Known non-claims and limitations

- This helper does not expose a public iterator over raw stdout frames.
- `request_raw(...)` is command/response oriented and returns response data only.
- Prompt completion is event-driven; ACK frames are not completion.
- Lifecycle collection is single-flight per client instance.
- Host tool/URI cancellation is cooperative.
- The parsed Python `SessionState` preserves the RPC-visible protocol, capabilities, limits, reset profile, security posture, active operations, host tool definitions, and host URI schemes; raw future fields remain available through callbacks/raw payloads rather than typed attributes.
- Typed extension UI support includes `open_url` as a passive notification; login helpers are available through `get_login_providers()` and `login()` when the RPC server advertises those commands.

## Protocol reference

The canonical wire protocol lives in [`docs/rpc.md`](../../docs/rpc.md).
