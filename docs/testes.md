# Testes e validação

## 1. Como executar

```bash
npm test                # backend + frontend
npm run test:backend    # apenas o backend (vitest)
npm run test:frontend   # apenas o frontend (vitest)
```

Nenhum teste precisa de hardware, de porta serial ou da API real: o backend é exercitado contra um
servidor HTTP falso e o frontend contra funções puras e um `fetch` simulado.

## 2. Backend (`src/backend/tests`)

### 2.1 Apoio

| Arquivo | Papel |
|---|---|
| [helpers/fakeUpstream.ts](../src/backend/tests/helpers/fakeUpstream.ts) | Servidor HTTP falso que responde as rotas da API de telemetria |
| [helpers/fixtures.ts](../src/backend/tests/helpers/fixtures.ts) | Respostas do contrato 3.0 multidispositivo: sucesso (`megatec-q1` e `sms-1phase`), `stale`, `data:null`, `404`, `405`, lista com dois equipamentos (com `capabilities.battery_test` — o TS Shara só com `duration_10s`, o SMS com `duration_10s` e `discharge_20pct`), `/health` agregado e o ciclo do teste (aceite `202` com e sem `requested_duration_s`, relatório `running`/`completed`, relatório da descarga com `target_percent_reached` e `samples[].normalized`, estimativa indisponível, cancelamento, histórico e os erros `test_cooldown`/`test_disabled`) |
| [helpers/viewer.ts](../src/backend/tests/helpers/viewer.ts) | Sobe o `createApp` em porta livre e expõe `getJson` |

### 2.2 Cobertura por arquivo

| Arquivo | O que verifica |
|---|---|
| [config.test.ts](../src/backend/tests/config.test.ts) | Padrões; leitura de todas as variáveis; numérico inválido; URL inválida; nível de log inválido; `VIEWER_GAUGE_THRESHOLDS` vazio/ausente |
| [contract.test.ts](../src/backend/tests/contract.test.ts) | Payload válido; **preservação de `null`**; campos desconhecidos mantidos; `data: null`; envelope ausente; `communication` ausente; tipo inválido; identidade; lista de equipamentos (dois protocolos) e `capabilities.battery_test` (`test_types` do TS Shara × SMS e os parâmetros de `types.<type>`, incl. `target_percent`/`timeout_s`); saúde **agregada**; bloco `battery` do SMS e `status.raw_byte`; envelope de erro; **parsers do teste 3.0** (aceite ≠ resultado, aceite da descarga sem janela, relatório parcial/completo com `samples[].normalized`, relatório da descarga com `target_percent_reached`, `estimate.available:false` preservando o `reason`, cancelamento e histórico sem `samples`) |
| [apiClient.test.ts](../src/backend/tests/apiClient.test.ts) | `GET` bem-sucedido; `404`; `405`; `503`; timeout; rede indisponível; JSON inválido; **recusa de `PUT`/`PATCH`/`DELETE` sem sair para a rede**; **`POST` (teste) enviando o corpo JSON** |
| [gaugeConfig.test.ts](../src/backend/tests/gaugeConfig.test.ts) | Faixas cobrem a escala sem sobreposição; `sources` da bateria e da frequência (um caminho por protocolo); override válido; JSON inválido; métrica desconhecida; faixa fora da escala; faixa desordenada; `readMetricValue` (número, `null`, ausente) |
| [server.test.ts](../src/backend/tests/server.test.ts) | Caminho feliz (telemetria repassada **idêntica**, descoberta via `/api/v1/ups`, fallback por `/health`, `device_id` fixado sem consultar a lista); **seleção `?device_id=`** (escolhe o SMS, outro protocolo; desconhecido → `404 device_not_found`); estados degradados (`stale` → 200, `data:null` → 200, API fora do ar → 502, falha na descoberta → `viewer.upstream.error` preenchido, timeout → 502, JSON inválido → 502, contrato divergente → 502, `device_not_found` → 404, sem equipamentos → 404); **ações do teste de bateria** (`POST` → 202, `409 test_cooldown`, relatório parcial/completo, `abort` → 202, `404 test_not_found`, sem equipamentos → 404) e a trava de método (**só `POST` em `/api/tests*`**, `upstream.requests` vazio nos demais); servidor (`/healthz` 200, `/api/config`, `405` em método de escrita, `404` em rota inexistente, deduplicação de cache) |

