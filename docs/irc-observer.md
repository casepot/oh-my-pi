# IRC observer

OMP can export inter-agent IRC traffic to private, process-incarnated Ergo channels viewed by stock Repartee. The observer is one-way: Repartee and IRC input never control OMP. OMP remains fail-open; delivery to agents does not wait for the observer. Queued observer records are bounded to 2,048 canonical records and 32 MiB of canonical UTF-8 JSON, plus fixed emergency gap metadata. Loss is represented by `omp.irc.gap.v1`; OMP does not spool traffic to disk.

## Supported deployment

The interoperability baseline is:

- [Ergo v2.18.0](https://github.com/ergochat/ergo/releases/tag/v2.18.0)
- [Repartee v1.6.1](https://github.com/outragedevs/repartee/releases/tag/v1.6.1), commit `8d51ea845b911caeec36cc673641b70a95a8f2f8`

Run both services on the same trusted host as OMP. The observer subprocess isolates IRC parsing and semantic control from `IrcBus`; it is not a same-UID filesystem sandbox.

## TLS and Ergo

Create a private CA and an Ergo server certificate whose subjectAltName contains every numeric loopback address used by clients: `127.0.0.1` and/or `::1`. Repartee has no per-server custom-CA setting, so install this CA in the host trust store. Configure only TLS loopback listeners:

```yaml
server:
  listeners:
    "127.0.0.1:6697":
      tls:
        cert: /absolute/path/server-cert.pem
        key: /absolute/path/server-key.pem

accounts:
  authentication-enabled: true
  registration:
    enabled: false
  require-sasl:
    enabled: true
    exempted: []
  nick-reservation:
    force-nick-equals-account: false

channels:
  max-channels-per-client: 512

history:
  enabled: false
```

Remove all plaintext and wildcard listeners. Keep channel creation enabled and persistent Ergo history disabled. OMP relies on SASL PLAIN over verified TLS, `echo-message`, `message-tags`, `account-tag`, `server-time`, `MONITOR`, `CHANNELLEN >= 59`, and OPER commands `SAJOIN` and `SAMODE`. It remains degraded and queues records rather than weakening any requirement.

Before disabling registration, provision two registered accounts:

- `omp-publisher`: shared authentication account used by process-unique `omp-p-<24 hex>` nicks.
- `omp-viewer`: Repartee account and default viewer nick.

Use Ergo's account-registration commands during a temporary provisioning window. Then disable registration, make SASL mandatory with no loopback exemption, and restart Ergo before enabling OMP.

Create an oper class granting only `sajoin` and `samode`. Bind oper name `omp-observer` to it and store an `ergo genpasswd` hash, not plaintext, in Ergo's configuration. Keep message bodies out of Ergo operational logs.

## Repartee

Install the private CA into the host trust store, then configure:

```toml
[servers.omp_observer]
address = "127.0.0.1:6697"
tls = true
tls_verify = true
autoconnect = true
nick = "omp-viewer"
sasl_mechanism = "PLAIN"
sasl_username = "${OMP_OBSERVER_SASL_USER}"
sasl_password = "${OMP_OBSERVER_SASL_PASS}"

[general]
flood_exemptions = ["omp-p-*!~u@*"]

[logging]
enabled = true
encrypt = true
retention_days = 30
exclude_types = []
```

Do not configure static session channels: OMP uses MONITOR and OPER SAJOIN. Disable Repartee web serving, scripts, URL/image previews, and URL shrinking for this network. Retain flood protection for all other sources; the exemption is deliberately limited to OMP's fixed publisher nick and `USER u` mask.

Create an owner-only Repartee `.env`:

```text
OMP_OBSERVER_SASL_USER=omp-viewer
OMP_OBSERVER_SASL_PASS=<viewer secret>
REPARTEE_LOG_KEY=<64 lowercase hexadecimal characters>
```

Start detached with `repartee -d`; attach with `repartee a`.

## OMP configuration

Create owner-only secret files. On POSIX they must be regular, non-symlink files owned by the current UID with no group/other permission bits:

```sh
mkdir -p ~/.omp/irc-observer
chmod 700 ~/.omp/irc-observer
printf '%s' '<publisher password>' > ~/.omp/irc-observer/publisher-password
printf '%s' '<oper password>' > ~/.omp/irc-observer/oper-password
chmod 600 ~/.omp/irc-observer/publisher-password ~/.omp/irc-observer/oper-password
cp /absolute/path/private-ca.pem ~/.omp/irc-observer/ca.pem
chmod 600 ~/.omp/irc-observer/ca.pem
```

Set only the global OMP configuration; project settings and runtime overrides cannot enable or redirect the observer:

```yaml
irc:
  observer:
    enabled: true
    endpoint: ircs://127.0.0.1:6697
    caFile: ~/.omp/irc-observer/ca.pem
    account: omp-publisher
    passwordFile: ~/.omp/irc-observer/publisher-password
    operName: omp-observer
    operPasswordFile: ~/.omp/irc-observer/oper-password
    viewerNick: omp-viewer
```

Restart OMP after changing any observer setting. OMP accepts only numeric loopback `ircs:` endpoints with an explicit port, verified TLS, securely opened credential files, and valid IRC names. It never accepts URL credentials, DNS names, plaintext IRC, project-level observer configuration, or credentials in child argv/environment.

## Channels, rendering, and retention

Each top-level session incarnation receives a channel:

```text
#omp-<process-label-slug>-<root-agent-slug>-<32 hex>
```

The hash includes a fresh process UUID, root agent ID, and persisted session ID. Concurrent OMP processes resuming the same persisted session therefore never collide. Unregistered API senders use one process-scoped `#omp-<process>-unscoped-<24 hex>` channel.

Each message produces one metadata-only channel PRIVMSG activity marker and one or more NOTICE body chunks. The marker raises activity/unread without exposing body, route, or labels to Repartee's plaintext mentions path. NOTICE bodies are encrypted by Repartee and hard-coded non-highlightable. GAP records are metadata-only activity messages. Server echo verifies Ergo acceptance; delivery is at-least-once, so an ambiguous reconnect can display duplicates with stable event IDs. Repartee supplies no SQLite commit acknowledgment, so this is not exactly-once durable capture.

Active channels remain in the live sidebar. A pending-free channel is retired after 15 minutes or earlier by the 32-channel LRU limit: the observer KICKs the viewer with `[omp/retire/v1]` and PARTs. Stock Repartee removes that live buffer, while retained encrypted rows remain available with `repartee l`. A Repartee restart does not reconstruct inactive dynamic buffers. A hard-killed OMP process can leave a viewer-only channel until Repartee reconnects; reconnect Repartee to clean these before approaching its 512-channel limit.

Encrypted text still leaves network, channel, timestamp, message type, nick, and tags as plaintext metadata. Repartee applies all-message retention pruning only at startup. Encrypted search scans its recent 10,000-row fallback, not full FTS history. For a strict 30-day deletion SLA, supervise periodic Repartee restarts.

## Operations

Observer degradation and recovery signals are body-free and appear in `~/.omp/logs/omp.YYYY-MM-DD.log`:

```sh
grep -E 'IRC observer (degraded|recovered)' ~/.omp/logs/omp.*.log
```

Signals include only state code, process instance ID, and worker generation. They never include endpoint, credentials, labels, channel names, message IDs, routes, or bodies. Do not enable protocol/body debug logging in Ergo or Repartee.
