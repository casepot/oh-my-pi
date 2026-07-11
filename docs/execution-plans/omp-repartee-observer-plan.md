## Context

OMP’s current `irc` tool routes direct agent messages through the process-global in-memory `IrcBus`; it does not expose a network IRC server or named channels. The requested end state is observation-only: 2–5 or more concurrent OMP processes, each with 3–10 active agents, attempt to publish every correctly attributed traffic leg into Repartee without rebuilding a frontend or allowing IRC input to control OMP; if the selected hard RAM bound forces loss, Repartee receives an explicit counted gap instead of silent omission. Main and all subagents belonging to one top-level OMP session share a Repartee channel, while `/new`, resume, fork, and distinct processes use their session’s own channel so unrelated conversations never mix. Observation remains fail-open and RAM-bounded—raw traffic is not spooled by OMP, and OMP delivery never waits on storage or the viewer.
## Implementation status — 2026-07-11

- Implemented the creation-time bus observer, immutable event snapshots, origin attribution, top-level session index, process-incarnated record/channel identity, bounded canonical parent lanes with emergency GAP accounting, child supervision/heartbeat, global-only secure configuration, native TLS IRC worker, lifecycle shutdown hooks, worker-host smoke probe, operator guide, and changelog entry.
- Added focused bus, attribution, settings, renderer, lifecycle-regression, source-worker, build, and compiled-worker verification. Test TLS fixtures include loopback IPv4/IPv6 SANs.
- Repository checks pass. The source and compiled `--smoke-test` probes pass after rebuilding the repository-native addon.
- Pinned live Ergo v2.18.0/Repartee v1.6.1 acceptance remains an operator-environment check; no Ergo or Repartee service is installed in this repository workspace.

## Approach

### 1. Add one canonical, creation-time bus observation event

In `packages/coding-agent/src/irc/bus.ts`, keep `IrcMessage` and `IrcDeliveryReceipt` unchanged and replace the inline `send` options type with:

```ts
export type IrcMessageOrigin = "tool" | "auto_reply" | "api";

export interface IrcSendOptions {
	expectsReply?: boolean;
	suppressRelay?: boolean;
	origin?: IrcMessageOrigin;
}

export interface IrcMessageCreatedEvent {
	readonly type: "message_created";
	readonly origin: IrcMessageOrigin;
	readonly message: Readonly<IrcMessage>;
}

export type IrcMessageCreatedListener = (
	event: IrcMessageCreatedEvent,
) => void | Promise<void>;
```

Add `IrcBus.observeMessages(listener: IrcMessageCreatedListener): () => void`. In `send(msg, options?: IrcSendOptions)`, immediately after the existing `Snowflake.next()`/`Date.now()` message construction, synchronously emit one frozen shallow snapshot with `origin: options?.origin ?? "api"`, before registry lookup, parked-agent revival, waiter resolution, or `deliverIrcMessage`. Snapshot the listener set; catch each synchronous throw; attach a rejection handler to a returned promise; continue later listeners; never await a listener; never log the message body. This creation seam minimizes the crash/delay window and preserves source acceptance order; do not add a receipt event because current receipts are immediate hand-off results, can await revival/session work, can reorder concurrent legs, and do not prove eventual consumption.

Update both production callers found by LSP: `IrcTool.#executeSend` in `packages/coding-agent/src/tools/irc.ts` passes `origin: "tool"` on direct and broadcast legs, and `AgentSession.#runIrcAutoReply` in `packages/coding-agent/src/session/agent-session.ts` passes `origin: "auto_reply"`. Direct SDK/API calls retain `"api"`. Preserve current broadcast semantics: an N-target `to:"all"` creates N events with N existing message IDs; zero targets create no `IrcMessage` and no observer event. Do not add a logical broadcast ID, move fan-out into `IrcBus`, or reuse the display-only `#relayToMainUi`.

### 2. Attribute every leg to its original top-level OMP session

Add an observer-owned session-attribution index under `packages/coding-agent/src/irc/observer/`; do not add fields to `AgentRef`, `IrcMessage`, persistence records, or the 100+ `AgentRegistry.register` callsites. The index subscribes to `AgentRegistry.onChange` before any root session is created and exposes:

```ts
export interface IrcObserverSessionIdentity {
	readonly rootAgentId: string;
	readonly rootSessionId: string;
	readonly rootSessionLabel?: string; // SessionManager.getSessionName()
}

bindTopLevel(agentId: string, session: AgentSession): void;
resolveRootSession(agentId: string): IrcObserverSessionIdentity | undefined;
resolveMessageSession(
	message: Pick<IrcMessage, "from" | "to">,
): IrcObserverSessionIdentity | undefined;
dispose(): void;
```

`bindTopLevel` uses `session.sessionManager.getSessionId()` and `getSessionName()`, never `session.sessionId` (the latter is provider-facing). For a top-level sender, resolve both live `SessionManager` values at observation time. On each non-main `registered` event, walk `parentId` links and snapshot the full `IrcObserverSessionIdentity` from the nearest bound top-level agent; descendants inherit the immediate parent’s snapshot. Never rewrite an existing descendant snapshot when Main runs `/new`, resume, or fork, so a late old subagent stays in its original channel while Main and newly registered descendants use the new session ID. Retain mappings across `idle`/`parked` detach/attach and status changes; overwrite only when the same agent ID emits a new `registered` incarnation. When a top-level bind occurs after SDK pre-registration, hydrate only still-unresolved descendants from the current registry. Bind every root returned by the `createSession` wrapper in `runRootCommand`, including each ACP root.

