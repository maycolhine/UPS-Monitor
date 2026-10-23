---
description: Arquitetura, stack e organização de código do Web Viewer
globs:
alwaysApply: true
---

# 10 — Arquitetura

Referência completa: [docs/arquitetura.md](../../docs/arquitetura.md).

## Stack

| Camada | Tecnologia |
|---|---|
| Backend (proxy de leitura + servidor) | Node.js 20 + Express + TypeScript (ESM) |
| Frontend | React 18 + TypeScript + Vite |
| Gauges | SVG próprio (sem biblioteca de gráficos) |
| Testes | Vitest (backend e frontend) |
| Organização | npm workspaces (`src/backend`, `src/frontend`) |
| Empacotamento | Docker multi-stage; o backend serve a interface estática |

## Fluxo

```
navegador → backend do Web Viewer (/api/dashboard) → API de telemetria (HTTP GET)
```

O navegador fala **somente** com o próprio backend, na mesma origem. Isso elimina CORS e mantém o
endereço da API fora do navegador. O backend só consulta e repassa: não coleta, não persiste.

## Estrutura

```
src/backend/src/     config.ts, logger.ts, apiClient.ts, contract.ts,
                     gaugeConfig.ts, dashboard.ts, server.ts, index.ts
src/backend/tests/   contract, apiClient, gaugeConfig, server, config + helpers/
src/frontend/src/    api/, components/, demo/, hooks/, model/, styles/
src/frontend/tests/  metrics, status, notices, client, batteryTest
```

## Regras de código

1. **Separação de camadas**: consulta HTTP (`apiClient`), contrato (`contract`), orquestração
   (`dashboard`), transporte HTTP (`server`), configuração (`config`). A interface não conhece a API.
2. **Sem IP, host ou `device_id` fixos no código.** Tudo vem de variáveis de ambiente.
3. **Sem persistência e sem banco de dados.**
4. **Dependências enxutas**: qualquer biblioteca nova precisa de justificativa registrada em
   [docs/decisoes-tecnicas.md](../../docs/decisoes-tecnicas.md).
5. **Comentários em português**, explicando o "porquê" (as decisões do escopo), não o "o quê".
6. **`strict` + `noUncheckedIndexedAccess`** estão ligados: trate índices possivelmente indefinidos.
7. Importações relativas entre módulos TS usam a extensão `.js` (padrão ESM do projeto).
8. O healthcheck do container (`GET /healthz`) **não** deve depender da API de telemetria.
