# =============================================================================
# UPS Monitor — Web Viewer (build multi-stage)
#
# Estágio 1 (build): compila o backend (TypeScript) e o frontend (Vite).
# Estágio 2 (runtime): imagem enxuta somente com dependências de produção,
#                      o backend compilado e a interface estática.
# =============================================================================

ARG NODE_VERSION=20

# --------------------------------------------------------------- build ------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app

# Manifests primeiro: mantém o cache das dependências entre builds.
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

# Somente dependências de produção (o único runtime é o express).
COPY package.json ./
COPY src/backend/package.json ./src/backend/package.json
COPY src/frontend/package.json ./src/frontend/package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Backend compilado e interface estática (servida pelo próprio backend, mesma
# origem: sem CORS e sem expor o endereço da API no navegador).
COPY --from=build /app/src/backend/dist ./src/backend/dist
COPY --from=build /app/src/frontend/dist ./public

USER node
EXPOSE 8080

# O healthcheck avalia o PRÓPRIO container (não depende da API de telemetria,
# para que um nobreak offline não faça o Docker reiniciar a aplicação).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VIEWER_HTTP_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/backend/dist/index.js"]