`resolveMessageSession` first requires a registered sender; an unregistered sender remains unscoped even when the target is known. Normally return the sender’s identity. The one override keeps a root’s post-switch traffic with its historical child: when `message.from` is a bound top-level root and `message.to` is a descendant of that same root (`target.rootAgentId === message.from` and `message.to !== message.from`), return the target’s snapshotted identity. Because broadcasts already fan out into direct legs, Main→old-child broadcasts and auto-replies route to the old channel while Main→new-child legs route to the new channel; descendant→root traffic uses the descendant snapshot. Top-level-to-top-level and cross-root descendant traffic remain sender-owned. Do not duplicate a leg into two channels.

At parent start, mint `processInstanceId` with `Bun.randomUUIDv7()`, set `processLabel = path.basename(cwd) || "root"`, and derive lowercase SHA-256 with a local helper that creates a fresh `Bun.CryptoHasher("sha256")` per input: `processHash = SHA-256(processInstanceId)`, `processShort = processHash.slice(0, 12)`, and `publisherNick = "omp-p-" + processHash.slice(0, 24)` (30 characters total). Sequence starts at `1` and increments exactly once for every bus creation event before attribution or queue admission, so even oversize/evicted records have stable ranges. Channel identity is process-incarnated: `channelHash = SHA-256(JSON.stringify([processInstanceId, rootAgentId, rootSessionId]))` and `sessionShort = channelHash.slice(0, 12)`. Therefore concurrent OMP processes resuming the same persisted session never share a channel.

Transform each creation event synchronously into:

```ts
export interface IrcObserverMessageRecordV1 {
	readonly schema: "omp.irc.message.v1";
	readonly eventId: string; // `${processInstanceId}:${sequence}`
	readonly processInstanceId: string; // UUIDv7 minted once per OMP boot
	readonly processLabel: string; // cwd basename, display only
	readonly rootAgentId: string;
	readonly rootSessionId: string;
	readonly rootSessionLabel?: string;
	readonly sequence: number; // monotonic within processInstanceId
	readonly messageId: string; // existing IrcMessage.id
	readonly origin: IrcMessageOrigin;
	readonly from: string;
	readonly to: string;
	readonly replyTo?: string;
	readonly createdAt: number;
	readonly body: string;
}

export interface IrcObserverGapRecordV1 {
	readonly schema: "omp.irc.gap.v1";
	readonly eventId: string; // `${processInstanceId}:gap:${sequenceStart}-${sequenceEnd}`
	readonly processInstanceId: string;
	readonly processLabel: string;
	readonly rootAgentId: string;
	readonly rootSessionId: string;
	readonly sequenceStart: number;
	readonly sequenceEnd: number;
	readonly droppedCount: number;
	readonly droppedBytes: number;
	readonly reason: "queue_overflow" | "record_oversize" | "gap_metadata_overflow";
	readonly certainty: "not_sent";
	readonly exactRange: boolean;
}

export type IrcObserverRecordV1 = IrcObserverMessageRecordV1 | IrcObserverGapRecordV1;
```

Normal tool and auto-reply traffic must always resolve. If a bare API call supplies an unregistered sender, retain the body but set both `rootAgentId` and `rootSessionId` to `"unresolved"`; never guess the current session or mix it into a known session channel.

### 3. Isolate IRC in one supervised child per OMP process

Create `packages/coding-agent/src/irc/observer/protocol.ts`, `parent.ts`, and `worker.ts`. `parent.ts` owns attribution, lanes, config loading, and child supervision and exports:

```ts
export interface StartIrcObserverOptions {
	readonly settings: Settings;
	readonly cwd: string;
	readonly bus?: IrcBus;
	readonly registry?: AgentRegistry;
}

export interface IrcObserverController {
	bindTopLevel(agentId: string, session: AgentSession): void;
	stop(mode: "normal" | "postmortem"): Promise<void>;
}

export async function startIrcObserver(
	options: StartIrcObserverOptions,
): Promise<IrcObserverController | null>;
```

Return `null` for globally disabled or invalid configuration after a body-free warning; an enabled controller survives child spawn/connect failure by queueing within its bounds and supervising retries. Callers guard `session.getAgentId()`: when it is `undefined`, emit a body-free warning and leave that root’s synthetic traffic unscoped rather than asserting or throwing.

Reuse only `resolveWorkerSpawnCmd`, `createWorkerSubprocess`, and `createWorkerHandle` from `packages/coding-agent/src/subprocess/worker-client.ts`. In the new `runWorkerEntrypoint` branch in `packages/coding-agent/src/cli.ts`, dynamically import `startIrcObserverWorker` and pass it to the existing CLI-local `runIpcSubprocessWorker`, exactly like STT/TTS/Mnemopi; add `IRC_OBSERVER_WORKER_ARG = "__omp_worker_irc_observer"` and its ping/pong probe to `runSmokeTest()`. This is a Bun subprocess, not a Worker thread, ordinary session extension, shared daemon, or standalone entrypoint.

Use protocol version `1`, one random spawn `generation`, and exact init/config types:

```ts
export interface IrcObserverWorkerConfig {
	readonly endpoint: {
		readonly hostname: "127.0.0.1" | "::1";
		readonly port: number;
		readonly tls: true;
		readonly caPem: string;
	};
	readonly identity: {
		readonly processInstanceId: string;
		readonly processLabel: string;
		readonly publisherNick: string;
	};
	readonly auth: {
		readonly account: string;
		readonly password: string;
		readonly operName: string;
		readonly operPassword: string;
		readonly viewerNick: string;
	};
}

export type IrcObserverWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "init"; version: 1; generation: string; config: IrcObserverWorkerConfig }
	| {
			type: "lane_state";
			generation: string;
			rootAgentId: string;
			rootSessionId: string;
			pending: boolean;
	  }
	| { type: "publish"; generation: string; record: IrcObserverRecordV1 }
	| { type: "stop"; generation: string };

export type IrcObserverWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "booted"; generation: string }
	| { type: "connected"; generation: string; connectionNonce: string }
	| {
			type: "viewer";
			generation: string;
			connectionNonce: string;
			online: boolean;
	  }
	| {
			type: "blocked";
			generation: string;
			connectionNonce: string;
			eventId: string;
			code: "viewer_offline" | "channel_not_ready";
	  }
	| {
			type: "acked";
			generation: string;
			connectionNonce: string;
			eventId: string;
	  }
	| { type: "state"; generation: string; code: IrcObserverStateCode };
```