## 3. Frontend (`src/frontend/tests`)

| Arquivo | O que verifica |
|---|---|
| [metrics.test.ts](../src/frontend/tests/metrics.test.ts) | `evaluateBand` (inclusive limite superior na última faixa); `valueFraction`/`valueAngle`; `arcPath` (coordenadas e raio); `buildGaugeRenderModel` — **valor ausente/`null`/`NaN` nunca vira `0`**; rótulo "Desatualizado" quando `stale`; arredondamento pt-BR; `readMetricPath` (distingue `null` de ausente e não converte string em número); `resolveGaugeSource` (preferência, fallback, `null` explícito, ausente, rótulo por origem) |
| [status.test.ts](../src/frontend/tests/status.test.ts) | Flags ativas/inativas, severidade de `LB`/`FAULT`, flags não documentadas, **flags por protocolo** (`megatec-q1` × `sms-1phase`), tradução dos estados de comunicação (incl. `checksum_error`), severidade do estado, e **distinção explícita entre "API indisponível" e "telemetria desatualizada"** |
| [notices.test.ts](../src/frontend/tests/notices.test.ts) | Formatação pt-BR (vírgula decimal, "—" para ausente, idade em s/min/h); avisos: modo demonstração, API indisponível com código, "sem telemetria" vs "desatualizada", configuração das faixas, ausência de avisos no caso normal, e **erro da API de origem no envelope (não rotulado como falha do Web Viewer)** |
| [client.test.ts](../src/frontend/tests/client.test.ts) | `GET` em `/api/dashboard` e `/api/config`; **`?device_id=` quando um nobreak é escolhido**; **corpo útil em HTTP 503**; erro de rede sem exceção; JSON inválido; código do envelope em 502; cancelamento por `AbortController`; `isViewerLevelFailure` (transporte/JSON ≠ envelope da API de origem) |
| [batteryTest.test.ts](../src/frontend/tests/batteryTest.test.ts) | `readTestSupport` (capacidades declaradas, `test_types`/`types`, ausência → não suportado, guardas de cooldown/carga e o aviso de que o equipamento não cancela); `buildEstimateView` — **`available:false` nunca vira número** (só o `reason`) e o teto `capped_at_min` é apresentado como piso ("≥ 10 h"); `buildObservationView` (confirmação da flag `TEST`, aviso quando não observada e estado indefinido durante o teste); **tipos de teste** (seletor restrito a `test_types`, rótulos e parâmetros de cada tipo); **séries dos gráficos** (`buildChartPoints`/`buildTestChartModels` — ordem das quatro métricas, oscilação por `deltas.metrics`, **chave ausente = série indisponível, nunca `0`**, linha do alvo só na carga da bateria); **geometria do gráfico** (traçado, folga do eixo Y, `m:ss` acima de 60 s × `s.S` no teste curto, posição da linha de referência, série vazia → `null`); `buildTestProgress` (janela × alvo — **o teto de 30 min não é usado como duração** — e barra indeterminada); traduções de status/motivo/erro e o histórico do teste (com a coluna Tipo) |

## 4. Critérios de aceite do escopo §10 — situação

### Funcionais

| Critério | Onde é satisfeito / verificado |
|---|---|
| Identifica o equipamento pela API | `ViewerService.resolveDeviceId` (lista → `/health` → `UPS_DEVICE_ID`); `server.test.ts` |
| Indicadores exibem os campos e unidades corretos | `GET /api/config` define `unit`/`decimals`; `metrics.test.ts` |
| Percentual de bateria marcado como estimativa | `estimated: true` na definição; selo "estimativa" no cartão; `gaugeConfig.test.ts` |
| Estados ativos apresentados de forma compreensível | `StatusFlags` + `status.test.ts` |
| Horário/idade da última leitura visível | Cabeçalho e área de detalhes; `formatAge` em `notices.test.ts` |
| Dados ausentes/inválidos não viram zero | `buildGaugeRenderModel` e `readMetricPath`; `metrics.test.ts` |
| Distingue API indisponível de telemetria desatualizada | Avisos e indicador; `status.test.ts` e `notices.test.ts` |

