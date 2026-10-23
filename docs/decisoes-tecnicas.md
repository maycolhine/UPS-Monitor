# Decisões técnicas

Formato: **Decisão aprovada** (confirmada pelo solicitante), **Decisão técnica** (tomada pelo
desenvolvimento, com justificativa), **Pendência** (aguarda validação).

---

## Aprovadas pelo solicitante

### D1 — Backend/proxy de leitura no container ✅

**Contexto.** O escopo §7.1 pede uma escolha explícita entre o navegador consultar a API diretamente
ou existir um backend intermediário. A API de origem não envia cabeçalhos CORS.

**Decisão.** O container tem um backend Node/Express que consulta a API e publica os dados para a
interface **na mesma origem**. O navegador nunca fala com a API de telemetria.

**Consequências.** Sem CORS; o endereço da API não é exposto ao navegador; a validação do contrato
fica em um único ponto; a interface compilada é servida pelo próprio backend. O proxy **não** coleta,
**não** persiste e **não** duplica lógica do projeto de origem.

### D2 — Stack do frontend: React + TypeScript + Vite ✅

**Decisão.** React 18 + TypeScript, build com Vite.

**Justificativa.** Componentes reutilizáveis (exigência do escopo §7), tipagem do contrato JSON,
build rápido e saída estática que pode ser servida pelo backend sem servidor adicional.

### D3 — Faixas dos gauges: validadas e configuráveis ✅

**Decisão.** Os limites vermelho/âmbar/verde ficam em um único módulo
([gaugeConfig.ts](../src/backend/src/gaugeConfig.ts)), são publicados em `GET /api/config` e podem
ser sobrescritos por `VIEWER_GAUGE_THRESHOLDS` (JSON).

**Justificativa.** O escopo proíbe tratar limites inventados como recomendação oficial (§4.2, §6.1).
Os valores padrão são os **validados pelo solicitante em 2026-10-21** (tensão 80–127 / 200–225 V;
frequência 47–53 / 57–60 Hz; temperatura 0–25 / 25–35 °C; bateria 0–20 / 20–40 %; carga 0–50 /
50–75 %). A interface só exibe aviso de configuração quando `threshold_problems` não estiver vazio.

**Nota.** Os limites seguem configuráveis porque outro modelo/marca pode exigir janelas diferentes;
a validação atual refere-se ao parque conhecido.

**Convenção do limite (2026-10-22).** Um valor exatamente igual a um limite pertence à faixa que
**termina** nele (`evaluateBand` em [metrics.ts](../src/frontend/src/model/metrics.ts)), que é como as
faixas são descritas ao usuário ("verde entre 57 e 60"). Assim o valor nominal de **60,0 Hz** é
classificado como **"Frequência normal (60 Hz)"**, e não como atenção — e o mesmo vale para 127,0 V e
220 V. Na escala, os traços marcam o início e o fim de cada faixa, não marcações fixas.

### D4 — Nome do produto ✅

**Decisão.** Nome genérico **"UPS Monitor"** (`UPS Monitor — Web Viewer` no cabeçalho). Não fixa
marca/modelo, coerente com o objetivo de atender outras marcas futuramente.

### D5 — Instalação do Docker ✅

**Decisão.** Docker CE oficial (repositório `download.docker.com`), com o usuário no grupo
`docker`. Os comandos com `sudo` foram executados pelo solicitante (o `sudo` é bloqueado no
ambiente do assistente).

---

## Tomadas durante o desenvolvimento

### D6 — Gauges em SVG próprio, sem biblioteca de gráficos

**Contexto.** O escopo §7 permite bibliotecas de gráficos, desde que permitam personalizar escalas,
segmentos, rótulos e estados.

**Decisão.** Implementar o semicírculo em SVG puro
([Gauge.tsx](../src/frontend/src/components/Gauge.tsx) + [metrics.ts](../src/frontend/src/model/metrics.ts)).

**Justificativa.** Um gauge semicircular com faixas, marcações e ponteiro é geometria simples; com SVG
próprio não há dependência adicional, o bundle fica pequeno, a semântica de acessibilidade é
explícita (`role`/`aria-label`) e os estados são testáveis por função pura — o escopo pede
dependências enxutas e justificadas.

### D7 — npm workspaces, sem monorepo tool

**Decisão.** `src/backend` e `src/frontend` são workspaces npm do `package.json` raiz.

**Justificativa.** Um único `npm install` e scripts agregados (`npm test`, `npm run build`) sem
adicionar Turborepo/Nx/Pnpm — a escala do projeto não justifica mais ferramentas.

