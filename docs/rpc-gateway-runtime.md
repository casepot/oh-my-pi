# RPC Gateway Runtime Notes

Gateway runtimes embedding OMP should use the versioned RPC contract rather than source or incidental frame-order inference.

## Probe

Use a deterministic one-shot probe during startup or descriptor refresh:

```bash
omp --mode rpc --no-session --no-skills --no-rules --no-title --rpc-one-shot get_protocol_info
```

Require:

- first frame `type: "ready"`
- `protocol.name === "omp-rpc"`
- supported `protocol.version` and `schemaVersion`
- monotonic `seq`, ISO `timestamp`, stable `sessionId`
- `get_protocol_info.data` matching ready protocol/server/mode/capabilities/limits/reset/security
- final `shutdown` with `status: "one_shot_complete"`

## Descriptor derivation

Build gateway descriptors from `ready.capabilities` / `get_protocol_info`:

- supported commands
- operation event support
- typed error support
- host tool/URI support
- extension UI support
- session graph/task event support
- limits and default deadlines
- security/authority posture

Do not hardcode workstation-local OMP paths. The gateway host chooses the `omp` executable or package path at deployment time.

## Terminal evidence

A long command is terminally observed only when the gateway sees the correlated operation terminal frame:

- `operation_end` => completed evidence
- `operation_error.status === "cancelled"` or `errorInfo.code === "operation_cancelled"` => cancellation evidence
- `operation_error.status === "peer_closed"` or `errorInfo.code === "peer_closed"` => peer-closed evidence
- ACK response alone is never terminal evidence

The request id, operation id, command, status, timestamps, and terminal data/errorInfo should be preserved in gateway evidence records.

## Error classification

Classify recoverable failures by `errorInfo.code`:

- malformed input: `invalid_json`, `invalid_frame`, `invalid_arguments`, `unknown_command`
- capability mismatch: `unsupported_capability`
- operation lifecycle: `operation_not_found`, `operation_cancelled`, `operation_timeout`, `peer_closed`
- host surfaces: `host_tool_*`, `host_uri_*`
- model/session: `model_not_found`, `session_not_found`
- fallback: `internal_error`

Legacy `error` strings remain for human display only.

## Fail-closed stream handling

Fail closed on:

- malformed stdout JSON
- missing ready
- decreasing/non-integer `seq`
- non-ISO timestamps
- mismatched session identity within one process without a state/session transition explaining it
- duplicated terminal frame for one operation id
- terminal frame before `operation_start` for an accepted operation
- operation ACK without a terminal frame before process exit
- frames exceeding advertised limits

Tolerate additive unknown fields and unknown future frame types by preserving raw frames and surfacing them as unknown-frame events.