The parent reads file paths/secrets once, passes CA PEM and credentials only in `init`, and never sends paths or secrets in argv/env. `IrcObserverStateCode` is `"connecting" | "auth_failed" | "oper_auth_failed" | "nick_in_use" | "missing_capability" | "channel_policy_failed" | "line_too_long" | "echo_timeout" | "echo_content_mismatch" | "stopped"`. Reject unknown keys. Bound CA PEM to 1–1,048,576 UTF-8 bytes, each password to 1–4,096 bytes with CR/LF/NUL forbidden, metadata scalars to 4,096 bytes, viewer/publisher nicks to `^[A-Za-z][A-Za-z0-9_-]{0,29}$`, account/oper names to `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`, and each canonical record JSON to at most 1,048,576 UTF-8 bytes. Validate generation, integer ranges, schemas, and enum membership on both sides. `booted` must arrive within five seconds; `connected` is repeatable and replaces the nonce after each IRC registration. Ignore malformed/stale/range/out-of-order frames; handlers may only update observer state/lane scheduling or remove the exact in-flight event.

Run a parent heartbeat every five seconds with a fresh ping ID. Three missing/mismatched pongs hard-terminate and respawn while retaining lane heads. Retain the `SpawnedSubprocess` and watch `proc.exited` with a per-generation once gate: any exit while not deliberately stopping, including exit code 0, is a supervised failure; deduplicate the helper’s `onError` through the same gate. Unexpected exit/startup/heartbeat failure uses equal-jitter backoff with `cap = min(250ms × 2^attempt, 30s)`, delay `[cap/2, cap]`, reset after 60 seconds healthy. IRC auth/OPER/config/capability failures remain degraded without hot respawn. For worker states plus parent codes `"spawn_failed" | "startup_timeout" | "heartbeat_timeout" | "worker_exit" | "viewer_offline"`, log body-free `logger.warn("IRC observer degraded", { code, processInstanceId, generation })` once per changed code; suppress repeats. After any degradation, the first current-generation ACK—or `connected` plus viewer-online when the queue is empty—logs one `logger.info("IRC observer recovered", { processInstanceId, generation })` and clears the dedupe state. Never include endpoint, labels, channel, credentials, message IDs, or bodies in these operator signals.

Maintain one FIFO lane per `sessionLaneKey = JSON.stringify([rootAgentId, rootSessionId])`, scheduled round-robin, so an offline old session cannot block a new session and two roots cannot collide on a persisted ID. Canonicalize each accepted record once with `JSON.stringify`, retain only that string plus fixed queue metadata, and account `new TextEncoder().encode(json).byteLength`; do not retain the source event/message/body object. The global hard cap counts message/gap records together: 2,048 records or 32 MiB of canonical UTF-8 JSON, with the 1 MiB per-record bound above. Only one lane head is globally in flight; parsing that one string for IPC is the only full-record transient copy.

Send `lane_state pending:true` before a lane’s first publish and `pending:false` immediately after ACK/eviction makes it empty; after every `booted`, replay `pending:true` for all nonempty lanes before scheduling publication. After the ordered `pending:false` send, remove that empty lane from the parent map, round-robin list, retry/eligibility sets, and timers; a later record recreates it and sends `pending:true`. The child uses lane state only for 32-channel retirement eligibility. A matching `blocked` releases the worker slot but retains the head: `viewer_offline` makes all lanes ineligible until a current-nonce `viewer online:true`, while `channel_not_ready` remains ineligible until any lane transitions to `pending:false`, then rejoins round-robin. A current-nonce `viewer online:false` pauses all publication. `acked` removes only the exact current head. Per-session FIFO is guaranteed; no total cross-session display order is claimed.

On pressure, evict the globally oldest not-in-flight data record. Insert or merge one counted gap in that lane; gap accounting uses the evicted record’s canonical UTF-8 byte count. `exactRange` is true only for one contiguous run and false for coarsened bounding ranges; counts/bytes stay exact. If the resulting gap cannot fit without recursively evicting more data, merge it into one fixed-field process-scoped emergency accumulator outside normal lanes, capped at 4 KiB, with `rootAgentId/rootSessionId:"unresolved"`, `reason:"gap_metadata_overflow"`, `exactRange:false`, exact aggregate count/bytes, and the bounding sequence range—never bodies, root IDs, distinct-session count, or an unbounded list. As soon as ordinary capacity can hold it, snapshot the accumulator into the normal unscoped lane as a canonical gap that counts toward both caps, reset the accumulator before publication, and leave the queued/in-flight snapshot immutable so new losses can reuse the one accumulator. Oversize records become `record_oversize` gaps. Never evict or mutate in-flight data.

Build the child environment only from defined parent values of `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, `TZ`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`, and `PATHEXT`; never call `workerEnvFromParent`, and never pass provider/API/OAuth/proxy credentials in env or argv. If `resolveWorkerSpawnCmd` returns no cwd (compiled binary), set `cwd` to `os.tmpdir()`; preserve its source-host/fallback cwd because those commands use a relative entry script. Reuse `createWorkerSubprocess`’s ignored stdout and 16 KiB file-backed stderr tail; worker logs/errors contain only state codes, event IDs, ranges, counts, and byte counts, never bodies, labels, configuration, or secrets. The subprocess is a parser/crash and semantic-control boundary, not a same-UID sandbox.
### 4. Publish to one private channel per top-level session