### D8 — `contract_version` como contrato, não como tecnologia

**Decisão.** O backend valida `api_version`/`contract_version`, mas não depende do framework da API.
`UpstreamApiClient` usa apenas `fetch`.

**Justificativa.** O escopo §3.4 proíbe assumir que a API é FastAPI e exige dependência do contrato
HTTP/JSON.

### D9 — Preservar `null` e não renomear campos

**Decisão.** Em [contract.ts](../src/backend/src/contract.ts), `null` é preservado como `null`, campos
ausentes continuam ausentes, campos extras (de outras marcas) são mantidos, e o frontend lê os
valores por `sources[]` — os caminhos exatos do contrato, em ordem de preferência.

**Justificativa.** Regra fundamental do escopo: jamais converter `null` em `0` nem adaptar o contrato
silenciosamente.

### D10 — 503 da API não é falha total no viewer

**Decisão.** Quando a API responde `503` mas publica um payload de telemetria com `telemetry_valid` /
`stale`, o Web Viewer repassa esse payload com **HTTP 200** e deixa o estado explícito nos campos.
Só falhas de transporte e divergências de contrato viram `502`.

**Justificativa.** O escopo §3.3 exige que `503` não seja tratado como falha de renderização nem que
números antigos apareçam como atuais. Como o payload traz `stale` e `age_seconds`, a interface
consegue exibir um estado degradado honesto em vez de uma tela de erro.

### D11 — Cache curto em memória, sem persistência

**Decisão.** Cache por caminho com TTL (`UPS_API_CACHE_TTL_MS`, padrão 1,5 s) e deduplicação de
requisições simultâneas; identidade com TTL maior (`UPS_API_IDENTITY_TTL_MS`, 60 s). **Falhas não são
cacheadas.**

**Justificativa.** Evita repetir consultas quando a interface atualiza a cada 5 s, sem introduzir
banco de dados (proibido no escopo §2.3) e sem atrasar a recuperação após uma queda.

### D12 — Healthcheck do container independente da API

**Decisão.** `GET /healthz` responde pela saúde do **próprio container** e não consulta a API de
telemetria. O `HEALTHCHECK` do Docker usa esse endpoint.

**Justificativa.** Um nobreak desligado não é motivo para o Docker reiniciar a aplicação web.

### D13 — Modo demonstração desligado por padrão

**Decisão.** Dados simulados existem em
[demo/fixture.ts](../src/frontend/src/demo/fixture.ts) e só são usados quando
`VITE_ENABLE_DEMO=true`, definido **apenas** em `.env.development`. A interface exibe uma faixa
"MODO DEMONSTRAÇÃO" e a fixture é explicitamente rotulada como simulada.

**Justificativa.** O escopo pede protótipo com dados simulados identificados (Fase B) e proíbe
apresentá-los como telemetria real. Em produção a variável não existe — o `vite build` de produção
não a define.

### D14 — Somente GET, com recusa local

**Decisão.** `UpstreamApiClient` recusa métodos diferentes de GET **antes** de sair para a rede
(`viewer_invalid_method`), e o servidor do viewer responde `405` a qualquer método ≠ GET em `/api/*`
e `/healthz`.

**Justificativa.** Garante, por construção, que nenhum comando de escrita chega à API nem ao nobreak
(critério de aceite "consumo exclusivo de endpoints GET").

### D15 — Estrutura de pastas

**Decisão.** Mantida a árvore do escopo §8, com dois ajustes registrados:

1. `SCOPE.md` não foi duplicado: o escopo oficial permanece em `UPS_Web_Viewer_Scope.md` (arquivo
   fornecido pelo solicitante), referenciado pelo README.
2. Os testes ficam em `src/backend/tests` e `src/frontend/tests` (ao lado de cada workspace), em vez
   de uma pasta `tests/` na raiz, para que cada workspace seja autocontido no Docker e no `vitest`.

### D16 — Linguagem visual: painel escuro em quatro quadrantes

**Contexto.** O escopo §4.1 e a regra 30-ui-ux definiam fundo geral branco (`#FFFFFF`). O solicitante
forneceu o template `torre_de_controle_log_stica_nstech.html` como referência do estilo final desejado
e pediu explicitamente um painel **sem rolagem**, dividido em quatro quadrantes.