### Visuais e UX

| Critério | Situação |
|---|---|
| Palco escuro em quatro quadrantes (D16) | `--surface: #030408` em `html`/`body` e `.stage` em grade 2×2 |
| Paleta conforme as regras | [design-system.md](./design-system.md) §1 |
| Gauges com semântica vermelho/âmbar/verde | Faixas em `gaugeConfig.ts`, classes `gauge__band--*` |
| Cores não são o único meio de comunicar estado | Toda faixa tem rótulo textual; todo estado tem texto + valor |
| Valores e unidades legíveis em desktop e celular | Grade fluida; `formatNumber` com unidade separada |
| Layout sem rolagem de página no desktop | `.stage` com `100dvh` e `overflow: hidden`; breakpoint em 900 px e 420 px |
| Estados de carregamento, erro e ausência de dados | `loading`, `Notices`, `gauge--empty`, `panel__empty` |

### Integração

| Critério | Situação |
|---|---|
| Leitura exclusiva por GET; escrita restrita ao teste (3.0) | `GET` em tudo; `POST` só em `/api/tests*`, nunca autônomo; recusa local no `UpstreamApiClient` e `405` no servidor; `apiClient.test.ts` e `server.test.ts` |
| Tratamento de HTTP 200, 404, 405 e 503 | `dashboard.ts` + `server.test.ts` |
| Tratamento de timeout, rede e JSON inválido | `apiClient.ts` + `apiClient.test.ts` |
| Endereço-base da API configurável | `UPS_API_BASE_URL`; nenhum IP no código |
| Comunicação container ↔ host documentada e testada | [operacao-docker.md](./operacao-docker.md) §3 |
| Nenhuma dependência de acesso USB | Não há `node-serialport` nem leitura de `/dev/*` no projeto |

### Entrega

| Critério | Situação |
|---|---|
| Projeto inicializa por Docker conforme o README | `Dockerfile` + `compose.yaml` + [operacao-docker.md](./operacao-docker.md) |
| Arquivo `.env.example` | Presente, sem segredos |
| Testes automatizados essenciais passam | `npm test` (backend + frontend) |
| Arquitetura, contrato, decisões e operação documentados | `docs/` |
| Sem credenciais, tokens ou segredos versionados | A API de origem não autentica; nenhum token é usado |

## 5. Validação manual sugerida (após subir o container)

1. **Caso normal** — com a API respondendo: todos os gauges preenchidos, indicador verde
   "Conectado", cabeçalho com a última leitura válida.
2. **Telemetria desatualizada** — pare o coletor sem parar a API: indicador âmbar "Desatualizado",
   aviso com a idade da leitura, gauges com rótulo "Desatualizado".
3. **API indisponível** — pare a API: faixa crítica "API de telemetria indisponível" com o código do
   erro, gauges neutralizados, tabela de consultas marcando a falha.
4. **Sem equipamento** — aponte `UPS_API_BASE_URL` para uma resposta sem `devices`: faixa "Sem
   telemetria utilizável" e `GET /api/dashboard` respondendo `404 no_devices_configured`.
5. **Somente leitura (fora do teste)** — `curl -X POST http://localhost:8090/api/dashboard` deve
   responder `405`; `curl -X POST "http://localhost:8090/api/tests?device_id=..."` é a única escrita
   aceita e só deve ser usado com o equipamento habilitado.
6. **Teste de bateria (acionamento manual, nunca autônomo)** — com um equipamento cujo
   `capabilities.battery_test.enabled` seja `true`: acionar o botão, confirmar o `202` no aceite e o
   progresso da janela de 10 s; ao concluir, conferir a queda de carga, a autonomia estimada (ou o
   `reason`, quando indisponível) e a observação da flag `TEST`. Com `enabled: false` (TS Shara no
   perfil atual), o botão aparece desabilitado com o motivo e nenhum pedido é enviado.
7. **Responsividade** — 1440 px, 1024 px, 768 px e 390 px sem rolagem horizontal; valores e unidades
   legíveis em todos.
8. **Acessibilidade básica** — navegação por teclado com foco visível; leitor de tela anunciando o
   `aria-label` de cada gauge.