Implement a small child-local IRC state machine directly on `Bun.connect`; add no IRC/npm/Rust dependency or manifest/lockfile change. `irc-client-ts@0.23.1` was source-checked and rejected because ordinary EOF does not trigger its reconnect plugin, pending reconnect cannot be cancelled, framing/CAP state survives reconnect, its Bun adapter ignores short writes, and tagged raw messages bypass its splitter. The native client owns one generation-tagged socket, one cancellable retry timer, an incremental fatal UTF-8 decoder, a CRLF framer capped at 8 KiB of undecoded remainder/one line, short-write/drain handling, and only the protocol states needed here. An invalid UTF-8 sequence, bare LF, embedded NUL, or 8 KiB overflow closes the socket and enters the normal reconnect backoff; no partial line reaches the parser.

Require numeric loopback (`127.0.0.1` or `::1`), TLS with configured CA verification, SASL PLAIN, and server capabilities `sasl`, `echo-message`, `message-tags`, `account-tag`, and `server-time`, plus `MONITOR` and `CHANNELLEN >= 59` in `005 RPL_ISUPPORT`. Register with fixed metadata-only `USER u 0 * :OMP IRC Observer`. Perform multiline `CAP LS 302`/`REQ`, SASL, `CAP END`, and registration; split the base64 PLAIN payload into IRC’s 400-byte `AUTHENTICATE` chunks and send a final `AUTHENTICATE +` when its length is an exact multiple. Require SASL `903` and welcome `001`, then send `OPER`; emit `connected` only after `381 RPL_YOUREOPER`. Map SASL failure to `auth_failed`, `481`/`491` or OPER timeout to `oper_auth_failed`, missing/NAK capability/ISUPPORT to `missing_capability`, and `433 ERR_NICKNAMEINUSE` to `nick_in_use`; these terminal configuration/identity states do not hot-retry.

Use a ten-second deadline independently for TCP/TLS connect, CAP, SASL, registration, and OPER. Once connected, if no inbound line arrives for 60 seconds, send `PING :<connectionNonce>` and require its matching PONG within 15 seconds. Respond to server PING immediately. Connect error, EOF, `ERROR`, framing failure, liveness failure, or echo timeout clears the socket, decoder, CAP/ISUPPORT, membership, viewer-state, and pending-echo data but retains parent-supplied lane state, then reconnects with equal-jitter `cap = min(250ms × 2^attempt, 30s)`, delay `[cap/2, cap]`, reset after 60 seconds registered. Keep exactly one retry timer and cancel it on stop or generation replacement.

After each `connected`, send `MONITOR + <viewerNick>` and begin viewer state as unknown/offline. Emit a current-nonce `viewer` frame on every transition: `730 RPL_MONONLINE` means `online:true`; `731 RPL_MONOFFLINE`, viewer QUIT, or `401` from viewer SAJOIN means `online:false`. On online, join each currently pending session channel and force-join the viewer; on offline, retain affected lane heads. A later `730` retries channel setup without reconnect, so starting or restarting Repartee after OMP unblocks pending traffic.

Normalize `processLabel` and `rootAgentId` for channel display with NFKD, lowercase ASCII, runs outside `[a-z0-9]` replaced by `-`, edge hyphens removed, and limits/fallbacks `processSlug = first 12 || "omp"` and `rootSlug = first 8 || "root"`. A resolved channel is exactly `#omp-<processSlug>-<rootSlug>-<channelHash first 32 hex>` (at most 59 characters); unresolved traffic uses `#omp-<processSlug>-unscoped-<processHash first 24 hex>`. This bounded human prefix is what stock Repartee shows in its sidebar; the process-incarnated hash prevents two processes—even concurrent `--resume` of the same session—from mixing. Set the topic to escaped full process/session labels plus opaque root session ID for detail after selection.

After successful OPER, unconditionally self-join with Ergo’s `SAJOIN <channel>` form, which creates a missing channel or bypasses surviving `+i`. Apply `SAMODE <channel> +imnst` and `SAMODE <channel> +o <publisherNick>`, then `SAJOIN <viewerNick> <channel>`. Before publication, require authoritative `324 RPL_CHANNELMODEIS` to contain `i`, `m`, `n`, `s`, and `t`; require NAMES/JOIN state to show this publisher as the only `omp-p-*` publisher/operator and the configured viewer present and unvoiced/unopped; require the publisher’s account/prefix to match registration. Any unexpected second publisher or partial mode/member failure is `channel_policy_failed`, never a send fallback.

Keep at most 32 joined session channels per child, using parent `lane_state` as pending truth. A `pending:false` channel inactive for 15 minutes is retired by confirming this publisher remains op, KICKing the viewer with literal reason `[omp/retire/v1]`, PARTing the publisher, and discarding child-side state; graceful child stop applies the same sequence to every joined channel. In stock Repartee v1.6.1, self-KICK deliberately removes the live sidebar buffer, while encrypted rows remain navigable in the read-only `repartee l` log browser until retention pruning. A later record recreates the same channel. A hard-killed whole OMP process can leave a viewer-only live channel until Repartee reconnects; document that limitation and cleanup.

When a 33rd channel is needed, immediately retire the least-recently-used joined channel whose latest lane state is `pending:false`, without waiting for 15 minutes. If all 32 are pending, return `channel_not_ready` for the new lane; the parent retries after its next lane-drained transition while round-robin continues existing lanes. Configure Ergo for at least 512 viewer channels so five OMP processes can each retain 32 plus crash margin; test more than 100 sequential session switches, live-buffer retirement, and encrypted log-browser retrieval without permanent SAJOIN failure.

Use a two-record rendering so stock Repartee gets activity without ever placing an agent body on its highlightable path:

1. Send one metadata-only channel `PRIVMSG` marker:

   ```text
   [omp/activity/v1 event=<eventId> parts=<n>]
   ```

   It contains no agent body, route, label, or other model/user text. Repartee uses it to set per-channel activity/unread. A viewer nick race can at worst copy this opaque marker—not an agent body—into its plaintext `mentions` table.
