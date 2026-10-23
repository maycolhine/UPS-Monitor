---
description: Architecture, stack and code organization of the Web Viewer
globs:
alwaysApply: true
---

# 10 — Architecture

Full reference: [docs/architecture.md](../../docs/architecture.md).

## Stack

| Layer | Technology |
|---|---|
| Backend (read proxy + server) | Node.js 20 + Express + TypeScript (ESM) |
| Frontend | React 18 + TypeScript + Vite |
| Gauges | Custom SVG (no chart library) |
| Tests | Vitest (backend and frontend) |
| Organization | npm workspaces (`src/backend`, `src/frontend`) |
| Packaging | Multi-stage Docker; the backend serves the static interface |

## Flow

```
browser → Web Viewer backend (/api/dashboard) → telemetry API (HTTP GET)
```

The browser talks **only** to its own backend, on the same origin. This eliminates CORS and keeps the
API address out of the browser. The backend only queries and forwards: it does not collect, it does not
persist.

## Structure

```
src/backend/src/     config.ts, logger.ts, apiClient.ts, contract.ts,
                     gaugeConfig.ts, dashboard.ts, server.ts, index.ts
src/backend/tests/   contract, apiClient, gaugeConfig, server, config + helpers/
src/frontend/src/    api/, components/, demo/, hooks/, model/, styles/
src/frontend/tests/  metrics, status, notices, client, batteryTest
```

## Code rules

1. **Layer separation**: HTTP query (`apiClient`), contract (`contract`), orchestration (`dashboard`),
   HTTP transport (`server`), configuration (`config`). The interface does not know the API.
2. **No fixed IP, host or `device_id` in the code.** Everything comes from environment variables.
3. **No persistence and no database.**
4. **Lean dependencies**: any new library needs a recorded justification in
   [docs/technical-decisions.md](../../docs/technical-decisions.md).
5. **Comments in English**, explaining the "why" (the scope decisions), not the "what".
6. **`strict` + `noUncheckedIndexedAccess`** are on: handle possibly undefined indices.
7. Relative imports between TS modules use the `.js` extension (the project's ESM convention).
8. The container healthcheck (`GET /healthz`) **must not** depend on the telemetry API.
