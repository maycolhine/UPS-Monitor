---
description: Padrões de teste, build e operação com Docker
globs: ["**/*.test.ts", "Dockerfile", "compose.yaml", "package.json"]
alwaysApply: true
---

# 40 — Testes, build e Docker

Detalhes: [docs/testes.md](../../docs/testes.md) e
[docs/operacao-docker.md](../../docs/operacao-docker.md).

## Comandos

```bash
npm install          # instala os workspaces (backend + frontend)
npm test             # testes do backend e do frontend (vitest)
npm run test:backend
npm run test:frontend
npm run build        # backend (tsc) + frontend (tsc --noEmit && vite build)
npm run dev:backend  # tsx watch; use VIEWER_HTTP_PORT=8181
npm run dev:frontend # vite em 5173, proxy para VIEWER_BACKEND_URL
```

## Padrões de teste

1. **Nenhum teste depende de hardware**, de porta serial ou da API real: use o servidor HTTP falso
   (`src/backend/tests/helpers/fakeUpstream.ts`) e fixtures do contrato.
2. **Cubra os quatro casos obrigatórios**: resposta válida, resposta degradada (`stale`,
   `data:null`, `503`), falha (timeout, rede, JSON inválido, contrato divergente) e método não
   permitido.
3. **Teste que `null` não vira `0`** e que valor ausente não é inventado, tanto no backend
   (`contract.test.ts`) quanto no frontend (`metrics.test.ts` e `batteryTest.test.ts` — em especial
   `estimate.available: false`, que nunca deve virar número).
4. **Teste que a leitura é somente GET** e que métodos de escrita são recusados localmente, com a
   única exceção de `POST` nas rotas `/api/tests*` do teste de bateria (nunca autônomo).
5. Prefira **funções puras** para a lógica de apresentação (geometria, formatação, tradução de
   estados, avisos) — é o que mantém o frontend testável sem DOM.
6. Verifique, no `server.test.ts`, que a telemetria é repassada **idêntica** (sem renomear campos).
7. `npm run build` precisa passar antes de considerar uma alteração concluída (o `tsc --noEmit` do
   frontend cobre também os testes).

## Docker

1. `Dockerfile` **multi-stage**: build (TypeScript + Vite) → runtime enxuto (`npm install
   --omit=dev`, backend compilado, interface em `/app/public`).
2. Rode como usuário **não root** (`USER node`).
3. **Healthcheck em `/healthz`**, que **não** consulta a API de telemetria — um nobreak offline não
   pode reiniciar o container.
4. No Linux, `host.docker.internal` **não** existe por padrão: mantenha
   `extra_hosts: ["host.docker.internal:host-gateway"]` no `compose.yaml`.
5. Nunca presuma que `localhost` dentro do container corresponde ao host.
6. Não crie volumes: a aplicação não persiste estado.
7. `.env.example` sem segredos; `.env` nunca é versionado (já está no `.gitignore`).

## Entrega

Ao concluir uma alteração, informe: arquivos criados/alterados, testes executados, resultado e
pendências. Se encontrar divergência entre código, exemplos e documentação da API,
**interrompa a decisão afetada e relate a divergência** antes de adaptar.