2. Send the actual message as one or more channel `NOTICE` chunks. Repartee v1.6.1 routes channel NOTICE to the existing buffer, logs it encrypted as `type="notice"`, and hard-codes `highlight=false`. Every chunk repeats:

   ```text
   [omp/v1 p=<process-short> s=<session-short> seq=<sequence> id=<messageId> origin=<origin> <from>→<to> reply=<replyTo-or-> part=<i>/<n>] <escaped-body>
   ```

3. Gap records contain metadata only and use one activity `PRIVMSG`:

   ```text
   [omp/gap/v1 p=<process-short> s=<session-short> seq=<start>..<end> exact=<true|false> reason=<reason> certainty=not_sent count=<count> bytes=<bytes>]
   ```

Reversibly escape backslash, CR, LF, NUL, CTCP, ESC/C0/C1, ANSI/OSC, unpaired UTF-16 surrogates, and Unicode bidi/default-ignorable formatting controls in every visible field; never allow raw body bytes into a command, topic, marker, tag, or log. Attach client-only tag `+omp.sh/observer=<eventId>:<phase>:<part>:<connectionNonce>` with exact phases/parts: message activity marker `activity:0`, NOTICE chunk `body:<1-based-index>`, and gap marker `gap:0`. Generate `connectionNonce` with `Bun.randomUUIDv7()` after each successful registration. Tags persist as opaque SQLite JSON but are not visible/searchable in stock TUI/web, so visible IDs remain authoritative.

Split escaped NOTICE text at UTF-8 code-point boundaries and iteratively account for final part-count digits. Compute the payload ceiling as the minimum of (a) the full tagged client command budget and (b) Ergo’s expanded server-to-viewer budget after adding the actual post-registration `nick!ident@host` prefix and pinned maximum server-added tags; both complete lines including CRLF must be at most 512 bytes. Handle `417 ERR_INPUTTOOLONG` as terminal `line_too_long` for that connection/event, not a reconnect loop. Test maximum configured nick/account/channel/tag/prefix lengths.

Send marker/chunks one at a time. Accept an echo only when connection generation/nonce, command, case-mapped channel, own nick/account, correlation tag, current event/phase/part, and final text all match. Ignore unrelated inbound frames; if a frame claims the exact current correlation tag and own echo identity but any command/channel/phase/part/text field differs, emit `echo_content_mismatch`, do not ACK, and stop publication until restart. A 15-second echo timeout reconnects and retries. Acknowledge a message only after the activity marker and every NOTICE chunk echo; acknowledge a gap after its one marker echo. This is at-least-once to Ergo while the parent survives and the record remains queued; ambiguous disconnect can show duplicates with the same visible/tagged IDs. Discard all other IRC `PRIVMSG`, `NOTICE`, `TAGMSG`, CTCP, invite, mode, and private traffic without forwarding any IRC-derived data to the parent.
### 5. Make enablement global-only and lifecycle-safe

Add these schema keys to `packages/coding-agent/src/config/settings-schema.ts`:

```text
irc.observer.enabled = false
irc.observer.endpoint = "ircs://127.0.0.1:6697"
irc.observer.caFile = "~/.omp/irc-observer/ca.pem"
irc.observer.account = "omp-publisher"
irc.observer.passwordFile = "~/.omp/irc-observer/publisher-password"
irc.observer.operName = "omp-observer"
irc.observer.operPasswordFile = "~/.omp/irc-observer/oper-password"
irc.observer.viewerNick = "omp-viewer"
```

Only `irc.observer.enabled` gets:

```ts
ui: {
	tab: "tools",
	group: "Execution",
	label: "IRC Observer",
	description: "Export raw inter-agent traffic after the next OMP restart",
}
```

The other keys are config-only with no `ui` block. Add `Settings.getGlobal<P extends SettingPath>(path: P): SettingValue<P>` in `packages/coding-agent/src/config/settings.ts`; it reads only global plus schema default. Read all observer keys through `getGlobal`, never merged `get`; changes apply next process start. Expand file paths with existing `expandTilde`. Parse the endpoint with `URL`; require protocol `ircs:`, empty username/password/search/hash, pathname exactly `/`, an explicit decimal port 1–65535, and hostname exactly `127.0.0.1` or bracket-normalized `::1`. On POSIX, open the CA and secret files once with `fs.promises.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)`, require regular files owned by the current UID, cap CA at 1,048,576 bytes, and additionally require secret mode `(mode & 0o077) === 0` and size at most 4,098 bytes. Remove exactly one trailing `\n` or `\r\n` from a secret, then require 1–4,096 UTF-8 bytes with no remaining CR/LF/NUL. Validate viewer/account/oper names with the protocol regexes; under ASCII case-folding the viewer nick must neither equal `publisherNick` nor start with reserved prefix `omp-p-`. On non-POSIX, or for missing/symlinked/wrong-owner/loose/invalid files, return `null` with a body-free warning; never fall back to plaintext, unauthenticated, DNS, non-loopback, project config, or unverifiable ACLs.

Start branch-by-branch after final validation and before any mode can run tools. The shared `createSession` wrapper binds every returned root; guard undefined `getAgentId()` as above. `/new`, resume, fork, park/revival, and ACP root churn do not restart child or reset process identity/sequence.

Normal exits are owned by the mode that calls `process.exit`, not by `runRootCommand`:

- Make `AcpAgent.dispose(): Promise<void>` public and promise-memoized around `#disposeAllSessions`; the abort listener calls it. Change `runAcpMode(..., beforeExit?: () => Promise<void>)` to retain the created `AcpAgent`, await `connection.closed`, await `agent.dispose()`, await `beforeExit`, then `process.exit(0)`. Pass `() => observer.stop("normal")`.
- Extend RPC shutdown options with `beforeExit?: () => Promise<void>`. In `performShutdown`, replace the ad hoc extension-only shutdown with one awaited `session.dispose()` after protocol operations are cancelled, drain writer, await `beforeExit`, then exit; pass observer normal stop.
- Add an awaited `afterSessionDispose?: () => Promise<void>` callback to `InteractiveMode`. In `shutdown()`, invoke it after the shared session teardown and before terminal drain/`postmortem.quit`; pass observer normal stop through `runInteractiveMode`.
- Print mode preserves the first awaited `session.dispose()` inside `runPrintMode` and the existing idempotent second disposal in `main.ts`; immediately after the second disposal, `main.ts` awaits observer normal stop before `postmortem.quit`.

