# UPS Monitor — Web Viewer

Dashboard web que exibe a telemetria de nobreaks publicada pela API REST local do projeto
**Monitoramento UPS** (`GET /health`, `GET /api/v1/ups`, `GET /api/v1/ups/{device_id}/telemetry`,
`GET /api/v1/ups/{device_id}/identity`) e permite, **por ação explícita do usuário**, pedir o teste
de bateria do contrato 3.0 (`POST/GET /api/v1/ups/{device_id}/tests`) — `duration_10s` (janela de
~10 s) ou, onde o equipamento declara, `discharge_20pct` (descarga até a carga cair a 20 %, com teto
de 30 min, o que vier primeiro).

O Web Viewer **não** acessa porta serial, não implementa os protocolos dos nobreaks (Megatec/Q1,
`sms-1phase`), não executa o coletor e **não envia comandos ao nobreak**: o único pedido de escrita é
repassado à API de origem, que é quem comanda o equipamento. **Nenhum teste é disparado de forma
autônoma.**

- Escopo oficial: [UPS_Web_Viewer_Scope.md](./UPS_Web_Viewer_Scope.md)
- Arquitetura: [docs/arquitetura.md](./docs/arquitetura.md)
- Contrato consumido: [docs/contrato-api.md](./docs/contrato-api.md)
- Decisões técnicas: [docs/decisoes-tecnicas.md](./docs/decisoes-tecnicas.md)
- Testes: [docs/testes.md](./docs/testes.md)
- Operação com Docker: [docs/operacao-docker.md](./docs/operacao-docker.md)
- Identidade visual: [docs/design-system.md](./docs/design-system.md)

> **Estado atual:** validado com nobreaks de **duas marcas/protocolos** — TS Shara Universal UPS
> Senoidal 3200VA (`tsshara-3200va-01`, USB CDC-ACM `/dev/ttyACM0`, Megatec/Q1) e SMS Power Sinus
> NG uPS3200S (`sms-ups3200s-01`, USB-Serial, `sms-1phase`). O projeto não depende desses modelos:
> os equipamentos são descobertos em `GET /api/v1/ups` e a interface permite escolher **um por vez**;
> os campos são lidos pelo contrato, sem nomes fixos no código. Consome o **contrato 3.0** da API
> unificada (multidispositivo + teste de bateria).

---

## 1. Arquitetura em uma imagem

```
Nobreaks (N) ── USB ──▶ Máquina Ubuntu (projeto Monitoramento UPS)
                      coletores por protocolo → telemetria em memória → API REST (v1 / 3.0)
                                                                        │ HTTP GET + POST (teste)
                                                                        ▼
                                       Container do Web Viewer
                                       ┌──────────────────────────────────────────┐
   navegador ── HTTP ──▶ :8090 ───────▶│ backend (Node/Express)                    │
                                       │  • valida o contrato                      │
                                       │  • proxy de leitura (resolve CORS)         │
                                       │  • publica /api/config, /api/dashboard     │
                                       │  • serve a interface compilada (mesma      │
                                       │    origem: nenhum endereço de API exposto) │
                                       └──────────────────────────────────────────┘
```

O navegador conversa **apenas** com o próprio backend, na mesma origem. Quem fala com a API de
telemetria é o container — por isso não há CORS e o endereço da API não aparece no navegador.

## 2. Estrutura do repositório

```
UPS Web Viewer/
├── README.md                      # este arquivo
├── UPS_Web_Viewer_Scope.md        # escopo oficial (equivalente ao SCOPE.md sugerido)
├── docs/                          # arquitetura, contrato, design, decisões, testes, operação
├── .trae/rules/                   # regras de contexto do projeto para o assistente
├── src/
│   ├── backend/                   # proxy de leitura + validação + servidor da interface
│   │   ├── src/                   # contract, apiClient, dashboard, config, server, logger
│   │   └── tests/                 # testes de contrato, cliente HTTP, serviço e servidor
│   └── frontend/                  # dashboard React + TypeScript (Vite)
│       ├── src/
│       │   ├── api/               # cliente HTTP da própria origem
│       │   ├── components/        # gauge SVG, cartões, cabeçalho, flags, detalhes, avisos
│       │   ├── demo/              # dados SIMULADOS (só em desenvolvimento)
│       │   ├── hooks/             # atualização periódica
│       │   ├── model/             # contrato, formatação, métricas, estados
│       │   └── styles/
│       └── tests/                 # testes dos modelos, avisos e cliente HTTP
├── Dockerfile                     # build multi-stage
├── compose.yaml
├── .dockerignore
└── .env.example
```

