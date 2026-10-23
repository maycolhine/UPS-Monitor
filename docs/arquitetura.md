# Arquitetura

## 1. Visão geral

```
┌─────────────────────────┐        ┌──────────────────────────────────────┐
│ Nobreaks (N)            │        │ Projeto Monitoramento UPS (externo)  │
│ ─ TS Shara (Megatec/Q1) │        │ coletores por protocolo →            │
│   USB CDC-ACM 0483:5740 │───────▶│ telemetria em memória → API REST     │
│ ─ SMS (sms-1phase)      │  USB   │ unificada (v1 / contract_version 3.0)│
│   USB-Serial 067b:23d3  │        │ 1 porta / N equipamentos             │
└─────────────────────────┘        └───────────────┬──────────────────────┘
                                                   │ HTTP GET + POST (teste)
                                                   ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │ Container "ups-web-viewer"                               │
                    │                                                          │
                    │  backend Node/Express (src/backend)                      │
                    │   ├─ config.ts     variáveis de ambiente (sem IP fixo)   │
                    │   ├─ apiClient.ts  cliente HTTP: GET + POST (só testes)  │
                    │   ├─ contract.ts   validação/normalização do contrato    │
                    │   ├─ gaugeConfig.ts definição das métricas e faixas     │
                    │   ├─ dashboard.ts  serviço: descobre, consulta, cacheia  │
                    │   └─ server.ts     /healthz /api/config /api/dashboard   │
                    │                    /api/devices /api/tests + interface   │
                    │                                                          │
                    │  frontend React/TS (compilado para /app/public)          │
                    └───────────────┬──────────────────────────────────────────┘
                                    │ HTTP (mesma origem)
                                    ▼
                            Navegador do usuário
```

## 2. Fronteiras de responsabilidade

| Componente | Faz | Não faz |
|---|---|---|
| Projeto Monitoramento UPS | Lê a USB, implementa Q1, mantém a telemetria e publica a API | Não conhece o Web Viewer |
| Backend do Web Viewer | Consulta a API por GET, valida o contrato, publica um payload único, serve a interface | Não abre porta serial, não envia comandos, não grava histórico |
| Frontend | Renderiza gauges, estados e detalhes; atualiza em ciclo | Não conhece o endereço da API, não faz requisições diretas à API de telemetria |

O Web Viewer é um **consumidor** do contrato HTTP/JSON. Ele não depende de a API ser FastAPI nem de
qualquer detalhe de implementação do outro projeto.

## 3. Por que existe um backend no container

O escopo (§7.1) pede uma escolha explícita entre o navegador consultar a API diretamente ou existir
um proxy de leitura no container. A escolha foi o **proxy**, por quatro motivos:

1. **CORS.** A API de origem não envia cabeçalhos CORS. Com o proxy, o navegador só fala com a
   própria origem.
2. **Exposição de rede.** O endereço da API não chega ao navegador; só o backend o conhece.
3. **Ponto único de validação.** O contrato é verificado uma vez, no backend, e a interface recebe
   um payload já classificado (disponível / degradado / falha).
4. **Interface servida junto.** A mesma origem serve o HTML/JS e a API do viewer, o que simplifica
   o deploy e evita outra porta.

O proxy **não** faz coleta, **não** persiste nada e **não** duplica lógica do projeto de origem —
ele só consulta e repassa.

## 4. Módulos do backend