**Decisão.** Adotar a linguagem visual do template de referência: palco escuro de alto contraste,
tipografia **Barlow** e grade 2×2 (`header` no superior esquerdo, gauges 2×3 no superior direito,
painéis de estado/detalhes nos quadrantes inferiores). As faixas de cor dos gauges e os avisos passam
a usar tons adequados ao fundo escuro (`#EF4444`/`#F59E0B`/`#10B981`).

**Justificativa.** A preferência do solicitante prevalece sobre a diretriz estética original. As
regras de **conteúdo** da 30-ui-ux foram mantidas integralmente: a cor nunca é o único sinal de
estado, valor ausente nunca vira `0`, percentual de bateria sempre marcado como estimativa, foco
visível, `aria-label` nos gauges, `dt`/`dd`, `caption`/`th` e `role="status"` nos avisos.

**Consequências.** Divergência registrada em [design-system.md](./design-system.md). O escopo §4.1 e
a regra 30-ui-ux permanecem com o texto antigo até que o solicitante os revise.

### D17 — API unificada 2.0: multidispositivo e multiprotocolo

**Contexto.** O projeto irmão unificou a API em uma única porta para **N** nobreaks em protocolos
diferentes (`megatec-q1` e `sms-1phase`), subindo o `contract_version` de `1.0` para `2.0` e
documentando o novo contrato em `monitor/docs/api-unificada.md`. O solicitante pediu a integração,
com a leitura de **um** nobreak por vez, escolhido entre os coletados.

**Decisão.** Quatro pontos:

