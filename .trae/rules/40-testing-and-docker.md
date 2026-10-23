---
description: Test, build and Docker operation standards
globs: ["**/*.test.ts", "Dockerfile", "compose.yaml", "package.json"]
alwaysApply: true
---

# 40 — Tests, build and Docker

Details: [docs/tests.md](../../docs/tests.md) and
[docs/docker-operation.md](../../docs/docker-operation.md).

## Commands

```bash
npm install          # installs the workspaces (@ups-monitor/backend + @ups-monitor/frontend)
npm test             # backend and frontend tests (vitest)
npm run test:backend
npm run test:frontend
npm run build        # backend (tsc) + frontend (tsc --noEmit && vite build)
npm run dev:backend  # tsx watch; use VIEWER_HTTP_PORT=8181
npm run dev:frontend # vite on 5173, proxy to VIEWER_BACKEND_URL
```

## Test standards

1. **No test depends on hardware**, a serial port or the real API: use the fake HTTP server
   (`src/backend/tests/helpers/fakeUpstream.ts`) and contract fixtures.
2. **Cover the four mandatory cases**: valid response, degraded response (`stale`, `data:null`, `503`),
   failure (timeout, network, invalid JSON, divergent contract) and a non-allowed method.
3. **Test that `null` does not become `0`** and that a missing value is not invented, both in the
   backend (`contract.test.ts`) and in the frontend (`metrics.test.ts` and `batteryTest.test.ts` — in
   particular `estimate.available: false`, which must never become a number).
4. **Test that the reading is GET-only** and that write methods are refused locally, with the single
   exception of `POST` on the `/api/tests*` routes of the battery test (never autonomous).
5. Prefer **pure functions** for the presentation logic (geometry, formatting, state translation,
   notices) — that is what keeps the frontend testable without a DOM.
6. Verify, in `server.test.ts`, that the telemetry is forwarded **identical** (without renaming fields).
7. `npm run build` must pass before considering a change complete (the frontend's `tsc --noEmit` also
   covers the tests).

## Docker

1. **Multi-stage** `Dockerfile`: build (TypeScript + Vite) → lean runtime (`npm install --omit=dev`,
   compiled backend, interface in `/app/public`).
2. Run as a **non-root** user (`USER node`).
3. **Healthcheck on `/healthz`**, which does **not** query the telemetry API — an offline UPS unit must
   not restart the container.
4. On Linux, `host.docker.internal` does **not** exist by default: keep
   `extra_hosts: ["host.docker.internal:host-gateway"]` in `compose.yaml`.
5. Never assume that `localhost` inside the container corresponds to the host.
6. Do not create volumes: the application does not persist state.
7. `.env.example` without secrets; `.env` is never versioned (it is already in `.gitignore`).

## Delivery

When completing a change, report: files created/changed, tests run, result and open items. If you find
a divergence between code, examples and the API documentation, **stop the affected decision and report
the divergence** before adapting.