| Arquivo | Responsabilidade |
|---|---|
| [config.ts](../src/backend/src/config.ts) | Lê e valida as variáveis de ambiente. Encerra com código `2` em caso de valor inválido. |
| [logger.ts](../src/backend/src/logger.ts) | Log em uma linha, níveis `debug`/`info`/`warn`/`error`. |
| [apiClient.ts](../src/backend/src/apiClient.ts) | `UpstreamApiClient`: GET e POST (este último só nas rotas de teste), timeout por `AbortController`, erros classificados (`upstream_unreachable`, `upstream_timeout`, `upstream_invalid_json`, ...). Recusa qualquer outro método localmente (`viewer_invalid_method`). Nunca lança exceção para o chamador. |
| [contract.ts](../src/backend/src/contract.ts) | `parseTelemetry`, `parseIdentity`, `parseDevices`, `parseHealth`, `parseErrorPayload` e os parsers do teste (`parseBatteryTestAccept`, `parseBatteryTestReport`, `parseBatteryTestAbort`, `parseTestsList`). Preserva `null`, não renomeia campos, mantém campos extras e devolve `problems` com divergências. Conhece o contrato 3.0 (bloco `battery` do SMS, `status.raw_byte`, `/health` agregado, `capabilities.battery_test` com `test_types`/`types`, `samples[].normalized`, `target_percent`/`timeout_s` e o relatório de previsibilidade). |
| [gaugeConfig.ts](../src/backend/src/gaugeConfig.ts) | `GAUGE_DEFINITIONS` (métricas, escalas e **faixas validadas**), `applyGaugeOverrides` (JSON por env) e `readMetricValue`. Cada métrica declara `sources[]` (um caminho por protocolo, em ordem de preferência). |
| [dashboard.ts](../src/backend/src/dashboard.ts) | `ViewerService`: `resolveDeviceId` escolhe o nobreak (pedido → config → primeiro válido → primeiro da lista → `/health`), consulta `/health`, `/api/v1/ups`, `/telemetry`, `/identity` e o histórico de `/tests`, monta `viewer` (fonte de cada consulta), cacheia por TTL e responde 200/404/502 conforme o caso. Também repassa as ações do teste (`startBatteryTest`, `getBatteryTestReport`, `abortBatteryTest`) preservando o HTTP e o `error.code` da API. |
| [server.ts](../src/backend/src/server.ts) | `createApp`: rotas do viewer, bloqueio de métodos ≠ GET (exceto `POST /api/tests*`), arquivos estáticos e fallback SPA, tratador de erro. |
| [index.ts](../src/backend/src/index.ts) | `start`/`main`, logs de inicialização e encerramento por SIGINT/SIGTERM. |

### Fluxo de `GET /api/dashboard`

1. `GET /health` (cache curto) — saúde agregada de todos os coletores.
2. Resolve o `device_id` (ver `resolveDeviceId`): `?device_id=` da interface → `UPS_DEVICE_ID` →
   `GET /api/v1/ups` (primeiro com `telemetry_valid:true`, senão o primeiro item) → primeira chave de
   `health.devices`. Um `?device_id=` que não consta da lista → `404 device_not_found`; sem nenhum
   identificador, responde `404 no_devices_configured` (ou `502 upstream_unreachable`).
3. `GET .../{device_id}/telemetry` e `GET .../{device_id}/identity`.
4. Valida cada resposta; se o corpo for um envelope de erro (`error.code`), separa isso do caso
   "contrato divergente".
5. Monta `viewer.sources` com o resultado de cada consulta (URL, HTTP, duração, erro, avisos).
6. Responde:
   - `200` com `telemetry` — inclui o caso em que a API respondeu `503` mas publicou um payload
     válido com `telemetry_valid:false`/`stale:true`; o estado real fica explícito nos campos;
   - `404` `device_not_found` quando a API respondeu com esse código;
   - `502` para falhas de transporte e divergências de contrato;
   - `500` `viewer_internal_error` para falhas inesperadas do próprio viewer.

### Cache

`fetch()` em [dashboard.ts](../src/backend/src/dashboard.ts) mantém um cache em memória por caminho,
com TTL configurável, e deduplica requisições simultâneas ao mesmo caminho. **Falhas não são
cacheadas**: a interface volta ao normal assim que a API responder.

### Fluxo do teste de bateria (contrato 3.0)

O teste é a **única** escrita do projeto e passa inteiramente pelo backend do viewer — o navegador
nunca fala com a API de origem.

1. A interface lê `capabilities.battery_test` do equipamento em `GET /api/v1/ups` (recebido no bloco
   `devices` do dashboard) e **só habilita** o botão quando `enabled` é `true`.
2. Ao clicar, a interface chama `POST /api/tests?device_id=...` com o `type` escolhido; o viewer
   repassa o `POST` à API e devolve o aceite (`202`, `test_id`, `type`, `poll_interval_s`,
   `report_url`). O teste **nunca** é disparado de forma autônoma.
3. A interface faz o polling de `GET /api/tests/{test_id}` a cada `poll_interval_s` até o status
   deixar de ser `running`.