## 3. Requisitos

| Uso | Requisitos |
|---|---|
| Produção | Docker Engine 24+ e Docker Compose v2 |
| Desenvolvimento local | Node.js 20 LTS (>= 18.19) e npm 10+ |
| API de telemetria | Acessível pela rede, respondendo o contrato `v1` / `contract_version` `3.0` (API unificada, N nobreaks) |

## 4. Execução com Docker (recomendada)

```bash
cp .env.example .env          # ajuste UPS_API_BASE_URL (e, se quiser, a porta publicada)
docker compose up --build -d
docker compose logs -f
```

Abra `http://<ip-da-maquina>:8090` (porta configurável por `VIEWER_HTTP_PORT`).

Encerrar:

```bash
docker compose down
```

Detalhes, diagnóstico e solução de problemas: [docs/operacao-docker.md](./docs/operacao-docker.md).

### `localhost` dentro do container

Dentro do container, `localhost` e `127.0.0.1` apontam para o **próprio container**, nunca para a
máquina Ubuntu que tem o cabo USB. O `compose.yaml` já registra
`host.docker.internal:host-gateway`, então o padrão `UPS_API_BASE_URL=http://host.docker.internal:8080`
funciona desde que a API escute em todas as interfaces:

```bash
python3 scripts/run_api.py --http-host 0.0.0.0 --http-port 8080    # no projeto Monitoramento UPS
```

## 5. Desenvolvimento local

```bash
npm install                     # instala os workspaces (backend + frontend)
npm test                        # testes do backend e do frontend
npm run build                   # compila backend (tsc) e frontend (vite build)
```

Dois terminais:

```bash
# terminal 1 — backend em http://127.0.0.1:8181
VIEWER_HTTP_PORT=8181 UPS_API_BASE_URL=http://127.0.0.1:8080 npm run dev:backend

# terminal 2 — interface em http://127.0.0.1:5173 (proxy para o backend)
npm run dev:frontend
```

O Vite faz proxy de `/api` e `/healthz` para `VIEWER_BACKEND_URL` (padrão `http://127.0.0.1:8181`).

Para pré-visualizar o layout **sem** a API, o arquivo `src/frontend/.env.development` define
`VITE_ENABLE_DEMO=true`. Nesse modo a interface exibe uma faixa **MODO DEMONSTRAÇÃO** e os valores
são simulados — nunca são apresentados como telemetria real. Fora do modo de desenvolvimento a
variável não existe e o modo demo fica desligado.

## 6. Configuração

Todas as variáveis estão documentadas em [.env.example](./.env.example). Resumo:

| Variável | Padrão | Função |
|---|---|---|
| `VIEWER_HTTP_PORT` | `8080` no container / `8090` no host | Porta HTTP do serviço |
| `VIEWER_HTTP_HOST` | `0.0.0.0` | Interface de escuta |
| `VIEWER_STATIC_DIR` | — | Pasta da interface compilada (definida na imagem) |
| `UPS_API_BASE_URL` | `http://127.0.0.1:8080` | Endereço-base da API de telemetria |
| `UPS_DEVICE_ID` | vazio | Fixa um equipamento; vazio = descobre via `GET /api/v1/ups` |
| `UPS_API_TIMEOUT_MS` | `4000` | Tempo limite de cada requisição à API |
| `UPS_API_CACHE_TTL_MS` | `1500` | Cache curto em memória da telemetria |
| `UPS_API_IDENTITY_TTL_MS` | `60000` | Cache da identificação do equipamento |
| `VIEWER_REFRESH_INTERVAL_MS` | `5000` | Intervalo de atualização da interface |
| `VIEWER_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `VIEWER_GAUGE_THRESHOLDS` | vazio | JSON com as faixas **padrão validadas** dos gauges |

Valores inválidos (número fora de faixa, URL malformada, JSON incoerente) **não** passam em
silêncio: a configuração encerra o processo com código `2` e as faixas divergentes são reportadas em
`threshold_problems` na interface.

## 7. Endpoints publicados pelo Web Viewer

Somente `GET`, exceto as rotas do teste de bateria (`/api/tests*`), que também aceitam `POST` — só
depois de uma ação do usuário. Os demais métodos recebem `405` com
`{"error":{"code":"method_not_allowed", ...}}`.

| Endpoint | Descrição |
|---|---|
| `GET /healthz` | Saúde do **container** (não depende da API de telemetria) |
| `GET /api/config` | Nome, versão, intervalo de atualização, definição dos gauges e avisos de faixa |
| `GET /api/dashboard` | Instantâneo validado: `viewer`, `health`, `devices`, `telemetry`, `identity`, `tests`. `?device_id=` escolhe **um** nobreak (ausente → o backend resolve pelo padrão) |
| `GET /api/devices` | Lista de equipamentos (`GET /api/v1/ups` repassado, com `capabilities.battery_test`) |
| `POST /api/tests` | Pede o teste de bateria (`?device_id=`, corpo `{"type":"duration_10s"}` ou `{"type":"discharge_20pct"}` — só os tipos que o equipamento declara em `test_types`); responde `202` com o aceite — **não** é o resultado |
| `GET /api/tests/{test_id}` | Relatório do teste (parcial enquanto `running`) |
| `POST /api/tests/{test_id}/abort` | Cancelamento, quando o equipamento declara `abort_supported` |

Códigos de `/api/dashboard`: `200` (dados utilizáveis, mesmo quando a API respondeu `503` com
telemetria ausente/desatualizada — o estado real vem em `stale`, `telemetry_valid` e
`communication.state`), `404` (`device_not_found`, `no_devices_configured`), `502`
(`upstream_unreachable`, `upstream_timeout`, `upstream_invalid_json`, `upstream_unexpected_status`,
`upstream_contract_mismatch`), `500` (`viewer_internal_error`).

Contrato completo: [docs/contrato-api.md](./docs/contrato-api.md).

## 8. Regras invioláveis

1. **Somente leitura — com uma exceção controlada.** Nenhum `PUT`/`PATCH`/`DELETE` é enviado à API
   de origem. O único `POST` é o do **teste de bateria**, atrás do backend do viewer e apenas por ação
   do usuário; nenhum comando é enviado diretamente ao nobreak e nenhum teste é disparado sozinho.
2. **Fidelidade ao contrato.** Nomes de campo, unidades e caminhos JSON são os da API. Nada é
   renomeado nem reinterpretado.
3. **`null` nunca vira `0`.** Campo ausente continua ausente e aparece como "Sem dados".
4. **Desatualizado não é atual.** Leitura `stale` é exibida com o rótulo "Desatualizado".
5. **Bateria — regra por protocolo.** No `megatec-q1`, `data.battery_charge.percent` é **estimativa**
   (interpolação da tensão) e a tensão da bateria aparece como medição em campo separado; no
   `sms-1phase`, `data.battery.charge_percent` é **informado pelo equipamento** e **não** é estimativa.
6. **Sem inferência de "rede normal".** A ausência da flag `OB` não é apresentada como rede
   elétrica normal.
7. **A cor não é o único sinal.** Todo gauge e todo aviso combina cor + valor + texto.
8. **Faixas validadas e configuráveis.** Os limites vermelho/âmbar/verde foram validados pelo
   solicitante (2026-10-21), mas **não** são recomendações oficiais do fabricante e continuam
   sobrescrevíveis por `VIEWER_GAUGE_THRESHOLDS`.
9. **Sem segredos versionados.** A API de origem não autentica; nenhum token é usado.
10. **A API entrega fatos; o Web Viewer apresenta.** A autonomia do teste é a extrapolação publicada
    pela API, marcada `confidence: "low"`. Quando `estimate.available` é `false`, a interface exibe o
    `reason` — **nunca** converte a ausência em número.

## 9. Pendências conhecidas

- **Faixas dos gauges**: validadas para o parque conhecido; para um modelo/marca diferente, ajustar
  por `VIEWER_GAUGE_THRESHOLDS`.
- **Identificação**: exibida apenas quando a API publica `identity`; campos ausentes aparecem
  como "—".
- **Histórico**: fora do escopo desta versão (somente a leitura atual). O histórico de **testes de
  bateria** existe, mas é em memória na API de origem e se perde quando o serviço reinicia.
- **"Serviços ligados no nobreak"**: ainda não implementado — será mapeado manualmente (ex.: Servidor
  Londres, Firewall, Routers) e exibido **abaixo** do bloco "Estado operacional".
- **Documentação do estilo**: o escopo §4.1 e a regra 30-ui-ux ainda descrevem fundo branco; a
  interface adota o palco escuro de quatro quadrantes (decisão D16 em
  [docs/decisoes-tecnicas.md](./docs/decisoes-tecnicas.md)).
