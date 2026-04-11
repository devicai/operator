# Devic Sandbox

Open-source sandbox orchestration module for the Devic AI platform. Provides a REST API and MCP (Model Context Protocol) interface for managing isolated execution environments using [microsandbox](https://github.com/nichochar/microsandbox).

## Features

- **Sandbox lifecycle management** — create, run commands, stop, destroy
- **Sandbox profiles** — reusable configurations (image, resources, env vars, init scripts)
- **TTL auto-expiration** — sandboxes expire automatically after configurable time
- **MCP integration** — 11 tools for AI agents to manage sandboxes transparently
- **MCP profiles** — scoped access control for MCP sessions
- **Binding system** — associate sandboxes with external identifiers (threads, sessions)
- **Terminal WebSocket** — real-time shell access via WebSocket
- **Entity extensions** — config-driven multi-tenancy without code changes
- **API key authentication** — configurable auth for API and MCP endpoints

## Quick Start

```bash
# Install dependencies
yarn install

# Configure
cp config.example.yml config.yml

# Start infrastructure (MongoDB + Redis + Microsandbox)
docker compose --profile infra up -d

# Start backend
yarn start:dev

# Start frontend (in another terminal)
cd frontend && yarn install && yarn dev
```

Backend: http://localhost:3200  
Frontend: http://localhost:5174  
API Docs: http://localhost:3200/api/v1/docs  
MCP: http://localhost:3200/api/v1/mcp  

## Architecture

```
┌─────────────────────────────────────────────┐
│  Frontend (React + Vite :5174)             │
│  Sandboxes | Profiles | MCP | API          │
└────────────────┬────────────────────────────┘
                 │ HTTP / WebSocket
┌────────────────▼────────────────────────────┐
│  Backend (NestJS :3200)                    │
│  ┌──────────────────────────────────────┐  │
│  │ SandboxesService ←→ SandboxRegistry  │  │
│  │ SandboxProfilesService               │  │
│  │ McpController (StreamableHTTP)       │  │
│  │ TerminalGateway (WebSocket)          │  │
│  │ SandboxTtlService (cron)             │  │
│  └──────────────────────────────────────┘  │
└────────┬──────────┬──────────┬─────────────┘
         │          │          │
    MongoDB      Redis    Microsandbox
```

## Configuration

See `config.example.yml` for all options. Key sections:

- `microsandbox` — default image, resources, TTL limits
- `mcp` — enable/disable MCP server
- `auth` — API key authentication
- `extensions` — multi-tenancy properties (for Devic integration)

## License

Apache 2.0