4. Ao concluir, o painel apresenta os fatos do relatório — séries, `deltas`, `estimate` e
   `test_flag_observed` — e o histórico (`GET /api/v1/ups/{id}/tests`, no bloco `tests` do dashboard).
   A autonomia estimada é apenas **apresentada** — quando `estimate.available` é `false`, exibe-se o
   `reason`, nunca um número.
5. `POST /api/tests/{test_id}/abort` só é oferecido com `abort_supported`; caso contrário a interface
   avisa que o cancelamento apenas interrompe a amostragem.

**Dois tipos de teste.** O seletor do painel é montado **somente** com os tipos declarados em
`test_types` do equipamento: `duration_10s` (janela fixa de ~10 s, oferecido a todos que têm teste) e
`discharge_20pct` (descarga até a carga cair ao **alvo de 20 %**, com teto de segurança de 30 min —
o que vier primeiro; hoje só no `sms-1phase`, que sabe cancelar). Para o `discharge_20pct`, o parâmetro
é enviado "sem janela" de propósito; `duration_s` vem `null` e `timeout_s` (1800 s) é **teto**, não
duração prevista — o progresso é medido pela queda de carga, não pelo relógio.

## 5. Módulos do frontend

| Arquivo | Responsabilidade |
|---|---|
| [api/client.ts](../src/frontend/src/api/client.ts) | `fetchConfig`, `fetchDashboard(deviceId?)`, `startBatteryTest`/`fetchBatteryTestReport`/`abortBatteryTest` na própria origem (envia `?device_id=` quando um nobreak é escolhido); trata 503 como corpo útil e nunca lança exceção. |
| [App.tsx](../src/frontend/src/App.tsx) | Composição do palco em quatro quadrantes (contexto, medições, teste de bateria, detalhes), avisos, lista "Nobreaks coletados" com seleção clicável (`?device_id=`) e resolução da origem de cada gauge. |
| [hooks/useViewerData.ts](../src/frontend/src/hooks/useViewerData.ts) | Lê `/api/config` uma vez e atualiza `/api/dashboard?device_id=` em ciclo, sem sobreposição de requisições. |
| [hooks/useBatteryTest.ts](../src/frontend/src/hooks/useBatteryTest.ts) | Estado do teste: dispara o pedido (por ação do usuário), faz o polling do relatório e observa um teste já em andamento informado pelo histórico. |
| [model/contract.ts](../src/frontend/src/model/contract.ts) | Tipos do payload do viewer + tipos do contrato da API (3.0: `battery`, `raw_byte`, `health` agregado, `capabilities.battery_test`, relatório/estimativa do teste, `GaugeDefinition.sources`). |
| [model/batteryTest.ts](../src/frontend/src/model/batteryTest.ts) | Funções puras do teste: capacidades, guardas, tipos oferecidos (`buildTestTypeOptions`, restrito a `test_types`), `buildEstimateView` (nunca converte `available:false` em número), séries dos gráficos (`buildChartPoints`, `buildTestChartModels` — chave ausente = série indisponível), geometria do gráfico em SVG (`buildLineChart`, `formatOffsetSeconds`), observação da flag `TEST`, progresso (janela × alvo) e histórico. |
| [model/format.ts](../src/frontend/src/model/format.ts) | Formatação pt-BR. Ausente → "—", nunca `0`. |
| [model/metrics.ts](../src/frontend/src/model/metrics.ts) | Geometria do semicírculo, avaliação de faixas, `readMetricPath`, `resolveGaugeSource` (escolhe a origem presente no payload) e `buildGaugeRenderModel`. |
| [model/status.ts](../src/frontend/src/model/status.ts) | Flags por protocolo (`megatec-q1` × `sms-1phase`), severidade, estados de comunicação e tradução textual. |
| [components/Gauge.tsx](../src/frontend/src/components/Gauge.tsx) | Gauge semicircular em SVG (trilha, faixas, marcações, ponteiro, valor central). |
| [components/GaugeCard.tsx](../src/frontend/src/components/GaugeCard.tsx) | Cartão da métrica + valor secundário (tensão da bateria). |
| [components/Header.tsx](../src/frontend/src/components/Header.tsx) | Identificação, última leitura válida, contrato consumido e a lista de nobreaks coletados (recebida como filhos). |
| [components/StatusFlags.tsx](../src/frontend/src/components/StatusFlags.tsx) | Estados operacionais: ativos em destaque e os demais com opacidade reduzida (todos sempre visíveis). |
| [components/BatteryTest.tsx](../src/frontend/src/components/BatteryTest.tsx) | Bloco A/C do painel do teste: seletor de tipo, botão disparar/cancelar, guardas, progresso (janela × alvo), autonomia estimada, observação da flag `TEST` e histórico. |
| [components/BatteryTestCharts.tsx](../src/frontend/src/components/BatteryTestCharts.tsx) | Bloco B do painel: barra lateral com os quatro blocos selecionáveis (tensão de saída, frequência, temperatura interna, carga da bateria) e o gráfico SVG da série escolhida, desenhado a partir de `samples[].normalized`. |
| [components/Details.tsx](../src/frontend/src/components/Details.tsx) | Identidade, tensão da bateria, estado da coleta, idade, último erro e resultado de cada consulta. |
| [components/Notices.tsx](../src/frontend/src/components/Notices.tsx) | `buildNotices`: modo demo, API indisponível, telemetria ausente/desatualizada, configuração das faixas. |
| [styles/global.css](../src/frontend/src/styles/global.css) | Palco escuro de quatro quadrantes, responsividade e classes do SVG. |

