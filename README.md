# Devic Sandbox

Standalone sandbox orchestration layer using [microsandbox](https://github.com/nichochar/microsandbox) for ephemeral, secure code execution environments.

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
- [microsandbox](https://github.com/nichochar/microsandbox) runtime installed

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
| `microsandbox` | Default image, CPUs, memory, TTL limits |
| `mcp` | MCP server (enabled, path) |
| `extensions` | Dynamic entity scoping (for multi-tenancy) |
| `auth` | API key or JWT authentication |
| `webhooks` | Event-driven HTTP callbacks |

### Microsandbox Defaults

```yaml
microsandbox:
  defaultImage: node:24
  defaultCpus: 1
  defaultMemoryMib: 256
  defaultTtlSeconds: 1800    # 30 minutes
  maxTtlSeconds: 7200        # 2 hours max
  ttlCheckIntervalMs: 30000  # Check every 30s
```

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
| DELETE | `/api/v1/snapshots/:id` | Delete snapshot |

#### Snapshot Restore Modes

The restore endpoint accepts a `linked` flag:

- **`linked: true`** (default) — Sandbox stays linked to the snapshot. On stop or TTL expiry, changes are automatically persisted back to the snapshot.
- **`linked: false`** — Fully independent sandbox (fork). The snapshot remains unchanged regardless of what happens in the sandbox.

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

### Health

| Endpoint | Description |
|----------|-------------|
| GET `/health` | Basic health check |
| GET `/health/ready` | Readiness (DB + Redis) |

## Architecture

```
devic-sandbox/
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

Infrastructure services use the `infra` profile and are optional:

```bash
# App only (connect to external Mongo/Redis/microsandbox)
docker compose up

# Everything local
docker compose --profile infra up
```

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

- **External snapshot storage** — Support for pluggable storage backends (S3, GCS, Azure Blob) for snapshot archives. Currently stored on the local filesystem under `~/.microsandbox/snapshots/`.
- **Snapshot scheduling** — Periodic auto-snapshots for long-running sandboxes.
- **Resource metrics** — CPU, memory, disk, and network usage monitoring per sandbox via the microsandbox metrics API.

## License

Apache-2.0