Implement `stop` as one promise-memoized transition; the first `"normal"` or `"postmortem"` call owns the sequence and every later call awaits the same promise. `stop("normal")` runs only after the mode/session disposal above: unsubscribe the bus and dispose attribution immediately, continue pumping the already queued/in-flight records until empty or a two-second monotonic deadline, then send the current-generation `stop`. Await the child’s `state:"stopped"` only within the remaining deadline; on drain/stop timeout, log only IDs/ranges/counts/bytes. In all cases, hard-terminate the child once, cancel timers/listeners, and resolve before the caller exits.

Retain one idempotent postmortem callback only for signal/fatal fallback. Because `postmortem` callbacks run concurrently, `stop("postmortem")` keeps bus/registry subscriptions active, continues pumping, and resets a 100 ms quiet timer on every creation event. After queue-empty plus 100 ms quiet, or the same two-second fail-open deadline, unsubscribe/dispose, log only IDs/ranges/counts/bytes, send stop, await `stopped` within the remainder, and hard-terminate inside the global ten-second postmortem deadline. The child retires channels, sends IRC `QUIT`, emits `state:"stopped"` with `sendAndFlush`, and then waits for parent termination. This is bounded best-effort during concurrent teardown, not serialized-disposal proof; test a delayed teardown message inside the quiet window.
### 6. Prove the path, then finish operator configuration and cleanup

After the focused parent/child smoke works, add behavioral tests using the existing IRC fake-session helpers plus a deterministic fake Ergo TLS server. Commit test-only `test/fixtures/irc-observer/ca.pem`, `server-cert.pem`, and `server-key.pem`; the certificate has IP SANs `127.0.0.1` and `::1`, and no production code references these fixtures. Tests create owner-only temporary password files and bind an ephemeral loopback port. Add the new worker ping to the existing compiled/source `--smoke-test`. Then document the pinned deployment in `docs/irc-observer.md` and add an `Added` entry under `packages/coding-agent/CHANGELOG.md` `[Unreleased]`.