1. **Seleção de equipamento.** A interface lista os nobreaks de `GET /api/v1/ups` ("Nobreaks
   coletados") e envia a escolha em `GET /api/dashboard?device_id=`. O backend resolve, nesta ordem:
   `?device_id=` → `UPS_DEVICE_ID` → primeiro com `telemetry_valid:true` → primeiro da lista →
   primeira chave de `health.devices`. `?device_id=` desconhecido → `404 device_not_found`
   (`resolveDeviceId` em [dashboard.ts](../src/backend/src/dashboard.ts)).
2. **Origem do valor por protocolo.** Cada métrica em [gaugeConfig.ts](../src/backend/src/gaugeConfig.ts)
   declara `sources[]` (um caminho por protocolo, em ordem de preferência); a interface resolve por
   `resolveGaugeSource`. Isso cobre, sem renomear campos, a frequência (`input_frequency_hz` ×
   `output_frequency_hz`) e a bateria (`battery_charge` × `battery`).
3. **Bateria — regra oposta.** No `megatec-q1` o percentual é **estimativa** (interpolação linear da
   tensão, selo "estimativa"); no `sms-1phase` é **informado pelo equipamento**
   (`charge_source: "reported_by_device"`, sem selo de estimativa). O selo é por origem
   (`origin_note`), não fixo por métrica.
4. **Flags por protocolo.** O significado de b5/b4/b3 muda entre Q1 e SMS; a tabela de tradução é
   escolhida por `data.source` (`flagMetaForProtocol` em
   [status.ts](../src/frontend/src/model/status.ts)). Protocolo desconhecido → tabela Q1.

**Justificativa.** O escopo proíbe marca/modelo fixo em código e exige atender novos equipamentos sem
alterar o frontend. Tratar o protocolo como dado (e não como caso especial) mantém as regras
invioláveis: `null` nunca vira `0`, campos não são renomeados e a interface não conhece a API.

**Consequências.** `EXPECTED_CONTRACT_VERSION = "2.0"`; `/health` passa a ser agregado
(`devices_total`/`devices_ok`/`devices{}`); o estado `checksum_error` (SMS) entra na tradução;
`status.raw_byte` é exibido quando publicado. A API antiga (`1.0`, um único `device_id`) deixa de ser
aceita em silêncio: a divergência aparece em `viewer.warnings`. *(Substituída em parte por D18: o
`contract_version` esperado passou a `3.0`.)*

### D18 — Contrato 3.0: teste de bateria de ~10 s

**Contexto.** O projeto irmão subiu o `contract_version` de `2.0` para `3.0` e acrescentou o teste de
bateria de janela fixa (~10 s), com `capabilities.battery_test` em `GET /api/v1/ups` e as rotas
`POST/GET .../tests` ([`monitor/docs/integracao-web-viewer.md`](../monitor/docs/integracao-web-viewer.md)
§11). Pela primeira vez o contrato prevê **escrita**. O solicitante pediu a análise, a exibição da
previsão de esgotamento/autonomia e escolheu **"exibir + botão de disparar/cancelar"**, com a ressalva
de que **o teste não deve ser disparado de forma autônoma**.

**Decisão.** Cinco pontos:

1. **A escrita continua atrás do backend.** O navegador nunca chama a API de origem: usa
   `/api/tests` do próprio viewer, que repassa o pedido preservando o HTTP e o `error.code`. O
   `UpstreamApiClient` passou a admitir `POST` (as demais rotas continuam GET-only) e o servidor
   responde `405` a métodos ≠ GET, **exceto** `POST` em `/api/tests*`.
2. **Nunca disparar sozinho.** O `POST` só existe por ação explícita do usuário. A interface lê
   `capabilities.battery_test` e só habilita o botão quando `enabled` é `true` (no perfil atual, o TS
   Shara vem com `enabled: false` e `abort_supported: false`).
3. **A API entrega fatos; o Web Viewer apresenta.** A autonomia (`estimate`) é uma extrapolação
   linear de 1ª ordem que a própria API publica com `confidence: "low"`. Quando `available` é
   `false`, a interface exibe o `reason` — **nunca converte a ausência em número**. `capped_at_min` é
   apresentado como piso ("≥ 10 h"), não como precisão. O viewer não calcula previsibilidade própria.
4. **Confirmação de que o teste ocorreu.** O painel exibe `test_flag_observed`/`flags_seen`: se o
   nobreak não reportar a flag `TEST` na janela, aparece um aviso explícito — a API **agendou** o
   teste, mas só a flag prova que ele rodou no equipamento.
5. **Modelo puro e testável.** Toda a leitura do relatório vive em funções puras
   ([batteryTest.ts](../src/frontend/src/model/batteryTest.ts)), cobertas por
   [batteryTest.test.ts](../src/frontend/tests/batteryTest.test.ts) sem DOM.

**Justificativa.** O escopo proíbe comandos autônomos ao nobreak e exige fidelidade ao contrato. Manter
a escrita no backend preserva D1 (sem CORS, sem expor a API) e mantém um único ponto de validação.
Etiquetar a autonomia como extrapolação e mostrar o `reason` quando ela não existe cumpre a regra de
ouro: **nenhum número é inventado**.

**Consequências.** `EXPECTED_CONTRACT_VERSION = "3.0"`; o bloco `tests` (histórico) entra em
`viewer.sources` e no payload do dashboard — a ausência do histórico não derruba o dashboard
(`tests: null`); `apiClient` passa a expor `post()`; o layout ganha o painel do teste no quadrante
inferior esquerdo e o "Estado operacional" sobe para o primeiro quadrante. O contrato `2.0` deixa de
ser aceito em silêncio: a divergência aparece em `viewer.warnings`.

### D19 — Dois tipos de teste e gráficos da linha do tempo no painel

**Contexto.** O projeto irmão publicou os documentos de transferência
[`teste-bateria-api-contrato.md`](../monitor/docs/teste-bateria-api-contrato.md) e
[`teste-bateria-quadrante.md`](../monitor/docs/teste-bateria-quadrante.md): além do teste de janela
fixa (`duration_10s`), o `sms-1phase` passou a oferecer `discharge_20pct` — descarga **sem janela**
que roda até a carga cair ao **alvo de 20 %** ou até o teto de segurança de 30 min, o que vier
primeiro. O mesmo material padronizou `samples[].normalized` (séries gráficas com o mesmo nome nos
dois protocolos) e pediu **gráficos em vez de tabela** no quadrante, com **blocos selecionáveis** na
barra lateral. O solicitante pediu a análise, a atualização da coleta e a implementação dos gráficos.

**Decisão.** Seis pontos:

1. **Tipos vêm da API, nunca do protocolo.** O seletor do painel é montado **somente** com
   `capabilities.battery_test.test_types`; o `type` escolhido é enviado no `POST`. Nada é presumido a
   partir do nome do protocolo — oferecer `discharge_20pct` onde a API não o declara só produziria
   `422 unsupported_test_type`.
2. **Progresso com dois modos.** `duration_10s` usa o tempo decorrido sobre a janela pedida
   (`mode: "window"`); `discharge_20pct` usa a **queda de carga** desde o `baseline` até o alvo
   (`mode: "target"`). O `timeout_s` de 1800 s é **teto**, não duração prevista: usá-lo como janela
   deixaria a barra quase vazia mesmo com metade da descarga concluída. Sem dado para a fração, a
   barra fica **indeterminada** (`aria-valuenow` ausente).
3. **Gráficos a partir de `normalized`, em SVG próprio.** Os pontos vêm de
   `samples[].normalized` (`output_voltage_v`, `frequency_hz`, `temperature_c`,
   `battery_charge_percent`) contra `samples[].offset_s`; `measurements` **não** é usado, porque varia
   por protocolo. A geometria (`buildLineChart`) é função pura e testável, e o desenho é SVG próprio —
   sem biblioteca de gráficos (mesma diretriz dos gauges, D16).
4. **Chave ausente ≠ zero.** Amostra sem a chave é ignorada na série; o bloco da métrica mostra
   "série indisponível" e o gráfico explica a ausência. Nenhuma linha reta em zero é desenhada — a
   regra de ouro do contrato (§20/3 e §30) vale também para os gráficos.
5. **Escala legível para oscilações pequenas.** O eixo Y é **automático com folga de 15 %**, e não a
   escala do gauge (0–250 V), que esconderia oscilações de ±2 V/±0,5 Hz. O eixo X usa `m:ss` acima de
   60 s e `s.S` no teste curto, com o **mesmo** formato em todos os rótulos do gráfico. A linha do
   alvo (20 %) aparece tracejada, rotulada a partir de `target_percent`.
6. **A tabela de métricas saiu.** O bloco B (gráficos) ocupa o lugar que era da tabela; a tabela
   remanescente é a de **testes anteriores**, agora com a coluna **Tipo**. O bloco de resumo continua
   apresentando `deltas`/`estimate` — a API entrega os fatos, o viewer apresenta (D18, item 3).

**Justificativa.** Manter a política de tipos na API preserva a regra de não inventar capacidades e
permite que novos equipamentos entrem sem alterar o frontend. Separar o progresso em janela × alvo
evita apresentar o teto de segurança como previsão. Desenhar os gráficos em SVG próprio mantém a
dependência enxuta, reaproveita a geometria pura já testada e continua testável sem DOM.

**Consequências.** `batteryTest.ts` ganhou `buildTestTypeOptions`, `buildChartPoints`,
`buildTestChartModels`, `buildLineChart` e `formatOffsetSeconds`, e o progresso passou a distinguir
janela de alvo; o novo componente
[BatteryTestCharts.tsx](../src/frontend/src/components/BatteryTestCharts.tsx) concentra o bloco B;
`useBatteryTest.start(type?)` repassa o tipo ao `POST`; as fixtures e os testes cobrem o relatório de
descarga (`target_percent_reached`, `target_percent`/`timeout_s` no aceite) e a ausência de chave em
`normalized`. O teste continua **sem** disparo autônomo: só o clique envia o comando.

---

## Pendências (aguardam decisão do solicitante)

| # | Pendência | Impacto enquanto não resolvida |
|---|---|---|
| P3 | Definir se o dashboard exibirá apenas modelo/`device_id` ou também outros dados de identidade | Hoje exibe tudo o que a API publicar; o que faltar aparece como "—" |
| P4 | Confirmar se a aplicação ficará acessível apenas na rede local de gerenciamento | Nenhuma autenticação foi implementada (a API de origem também não autentica) |
| P6 | Decidir sobre histórico de leituras | Fora do escopo desta versão |
| P7 | Revisar o escopo §4.1 e a regra 30-ui-ux (fundo branco) para registrar a linguagem visual escura adotada (D16) | Os documentos permanecem com o texto antigo; a divergência está registrada em [design-system.md](./design-system.md) |

### Pendências concluídas

| # | Pendência | Situação |
|---|---|---|
| P1 | Validar as faixas vermelho/âmbar/verde de cada métrica | ✅ Concluída em 2026-10-21 (D3) |
| P2 | Confirmar a tensão de saída do parque (110/127 V vs 220 V) | ✅ Concluída: a faixa padrão cobre as duas janelas (80–127 e 200–225 V) (D3) |
| P5 | Definir os limites operacionais de temperatura e de carga | ✅ Concluída em 2026-10-21 (D3) |

## Decisões descartadas

- **Consultar a API direto do navegador** — exigiria CORS na API de origem (fora do controle deste
  projeto) e exporia o endereço da API ao navegador.
- **Biblioteca de gráficos (Chart.js/ECharts/Recharts)** — peso e configuração desnecessários para
  seis gauges semicirculares.
- **Banco de dados / autenticação** — sem necessidade demonstrada; proibido pelo escopo §2.3 e §9.3.
- **Server-side rendering** — o painel é somente leitura e atualizado por polling; CSR é suficiente.
