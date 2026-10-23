# =============================================================================
# UPS Monitor — Web Viewer (multi-stage build)
#
# Stage 1 (build): compiles the backend (TypeScript) and the frontend (Vite).
# Stage 2 (runtime): lean image with production dependencies only, the compiled
#                    backend and the static interface.
# =============================================================================

ARG NODE_VERSION=20

# --------------------------------------------------------------- build ------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app

# Manifests first: keeps the dependency cache warm across builds.
COPY package.json tsconfig.base.json ./
COPY src/backend/package.json ./src/backend/package.json
COPY src/frontend/package.json ./src/frontend/package.json
RUN npm install --no-audit --no-fund

COPY src ./src
RUN npm run build

# ------------------------------------------------------------- runtime ------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    VIEWER_HTTP_HOST=0.0.0.0 \
    VIEWER_HTTP_PORT=8080 \
    VIEWER_STATIC_DIR=/app/public

# Production dependencies only (the single runtime dependency is express).
COPY package.json ./
COPY src/backend/package.json ./src/backend/package.json
COPY src/frontend/package.json ./src/frontend/package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Compiled backend and static interface (served by the backend itself, same
# origin: no CORS and the API address is never exposed to the browser).
COPY --from=build /app/src/backend/dist ./src/backend/dist
COPY --from=build /app/src/frontend/dist ./public

USER node
EXPOSE 8080

# The healthcheck probes the CONTAINER itself (it does not depend on the
# telemetry API, so an offline UPS cannot make Docker restart the application).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VIEWER_HTTP_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/backend/dist/index.js"]
