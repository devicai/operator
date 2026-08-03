# Operator

Operator is Devic's open-source sandbox orchestration layer for ephemeral, secure code execution environments.

Two pluggable runtime backends are supported:

- **[microsandbox](https://github.com/nichochar/microsandbox)** — libkrun microVMs with their own kernel. Strongest isolation. Requires `/dev/kvm` on the host (bare metal, dedicated server, or VPS with nested virtualization).
- **Docker** — runs each sandbox as a Docker container. No KVM required. For production use, the host should have [`sysbox-runc`](https://github.com/nestybox/sysbox) installed; the runtime falls back gracefully to plain `runc` if sysbox is unavailable.

The runtime is selected via `runtime.type` in `config.yml` and can be swapped at any time without changing application code, schemas, or API surface.

## Features

- **Sandbox Lifecycle** — Create, stop, destroy lightweight microVMs with configurable TTL
- **Command Execution** — Run commands inside sandboxes with CWD tracking and environment variables
- **File Operations** — Read and write files inside running sandboxes, with upload/download support
- **Snapshots** — Capture sandbox filesystem state as `.tar.gz` archives, restore (linked) or fork (independent)
- **Profiles** — Reusable configuration templates (image, resources, env vars, init scripts, ports)
- **Interactive Terminal** — WebSocket-based terminal with streaming stdout/stderr
- **MCP Server** — Built-in HTTP MCP server exposing sandbox tools for AI agents
- **MCP Profiles** — Scoped access control for MCP sessions
- **TTL Management** — Auto-expiration with configurable TTL, extend-on-demand, and linked snapshot auto-persist
- **Binding System** — Associate sandboxes with external identifiers (threads, sessions)
- **Extension System** — Config-driven multi-tenancy (no code changes needed for Devic integration)

## Quick Start

### Prerequisites

- Node.js >= 24
- MongoDB
- Redis
- Either:
  - [microsandbox](https://github.com/nichochar/microsandbox) runtime, **or**
  - Docker daemon (with `sysbox-runc` installed for production-grade isolation — see [Runtime backends](#runtime-backends))

### 1. Install

```bash
yarn install
cd frontend && yarn install && cd ..
```

### 2. Configure

```bash
cp config.example.yml config.yml
# Edit config.yml with your database URIs
```

### 3. Run (development)

```bash
# Start infrastructure locally (if needed)
docker compose --profile infra up -d

# Start backend
yarn start:dev

# Start frontend (separate terminal)
cd frontend && yarn dev
```

### 4. Run (Docker)

```bash
# Full stack with local infrastructure
docker compose --profile infra up

# Or just app + frontend (external infrastructure)
docker compose up
```

Backend: http://localhost:3200
Frontend: http://localhost:5174
API Docs: http://localhost:3200/api/v1/docs
MCP: http://localhost:3200/api/v1/mcp
Terminal WS: ws://localhost:3200/ws/terminal

## Configuration

All configuration is in `config.yml`. Environment variables are supported via `${VAR:-default}` syntax.

| Section | Description |
|---------|-------------|
| `server` | Port, base path, CORS |
| `database` | MongoDB connection URI |
| `redis` | Redis connection URL |
| `defaults` | Default image, CPUs, memory, TTL — applied to any backend |
| `runtime` | Selects the backend (`microsandbox` or `docker`) and its options |
| `mcp` | MCP server (enabled, path) |
| `extensions` | Dynamic entity scoping (for multi-tenancy) |
| `auth` | API key or JWT authentication |
| `webhooks` | Event-driven HTTP callbacks |
| `resourceLimits` | Module-wide caps for total RAM, snapshot disk usage and per-sandbox disk |

### Sandbox defaults

Applied when a `POST /sandboxes` or `POST /snapshots/:id/restore` request omits the corresponding field. Shared by both runtime backends.

```yaml
defaults:
  defaultImage: node:24
  defaultCpus: 1
  defaultMemoryMib: 256
  defaultTtlSeconds: 1800    # 30 minutes
  maxTtlSeconds: 7200        # 2 hours max
  ttlCheckIntervalMs: 30000  # Check every 30s
  autoExtendWindowSeconds: 30  # Renewal window for autoExtend sandboxes
```

> The legacy block name `microsandbox:` is still accepted for backwards compatibility — it is read as `defaults:` if `defaults:` is missing.

#### Keeping a session alive (`autoExtend`)

A sandbox expires on a fixed deadline, which cuts an agent off mid-task whenever
the work outlasts the TTL it was created with. Pass `autoExtend: true` on
`POST /sandboxes` (or on the `create_sandbox` MCP tool) to make the sandbox
renew itself while it is being used:

```json
{ "ttlSeconds": 1800, "autoExtend": true }
```

Any command, file read, file write, directory listing, upload or download arriving in the last
`autoExtendWindowSeconds` (30s by default) before `expiresAt` pushes the expiry
forward by another full `ttlSeconds`. Actions arriving earlier cost nothing —
the sandbox already has time left — so a busy session is renewed roughly once
per TTL rather than on every call.

What it deliberately does not do:

- **Outlive `maxTtlSeconds`.** The ceiling still applies, measured from when the
  sandbox started serving its owner (the hot-pool claim, when there was one).
  The final renewal is clamped to it, and past it the sandbox expires normally
  no matter how busy it is.
- **Keep an idle sandbox alive.** No activity in the window, no renewal.
- **Fail your request.** Renewal is best-effort: if it cannot happen, the
  command or file operation still runs.
- **Cover the WebSocket terminal.** Terminal traffic talks to the runtime
  directly and does not renew the sandbox.

`GET /sandboxes/:id/status` reports `autoExtend` alongside `remainingSeconds`,
and each renewal is logged. `POST /sandboxes/:id/extend-ttl` remains available
for explicit, caller-driven extensions.

### Runtime backends

```yaml
runtime:
  type: microsandbox          # microsandbox | docker

  # Only consulted when type=docker
  docker:
    socketPath: /var/run/docker.sock
    runtime: sysbox-runc      # sysbox-runc | runc
    network: bridge           # used when networkPolicy=allow-all
    hardening:
      dropAllCaps: true
      noNewPrivileges: true
      readOnlyRootfs: false   # most workloads (apt, npm install) break with this
      seccompProfile: default
      pidsLimit: 512
```

#### When to pick which

|                              | `microsandbox`                                | `docker` (sysbox-runc)                         | `docker` (runc)                          |
| ---------------------------- | --------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| Isolation level              | microVM with dedicated kernel                 | hardened container, virtualised /proc + /sys   | standard container, kernel shared        |
| KVM required                 | **yes**                                       | no                                             | no                                       |
| Snapshots                    | tar archive of the workdir                    | tar archive of the workdir                     | tar archive of the workdir               |
| Memory / CPU caps            | enforced by libkrun                           | cgroup v2 (`--memory`, `--nano-cpus`)          | cgroup v2 (`--memory`, `--nano-cpus`)    |
| Workload compatibility       | 100 % (real Linux)                            | ~99 % (DinD, systemd OK)                       | 100 %                                    |
| Use against untrusted code   | recommended                                   | recommended                                    | only after additional hardening          |

#### Installing `sysbox-runc` on the host

`sysbox-runc` is an OCI-compatible runtime that runs containers under user namespaces with a virtualized `/proc` and `/sys`, blocking the most common container escape vectors. Once installed Docker treats it as a regular runtime; Operator requests it with `runtime.docker.runtime: sysbox-runc`.

```bash
# Ubuntu 22.04+ / Debian 12+
wget https://downloads.nestybox.com/sysbox/releases/v0.6.5/sysbox-ce_0.6.5-0.linux_amd64.deb
sudo apt install ./sysbox-ce_0.6.5-0.linux_amd64.deb

# Verify
docker info | grep -i sysbox-runc
```

If `sysbox-runc` is not present on the host, set `runtime.docker.runtime: runc` instead — the rest of the hardening (cap drop, no-new-privileges, seccomp, pids limit) still applies, but kernel-level isolation drops to standard container boundaries. Do not run untrusted code with `runc` unless additional layers (network policies, AppArmor profiles, dedicated VMs) are in place.

#### Hardening flags

All flags default to safe values when `type=docker`. Override them in `config.yml` only with reason:

| Flag               | Default   | Effect when enabled                                                                  |
| ------------------ | --------- | ------------------------------------------------------------------------------------ |
| `dropAllCaps`      | `true`    | Drops all Linux capabilities (`CAP_DROP=ALL`). Required for sysbox-runc to be safe.  |
| `noNewPrivileges`  | `true`    | Sets `--security-opt=no-new-privileges`. Stops setuid escalation inside the sandbox. |
| `readOnlyRootfs`   | `false`   | `--read-only`. Useful for ephemeral execution; breaks `apt`, `npm install`, `pip install`. Tmpfs mounts for `/tmp` need to be added if enabled. |
| `seccompProfile`   | `default` | Path to a seccomp profile, or `default` to use Docker's default profile.             |
| `pidsLimit`        | `512`     | Maximum number of processes allowed inside the sandbox.                              |


### Resource Limits

Module-wide hard caps that protect a single host from being exhausted by runaway sandbox or snapshot creation. Limits are aggregated **globally** across all tenants/extension scopes — they are a host-level guardrail, not per-customer quotas.

```yaml
resourceLimits:
  # Sum of memoryMib across sandboxes in pending/creating/running/stopping state.
  # New sandboxes (and snapshot restores) are rejected with HTTP 400 when the
  # projected total would exceed this value.
  maxTotalMemoryMib: 8192            # 8 GiB
  # Real on-disk usage of snapshot tarballs (measured via fs.stat, not the DB
  # `sizeBytes` cache). New snapshots are rejected once total usage reaches
  # this value.
  maxTotalDiskBytes: 21474836480     # 20 GiB
  # Disk a single sandbox may write on top of its image before it is stopped.
  # Counts the container's writable layer only — the image is shared between
  # sandboxes, so it is not charged to any of them.
  warnSandboxDiskBytes: 3221225472   # 3 GiB — flagged, not touched
  maxSandboxDiskBytes: 8589934592    # 8 GiB — stopped
```

#### Per-sandbox disk

`maxTotalDiskBytes` bounds snapshot storage only. What a sandbox writes while it runs — a `pip install`, a model download, a build cache — lands in the container's writable layer, which nothing measured before: a single sandbox could fill the host and take every other service on it down with it.

Usage is sampled every `maintenance.sandboxDiskCheckIntervalMs` and recorded on each sandbox as `diskBytes` / `diskCheckedAt`, so growth is visible in the API and the UI before anything is enforced. A sandbox that reaches `maxSandboxDiskBytes` is stopped through the regular stop path — persisted to its snapshot if linked, unpublished from ingress — and marked `stoppedReason: 'disk-limit'`, so the owner finds a stopped sandbox with an explanation rather than a vanished one.

This is a **reactive** cap, not a kernel quota: a sandbox can overshoot between two samples. A hard cap needs `--storage-opt size=`, which Docker honors only on overlay2 over XFS mounted with `pquota`; on ext4 the daemon rejects it outright. Set both thresholds to `0` (or omit them) to disable the accounting entirely.

#### Background job cadence

Every periodic job reads its interval from config, so a busy host and a laptop can be tuned differently without a rebuild. Omit the block for the defaults shown:

```yaml
maintenance:
  containerSweepIntervalMs: 300000   # reconcile runtime <-> database
  containerSweepGraceMs: 600000      # never reclaim a container younger than this
  sandboxDiskCheckIntervalMs: 60000  # per-sandbox disk sampling
  networkSweepGraceMs: 60000         # shields a network mid-create (ingress only)
  minIntervalMs: 5000                # floor, so a typo cannot busy-loop the daemon
```

The TTL reaper's own cadence stays where it always was, in `defaults.ttlCheckIntervalMs`.

#### What gets enforced where

| Endpoint | Limit checked | Rejection trigger |
|----------|---------------|-------------------|
| `POST /sandboxes` | `maxTotalMemoryMib` | Active RAM + requested `memoryMib` would exceed the limit |
| `POST /snapshots/:id/restore` | `maxTotalMemoryMib` | Active RAM + requested `memoryMib` (or snapshot default) would exceed the limit |
| `POST /snapshots` | `maxTotalDiskBytes` | Current on-disk snapshot bytes already meet or exceed the limit |
| _(background, every minute)_ | `maxSandboxDiskBytes` | A running sandbox's writable layer reached the cap — it is stopped, not rejected |

Rejections are surfaced as `HTTP 400 BadRequestException` with a descriptive message (e.g. `RAM limit exceeded: requested 1024 MiB + in-use 7680 MiB would surpass the configured maximum of 8192 MiB`). The check runs **before** any sandbox or snapshot is created, so a 400 means no side effects took place.

#### Disabling a limit

Each field is independent and optional:

- Omit the field entirely, **or** set it to `0` to disable that specific check.
- Omit the whole `resourceLimits` block to disable both.

```yaml
resourceLimits:
  maxTotalMemoryMib: 8192   # RAM ceiling enforced
  # maxTotalDiskBytes:      # disk check disabled
```

#### How each metric is computed

- **RAM (`memory.usedMib`)** — sum of `memoryMib` over `Sandbox` documents whose status is one of `pending`, `creating`, `running`, `stopping`. Treated as a *reservation*: the limit accounts for capacity the runtime could use, not what the sandbox currently allocates from RSS.
- **Disk (`disk.usedBytes`)** — `fs.stat` over each `Snapshot` document in `ready` status, summed live. The DB's `sizeBytes` field is only refreshed on snapshot creation/persist and drifts while linked sandboxes are running, so it is **not** used for limit accounting. Snapshots whose file is missing on disk count as `0` bytes — they don't block new creations even if the document still reports a size.

The frontend Snapshots page exposes both numbers side by side in the table footer (DB-reported total vs. real on-disk total) so the drift is visible.

#### Reading current usage

Live values are exposed via `GET /api/v1/usage` (see [Usage](#usage) below). The frontend polls this endpoint every 10 s and renders a progress bar above both the Sandboxes and Snapshots tables, plus per-row "RAM share" / "Disk share" columns.

## API Reference

### Sandboxes

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/sandboxes` | Create sandbox |
| GET | `/api/v1/sandboxes` | List sandboxes (with status filter) |
| GET | `/api/v1/sandboxes/:id` | Get sandbox |
| GET | `/api/v1/sandboxes/:id/status` | Get status with remaining TTL |
| GET | `/api/v1/sandboxes/by-binding/:bindingId` | Get sandbox by binding ID |
| POST | `/api/v1/sandboxes/:id/command` | Execute command |
| POST | `/api/v1/sandboxes/by-binding/:bindingId/command` | Execute command by binding |
| POST | `/api/v1/sandboxes/:id/stop` | Stop sandbox |
| POST | `/api/v1/sandboxes/:id/extend-ttl` | Extend TTL |
| GET | `/api/v1/sandboxes/:id/files?path=` | Read file |
| POST | `/api/v1/sandboxes/:id/files` | Write file |
| DELETE | `/api/v1/sandboxes/:id` | Destroy sandbox |

### Snapshots

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/snapshots` | Create snapshot from running sandbox |
| GET | `/api/v1/snapshots` | List snapshots (filter by `sandboxId`) |
| GET | `/api/v1/snapshots/:id` | Get snapshot |
| POST | `/api/v1/snapshots/:id/restore` | Restore sandbox from snapshot |
| PATCH | `/api/v1/snapshots/:id` | Set the public subdomain (`slug`), `autoRestart` and `startCommand` |
| DELETE | `/api/v1/snapshots/:id` | Delete snapshot |

#### Snapshot Restore Modes

The restore endpoint accepts a `linked` flag:

- **`linked: true`** (default) — Sandbox stays linked to the snapshot. On stop or TTL expiry, changes are automatically persisted back to the snapshot.
- **`linked: false`** — Fully independent sandbox (fork). The snapshot remains unchanged regardless of what happens in the sandbox.

#### Stable URLs and auto-restart

Restoring mints a new `sandboxId` every time, so publishing a sandbox under its
own id gives a URL that dies with the session — no good for a service someone
wants to link to. Instead, **a sandbox restored from a snapshot is published
under the snapshot's subdomain**:

```
PATCH /api/v1/snapshots/:id   { "slug": "my-app" }
    → https://my-app.sandbox.devic.ai
```

Without a slug the subdomain is derived from the snapshot id, so every snapshot
has a stable address with nothing to configure. The slug only makes it
memorable. Sandboxes not born of a snapshot keep being published under their own
id, exactly as before.

Because the address belongs to the snapshot, it can be served when nothing is
running: a visit to a dormant URL restores the snapshot and returns a waiting
page that polls `/__devic/status` and reloads when the service answers. With the
image cache that takes a couple of seconds.

The restore is **linked**, like any other: what gets served this way is an app
with users, and an unlinked sandbox would drop everything they wrote when its
TTL ran out. The snapshot is the thing that persists, so it is written back to
when the sandbox stops or expires. Note what that means — anyone who can reach
the public URL can change the snapshot through the app being served. It gets
`ingress.autoRestartTtlSeconds` rather than the usual default, since nobody
asked for that sandbox explicitly. Concurrent visits are deduplicated through a
Redis claim, so one page load starts one restore, not one per asset.

Linked has a consequence worth planning for: when a session expires, the sandbox
writes itself back, and a full capture of a multi-gigabyte snapshot runs for
minutes (plus a rebuild of its cached image). A visit arriving in that window
**waits** for the save rather than failing — the waiting page says what it is
waiting on and keeps its budget rolling. Restoring with `force` would serve the
version from before the save and then overwrite it with that older filesystem,
losing exactly the writes the save exists to keep.

Turn it off per snapshot with `{"autoRestart": false}`, or entirely with
`ingress.autoRestart: false`.

**Reachability does not live in Redis.** Docker puts each sandbox on its own
bridge network and `publish` joins *this* container to it — an attachment that
dies when the container is replaced. After a restart or a redeploy the routes
still resolve, but the addresses they name are no longer routable from here:
packets vanish and requests hang until the upstream timeout. Two things keep
that from stranding a sandbox:

- On startup, every running sandbox holding a subdomain is republished, which
  reattaches the network and refreshes its address.
- A route whose upstream cannot be connected to (refused, unreachable, or no
  answer within `CONNECT_TIMEOUT_MS`) is checked against the sandbox record:
  - **Sandbox gone or stopped** → the route is dropped and the address served
    as dormant, so the wake-up can replace it. This matters beyond restarts: a
    route that exists suppresses the wake-up, so a stale entry would otherwise
    keep the address dead until the sandbox expired.
  - **Sandbox running but silent** → the route stands and the visitor gets the
    waiting page, which reloads the moment anything starts listening. This is
    the normal state right after a restore, and replacing it would be wrong
    twice: it abandons a sandbox someone may be working in, and it leaves two
    linked sandboxes of one snapshot racing to write themselves back into it.

  An upstream that *accepts* the connection and then misbehaves still gets a
  plain 502 — that is the service's problem, not the route's.

**A snapshot restores files, not processes**, so nothing listens in a freshly
restored sandbox unless the snapshot says what to start:

```
PATCH /api/v1/snapshots/:id   { "startCommand": "cd /workspace && npm start" }
```

It runs after every restore, detached and best-effort — a sandbox whose service
fails to start is still a working sandbox, and the waiting page reports that
nothing is listening rather than the restore erroring out. Output goes to
`/tmp/.devic-start.log` inside the sandbox.

Because it is launched detached, the shell reports success whether or not the
command goes on to start anything — a broken one is invisible until someone
visits the URL and gets a 502. So `PATCH` reads the command back and returns
what it found:

```json
{ "startCommandWarnings": [ { "code": "PGREP_SELF_MATCH", "message": "…", "fix": "…" } ] }
```

The command is saved either way; these are advisory. Three checks, each exact
rather than heuristic:

- **`SYNTAX_ERROR`** — the command is parsed with `sh -n`, the real shell
  parser, which reads without executing. Unbalanced quotes, an unclosed `if`.
- **`PGREP_SELF_MATCH`** — `pgrep -f PAT` searches whole command lines,
  *including the one of the shell evaluating it*, whose command line is the
  start command itself. The pattern is written right there, so it finds itself,
  the guard concludes the service is already up, and nothing starts — silently,
  with an empty log. This is not a matter of writing the pattern better:
  `"[n]ode app.js"` fails too, because `node app.js` is spelled out later in the
  same line. A restore always begins from a fresh container, so the guard has
  nothing to protect against; drop it, or test the port instead.
- **`PKILL_SELF_MATCH`** — same mechanism, worse outcome: it kills the shell
  running the command, so nothing after that point runs.

The same check runs at restore time and logs what it finds, tying the problem to
a specific sandbox.

It deliberately runs **after the filesystem is in place**, not through the
container entrypoint. A tarball restore creates the container, starts it, and
only *then* unpacks into it, so anything the snapshot changed about the boot
path has already been skipped by the time it lands — measured: the same snapshot
self-started from its image and did not from its tarball. Running it here is the
only point that behaves identically on both paths.

`initScript` is not this, and the split is by owner:

- **`initScript` belongs to whoever manages the environment** — a developer
  preparing a sandbox: installing packages, wiring credentials, laying out the
  workspace. It runs on `create` only (`sandboxes.service.ts:214`).
- **`startCommand` belongs to whoever consumes the snapshot** — typically the
  agent working inside it, which is the party that knows how its own service
  starts. It runs on every restore, including the ones a visitor triggers, where
  no init script is in play.

They can overlap: a session started through a caller that also runs an init
script will run both, and if each starts the same server the second one hits
`Address already in use`. Keep the service start in `startCommand` and leave
preparation to `initScript`.

#### Snapshot Image Cache

Restoring from a tarball costs time proportional to snapshot size, because the
archive is pushed into the new container and extracted there — single-threaded
gzip inside the sandbox's own CPU quota. Measured against a live instance:

| Snapshot | From tarball | From image |
|---|---|---|
| 0 MB | 3.0 s | ~2 s |
| 199.8 MB | 15–28 s | ~2 s |
| 760.9 MB | 65.1 s | ~2 s |

Enabling `snapshots.imageCache` pre-materializes each snapshot as a container
image, so a restore is a plain container create and no longer scales with size.

**The tarball remains the artifact of record.** Export, import and backups read
it, and the image is rebuilt from it after every capture. Deleting every cached
image costs start time and nothing else — restores fall back to the tarball,
which is the behaviour with the cache off.

Three properties are worth knowing before enabling it:

- **Disk.** An image stores its content uncompressed (that is why it starts
  instantly). Only the delta over the base image is charged to the cache, since
  the base is shared by every sandbox on the host regardless. Set
  `maxTotalBytes`; the least recently restored images are evicted to stay under
  it, and an image backing a live sandbox is never evicted. Independently of the
  cap, every five minutes the module drops images whose snapshot no longer
  exists — deleting a snapshot cannot always remove its image, because the
  daemon refuses while any container (even a stopped one) still references it.
- **Capture cost.** Each capture writes the tarball and then, in the
  background, rebuilds the image (~23 s for a 200 MB snapshot). Nothing waits
  on it: the snapshot is `ready` as soon as the tarball is.
- **Layer depth.** The image is always rebuilt from the ORIGINAL base image, so
  its depth is pinned at base+1 no matter how many times a linked snapshot is
  persisted. This is not an optimization but a correctness requirement: under
  `sysbox-runc` an image of 71 layers fails to start with an opaque OCI error
  while 70 starts fine (measured; the same images run under `runc`), and the
  failure surfaces only at the next restore.

A sandbox restored from a cached image records its base image in a container
label, so its own snapshots stay diffs against that base rather than against
the snapshot image it happened to boot from.

#### Saving a big snapshot

Capturing a large filesystem takes minutes — longer than most reverse proxies
will hold a request open. Two options keep that off the request path:

- `POST /api/v1/sandboxes/:id/stop` with `{"async": true}` — the sandbox goes to
  `stopping`, the response comes back immediately, and the save runs in the
  background. The container is torn down **after** the capture finishes; killing
  it mid-capture SIGKILLs the tar and loses the save. Add `{"save": false}` to
  close a session without keeping its changes.
- `POST /api/v1/snapshots` with `{"async": true}` — returns the `creating`
  document; poll `GET /api/v1/snapshots/:id` for the outcome.

While a save runs, the snapshot carries `saveState: "saving"` and its artifact
on disk is still the **previous** capture (captures write to a temp file and are
renamed into place, so a reader never sees a half-written tarball). Restoring
from it in that window is refused with `409 SNAPSHOT_SAVE_IN_PROGRESS` unless the
caller passes `force: true`, which starts from that last saved version and
accepts being out of sync with the save in flight. Stopping or destroying a
sandbox whose filesystem is being captured is refused the same way.

A capture also rebuilds the image cache, if enabled — scheduled only once the
tarball is renamed into place, so an image never publishes content that is not
yet the artifact of record.

### Sandbox Profiles

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/sandbox-profiles` | Create profile |
| GET | `/api/v1/sandbox-profiles` | List profiles |
| GET | `/api/v1/sandbox-profiles/:id` | Get profile |
| PATCH | `/api/v1/sandbox-profiles/:id` | Update profile |
| DELETE | `/api/v1/sandbox-profiles/:id` | Delete profile |

### MCP Server

The MCP server is available at `POST /api/v1/mcp` (Streamable HTTP).

Tools exposed:
- `create_sandbox` — Create a new sandbox
- `run_command` — Execute a command in a sandbox
- `read_file` — Read file contents from a sandbox
- `write_file` — Write file to a sandbox
- `stop_sandbox` — Stop a running sandbox
- `list_sandboxes` — List all sandboxes

### WebSocket Terminal

Connect to `ws://host/ws/terminal` for interactive terminal sessions.

> **This endpoint is not authenticated, and must not be exposed to a network
> you do not trust.** The gateway registers a raw `ws.on('message')` handler
> inside `handleConnection`, and Nest applies the global `ApiKeyGuard` to
> *handlers*, so the guard never runs here: `auth.enabled: true` protects the
> REST API and leaves this open. Attaching needs only a sandbox id, which is
> public by construction — it is the label of the sandbox's own ingress
> hostname — so anyone given a preview URL can open a root shell in it.
>
> The bundled frontend therefore serves the UI but refuses `/ws/` (see
> `frontend/nginx.conf`); it runs commands over the REST API instead. Reach the
> terminal from a trusted network, against the API port directly. If you put
> the API port behind a public proxy, terminate it there until the gateway
> validates a key on connect.

### Health

| Endpoint | Description |
|----------|-------------|
| GET `/health` | Basic health check |
| GET `/health/ready` | Readiness (DB + Redis) |

### Usage

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/usage` | Aggregated RAM and disk usage with configured limits |

Sample response:

```json
{
  "memory": { "usedMib": 1280, "limitMib": 8192 },
  "disk":   { "usedBytes": 524288000, "limitBytes": 21474836480 }
}
```

`limitMib` / `limitBytes` are `null` when the corresponding limit is disabled in `config.yml` (omitted or set to `0`). `usedMib` is the live reservation sum across active sandboxes; `usedBytes` is the live `fs.stat` total across ready snapshot tarballs (see [Resource Limits](#resource-limits) for details). The endpoint is unauthenticated when `auth.enabled: false`; otherwise it requires the same credentials as the rest of the API.

## Architecture

```
operator/
  src/                          # NestJS backend
    config/                     # YAML config loader with env var resolution
    schemas/                    # Mongoose schemas (Sandbox, SandboxProfile, Snapshot, McpProfile)
    repositories/               # Base repository with extension scoping
    sandboxes/                  # Sandbox CRUD, command execution, TTL service, registry
    snapshots/                  # Snapshot create/restore/persist/delete
    sandbox-profiles/           # Reusable sandbox configuration templates
    mcp/                        # MCP HTTP server
    terminal/                   # WebSocket terminal gateway
    health/                     # Health checks
  frontend/                     # React SPA
    src/
      components/Sandboxes/     # SandboxesPage, TerminalDrawer, FilePreviewDrawer
      components/Snapshots/     # SnapshotsPage
      components/Profiles/      # ProfilesPage, ProfileModal
      components/Mcp/           # McpPage, McpProfileModal
      api/                      # API client + types
      hooks/                    # React Query hooks
```

## Docker Compose

Both backend (`./Dockerfile`) and frontend (`./frontend/Dockerfile`) ship as Docker images. The frontend image is a multi-stage Vite build served by nginx, with `/api` and `/ws` proxied to the `app` service. Infrastructure services use the `infra` profile and are optional:

```bash
# App + frontend only (connect to external Mongo/Redis/runtime)
docker compose up

# Everything local (Mongo, Redis, microsandbox)
docker compose --profile infra up
```

The frontend listens on `${FRONTEND_PORT:-5174}` and proxies API traffic to the `app` container internally.

Connection URIs are configured via environment variables or `config.yml`:
- `DATABASE_URI` — MongoDB
- `REDIS_URL` — Redis

## Devic Integration

To use with the Devic platform, configure extensions in `config.yml`:

```yaml
extensions:
  properties:
    - name: clientUID
      type: string
      required: true
      index: true
      entities: "*"
      source: header
      headerName: x-client-uid
    - name: projectId
      type: string
      required: false
      index: true
      entities: "*"
      source: header
      headerName: x-project-id
```

Devic sends these headers automatically. No code changes needed.

## Roadmap

Planned improvements:

- **External snapshot storage** — Support for pluggable storage backends (S3, GCS, Azure Blob) for snapshot archives. Currently stored on the local filesystem under `~/.devic-sandbox/snapshots/` (legacy `~/.microsandbox/snapshots/` is still read transparently).
- **Snapshot scheduling** — Periodic auto-snapshots for long-running sandboxes.
- **Resource metrics** — Per-sandbox CPU, memory, disk and network usage from the active runtime backend.
- **Additional runtime backends** — gVisor (`runsc`) and Daytona self-hosted are candidates once the abstraction stabilises.

## License

Apache-2.0