The operator guide pins [Ergo v2.18.0](https://github.com/ergochat/ergo/releases/tag/v2.18.0) and [stock Repartee v1.6.1](https://github.com/outragedevs/repartee/releases/tag/v1.6.1) (`8d51ea845b911caeec36cc673641b70a95a8f2f8`). Its tested Ergo configuration must:

- expose only `"127.0.0.1:6697"` and/or `"[::1]:6697"` listeners with the configured TLS cert/key; require matching IP subjectAltName entries, remove plaintext/wildcard listeners, and install/trust the private CA for Repartee because its server stanza has no custom-CA field;
- set `accounts.authentication-enabled: true`, `accounts.registration.enabled: false`, `accounts.require-sasl.enabled: true`, and `accounts.require-sasl.exempted: []` so loopback is not exempt;
- set `accounts.nick-reservation.force-nick-equals-account: false` so simultaneous children authenticated as `omp-publisher` can use distinct `omp-p-<24-hex-process-hash>` nicks;
- set `channels.max-channels-per-client: 512`, keep channel creation enabled, and set `history.enabled: false` with persistent history disabled;
- define an `omp-observer` oper class with only `sajoin` and `samode`, then bind the `omp-observer` oper name to that class using an `ergo genpasswd` hash;
- provision registered `omp-publisher` and `omp-viewer` accounts before disabling registration, and keep message bodies out of Ergo operational logs.

Use a `[servers.omp_observer]` Repartee entry with the loopback TLS address, `tls_verify=true`, `autoconnect=true`, `nick="omp-viewer"`, `sasl_mechanism="PLAIN"`, and no static session channels because MONITOR/SAJOIN supplies active ones. In its owner-only `.env`, set `OMP_OBSERVER_SASL_USER=omp-viewer`, `OMP_OBSERVER_SASL_PASS=<viewer secret>`, and `REPARTEE_LOG_KEY=<64 lowercase hex characters>`. The guide includes temporary account provisioning, then requires an Ergo restart with registration disabled/SASL mandatory before enabling OMP.

Configure Repartee `[general].flood_exemptions = ["omp-p-*!~u@*"]` while retaining flood protection for every other source; this narrowly exempts the fixed publisher nick/`USER u` mask from the pinned tilde-ident burst limiter. Configure `[logging] enabled=true, encrypt=true, retention_days=30, exclude_types=[]`; disable web, scripts, and URL/image preview/shrinking for this network. Explain the exact navigation lifecycle: human-prefixed channels stay in the live sidebar while active and for 15 minutes; observer KICK removes a retired buffer from the live sidebar; `repartee l` opens Repartee’s stock read-only log browser for its retained encrypted rows; a backend restart does not reconstruct inactive dynamic buffers. State that encrypted text still leaves network/channel/time/type/nick/tags metadata plaintext, all-message pruning runs on Repartee startup, and encrypted search scans only its recent 10,000-row fallback rather than full FTS history. Include how to inspect deduplicated degraded/recovered signals in `~/.omp/logs/` without enabling body logging.
## Critical files & anchors

- `packages/coding-agent/src/irc/bus.ts` — `IrcBus.send` at the message-construction line and all current routing branches; the observer must emit before line 106 lookup without altering receipts, waiters, revival, mailboxes, or `#relayToMainUi`.
- `packages/coding-agent/src/irc/observer/parent.ts` — new process-owned subscription, attribution index, globally bounded per-session lanes/gap coarsening, exact in-flight ACK validation, heartbeat/child supervision, and bounded quiet-stop barrier.
- `packages/coding-agent/src/irc/observer/worker.ts` — new isolated native-Bun IRC state machine, per-session channel membership, viewer gate, reversible renderer/chunker, echo correlation, and inbound discard boundary.
- `packages/coding-agent/src/main.ts` — `runRootCommand` settings initialization and local `createSession` wrapper around lines 1266–1290/1342; start once before root creation, bind ordinary/ACP roots, stop after normal mode teardown, and register the bounded signal-path barrier.
- `packages/coding-agent/src/cli.ts` — `runWorkerEntrypoint`, CLI-local `runIpcSubprocessWorker`, and `runSmokeTest`; add the early hidden selector and compiled/source probe here while reusing spawn primitives from `subprocess/worker-client.ts`.

## Verification

### Focused behavioral contracts

Focused tests need no external service or environment variables; they use the committed loopback TLS fixture, temporary settings/secrets, and the in-process fake server. From the repository root, run:

```text
bun --cwd=packages/coding-agent test \
  test/tools/irc.test.ts \
  test/irc/observer-parent.test.ts \
  test/irc/observer-worker.test.ts \
  test/config/irc-observer-settings.test.ts \
  test/irc/observer-mode-teardown.test.ts
```

The tests must prove:

1. A blocked/reviving/failing recipient cannot delay the creation event: one frozen event exists immediately after `send` accepts the leg, before the delivery promise settles. Direct, waiter, unknown, advisor, revival-failure, no-session, and delivery-throw paths each emit once; listener throw/rejection/mutation cannot change receipt or recipient state; unsubscribe is idempotent and has no replay.
2. Tool broadcasts emit one `"tool"` event per resolved target, none for zero targets, and no extra event from the main-UI relay. A real auto-reply emits a second `"auto_reply"` record with `replyTo` equal to the first message ID.
3. The attribution index puts Main/new descendants in the live root session; after `/new`, resume, and fork, existing descendants retain the old root while Main/new descendants use the new one. Main direct/broadcast/auto-reply legs to a historical child use that child’s snapshot; descendant→Main stays descendant-owned; cross-root traffic stays sender-owned. Park/revive preserves attribution, persisted refs hydrate, two ACP roots remain separate even with the same persisted ID, and an unregistered sender uses only the unscoped channel.
4. Canonical queue strings—not source event/body objects—count toward 2,048 records/32 MiB UTF-8 JSON; only one parsed head exists transiently. Tuple-keyed per-session lanes retain FIFO and round-robin around a blocked lane; ordered `lane_state` transitions/replay exactly track empty/nonempty state; every empty parent lane and retry/timer reference is deleted. The in-flight head is immutable. Oversize/overflow gaps have exact canonical-byte counts and honest `exactRange`; the emergency accumulator snapshots into a cap-counted immutable unscoped gap and resets; adversarial alternating sessions leave no unbounded map/list. Stale/malformed/out-of-order ACK/blocked/viewer frames cannot advance another lane.
5. The subprocess emits `booted` within five seconds even with Ergo offline, rotates `connected.connectionNonce` after reconnect, survives initial outage, preserves lane state across IRC reconnect, and resends the same event. `viewer online:false` pauses publication and a later current-nonce `online:true` resumes it. Runtime ping kills/respawns after three misses. A fake child that exits with code 0 unexpectedly is detected through `proc.exited`, retains lane heads, and produces exactly one backed-off respawn despite duplicate `onError`; crash, echo timeout, viewer-offline, and channel-cap retries preserve heads. Each changed degraded code logs once with only allowed metadata; repetition is suppressed; current-generation recovery logs once.
6. The fake Ergo server exercises split TCP/UTF-8 reads, short writes/drain, invalid UTF-8/bare-LF/NUL/8 KiB rejection, multiline CAP LS, missing/NAK capabilities, CHANNELLEN below 59, fixed `USER u`, 400-byte SASL chunk boundaries, `903`/failure, `001`, nickname `433`, OPER `381`/`481`/`491`, each registration deadline, PING/PONG liveness, MONITOR `730`/`731`/QUIT, self-SAJOIN, partial/failing SAMODE, authoritative `324`/NAMES policy, viewer late start/restart, 32-channel retirement/recreation, and more than 100 sequential sessions.
7. Renderer tests prove human-prefixed channel names are at most 59 characters, process-incarnated hashes separate two processes with the same persisted session, the `PRIVMSG` activity marker contains no body/route/label, each actual body travels only in `NOTICE`, control/default-ignorable/unpaired-surrogate formatting is reversible, UTF-8 chunk boundaries are valid, exact tag phases and visible IDs remain stable on retry, and both client and expanded server lines stay within 512 bytes. Numeric `417` produces terminal `line_too_long`, not a reconnect loop.
8. Echo acceptance requires current generation/nonce/command/channel/account/tag/event/phase/part/text. Unrelated inbound PM/NOTICE/PRIVMSG/CTCP/tag frames yield no ACK and no parent data; a forged current correlation tag with mismatched content yields `echo_content_mismatch` and terminally pauses publication.
9. Project config cannot affect `Settings.getGlobal`; disabled/default/malformed/non-loopback/plaintext endpoints, implicit ports, URL credentials/query/fragment/path, symlinked/wrong-owner/loose secret files, invalid names, and non-POSIX ACLs do not spawn a child or leak credentials/body text. Mode tests prove ACP awaits public `dispose` then normal stop before exit, RPC disposes session/drains/stops before exit, InteractiveMode awaits stop between shared teardown and `postmortem.quit`, and print stops after disposal. Normal stop unsubscribes then drains/stops within two seconds; concurrent postmortem callbacks plus a delayed teardown message prove fallback subscription survives its quiet barrier and every caller shares one termination.

### Worker-host and type/build checks

Run:

```text
bun packages/coding-agent/src/cli.ts --smoke-test
bun check
bun --cwd=packages/coding-agent run build
./packages/coding-agent/dist/omp --smoke-test
```

Both smoke invocations must ping `__omp_worker_irc_observer` and exit with `smoke-test: ok`; the compiled probe proves the child re-enters the single CLI binary rather than depending on an unbundled entrypoint.

### Pinned end-to-end acceptance

Using the documented Ergo v2.18.0/Repartee v1.6.1 configuration:

1. Start Ergo on loopback TLS, start Repartee detached with `repartee -d`, then attach with `repartee a`.
2. Start two observer-enabled OMP processes. In each top-level session, run at least three agents and exchange direct messages, awaited replies, an auto-reply, a broadcast, ten messages inside five seconds, multiline Unicode/control text, and the exact Repartee viewer nick.
3. Confirm every top-level session incarnation has a distinct `#omp-<process-slug>-<root-slug>-<32hex>` live buffer; the human prefix is legible in the stock sidebar; Main/descendants stay together; two processes concurrently resuming the same persisted ID do not collide; `/new` opens another channel; a late pre-switch child and Main’s replies to it stay in the old channel. Each inactive channel gains activity/unread from one opaque marker per event, followed by readable NOTICE body chunks. The ten-message burst must produce the exact expected marker/body row count—no Repartee flood suppression.
4. Start OMP before Repartee, then start the viewer without restarting OMP: MONITOR `730` must trigger SAJOIN and queued delivery. Stop/restart Repartee and Ergo and kill one observer child; other processes continue, lanes remain bounded/fair, channels are re-established/policy-checked, and replayed duplicates retain IDs. Drive more than 100 session switches: after 15 minutes/forced LRU retirement, the live buffer disappears, viewer membership stays below limits, and its encrypted conversation remains selectable/readable through `repartee l`. Simulate a hard-killed whole OMP process and perform the documented Repartee reconnect cleanup.
5. Inspect the temporary Repartee SQLite database: each event has one metadata-only `type="message"` activity row and the expected encrypted `type="notice"` body rows with non-null IVs; correlation tags are stored as opaque JSON; no raw agent-body sentinel appears in `mentions.text` or any activity marker. A deliberately concurrent viewer NICK race may create only an opaque marker mention, never body/route/label content.
6. Force queue pressure across alternating root sessions: affected session channels receive exact or explicitly coarsened GAP records, unaffected lanes continue, canonical queued UTF-8 bytes never exceed 32 MiB plus the one fixed 4 KiB emergency accumulator, and a long stress run plateaus rather than accumulating source objects, empty lanes, retry state, or per-session history. Do not claim a 32 MiB RSS ceiling; JS strings, maps, the one parsed head, and runtime overhead are separately bounded.
7. Gracefully exit and signal-kill one OMP process. Normal paths dispose mode/root before stop; signal paths retain subscription through the bounded quiet barrier and capture a teardown-time send within that window. Shutdown waits no more than two seconds for observer drain and reports only IDs/ranges/counts/bytes. Ergo/Repartee remain running.

This proves fail-open live observation only. Do not report exactly-once display or durable commit: server echo proves Ergo acceptance, while stock Repartee’s bounded SQLite writer can still drop and it has no commit ACK or `CHATHISTORY`.
## Assumptions & contingencies

- The selected product contract is fail-open live observation with bounded RAM and no producer/child disk spool. Crash-durable capture would require a separately approved encrypted producer outbox committed before bus progress plus a sink ACKing a unique SQLite commit; do not quietly add a bridge journal.
- One live Repartee buffer corresponds to one top-level OMP session incarnation, keyed by process UUID + root agent + persisted session ID. Concurrent processes resuming the same persisted ID, `/new`, fork, and distinct roots never share a channel. Normal/LRU retirement intentionally removes the live buffer but preserves encrypted history for `repartee l`; inactive dynamic buffers are not reconstructed after a Repartee restart. Unresolved synthetic API traffic goes only to the process-scoped unscoped channel; viewer-only channels left by an ungraceful whole-process death disappear on the documented Repartee reconnect before the 512-channel limit is approached.
- Activity markers plus NOTICE bodies are deliberate: stock NOTICE preserves encrypted bodies but does not raise unread/activity, while PRIVMSG does. Only fixed opaque marker metadata uses PRIVMSG, so a viewer NICK race cannot place agent body/route/label text in Repartee’s plaintext mentions store.
- Per-session FIFO is guaranteed; cross-session arrival order is not. A blocked viewer/channel delays only its lane. Ordinary OMP does not concurrently reuse one agent ID for two live incarnations; if that registry invariant changes, add a sender-incarnation token before claiming old/new-session attribution.
- Ergo v2.18.0 and Repartee v1.6.1 at the pinned tag commit are the interoperability baseline. If CAP/ISUPPORT, OPER, self-SAJOIN, mode confirmation, echo tags, expanded line limits, or SQLite mapping differs, remain degraded/queued; never fall back to viewer-absent sending, plaintext IRC, aggregate channels, private queries, untagged ACKs, or receipt inference.
- Thirty-day encrypted Repartee retention is enforced only on startup. A strict deletion SLA requires supervised periodic Repartee restarts or a Repartee maintenance change; OMP must not create a second plaintext history store.
- The subprocess prevents IRC parser faults and IRC-derived semantic control from entering `IrcBus`; it is not a same-UID sandbox. A hostile-server threat model requiring file-system containment needs an OS-specific sandbox/dedicated UID before enablement.
- If Bun TLS declarations or pinned Ergo ISUPPORT limits differ at implementation time, inspect installed Bun 1.3.14 types and pinned Ergo source and adapt only socket option spelling/derived line-budget inputs; preserve the decided state machine, capabilities, 512-byte ceilings, and fail-closed behavior.