## 6. Estados representados na interface

| Situação | Origem | Apresentação |
|---|---|---|
| Tudo normal | `telemetry_valid:true`, `stale:false`, `state:"ok"` | Indicador verde "Conectado"; gauges coloridos por faixa |
| Telemetria desatualizada | `stale:true` | Indicador âmbar "Desatualizado", aviso com a idade, gauges com rótulo "Desatualizado" |
| Coleta ativa sem amostra | `data_available:false` | Indicador âmbar "Sem dados" |
| Sensor/valor ausente | campo `null`/ausente | Gauge neutralizado com "Sem dados" (nunca `0`) |
| Falha do coletor | `communication.state` ≠ `ok` | Indicador vermelho com o rótulo traduzido do estado |
| API de telemetria fora do ar | `viewer.upstream.error` | Faixa crítica "API de telemetria indisponível" com o código do erro |
| Sem equipamento | `device_id: null` | Faixa "Sem telemetria utilizável"; `GET /api/dashboard` responde 404 |
| Serviço do viewer fora do ar | falha de `fetch` no navegador | Faixa crítica "Serviço do Web Viewer inacessível" |
| Vários nobreaks | `GET /api/v1/ups` com `count > 1` | Lista "Nobreaks coletados": o ativo em destaque ("em exibição"), os demais clicáveis ("disponível"); um por vez via `?device_id=` |
| Teste de bateria disponível | `capabilities.battery_test.enabled: true` | Botão "Testar bateria (10 s)" habilitado, com as guardas (cooldown, carga mínima); com mais de um tipo em `test_types`, o seletor "Teste rápido (~10 s)" / "Descarga controlada (até 20 %)" |
| Teste indisponível | `enabled: false` / `supported: false` | Botão desabilitado com o motivo; nenhum pedido é enviado |
| Teste em andamento | `status: "running"` | Barra de progresso (tempo no teste de janela; queda de carga, ou indeterminada, no teste por alvo), série parcial nos gráficos e "Verificando se o equipamento reportou o estado de teste…" |
| Teste sem a flag `TEST` | `test_flag_observed: false` | Aviso âmbar na observação — o equipamento não confirmou o estado de teste na janela |
| Teste concluído | `status: "completed"` | Gráficos da linha do tempo (um bloco por métrica), situação do teste, queda de carga, oscilação por métrica e autonomia estimada (ou o `reason`, quando indisponível) |
| Métrica não publicada | chave ausente em `samples[].normalized` | O bloco da métrica mostra "série indisponível" e o gráfico explica; **nunca** desenha zero |
| Teste cancelado/falhou | `finish_reason` ≠ `duration_elapsed` / `target_percent_reached` | Motivo traduzido; o relatório não é apresentado como um teste normal |

## 7. Decisões arquiteturais registradas

Ver [decisoes-tecnicas.md](./decisoes-tecnicas.md). Resumo: React + TypeScript + Vite; gauges em SVG
próprio (sem biblioteca de gráficos); proxy backend no container; npm workspaces; Docker
multi-stage com o backend servindo a interface estática.
