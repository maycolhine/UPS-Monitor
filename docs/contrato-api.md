# Contrato consumido e contrato publicado

Este documento tem duas partes:

1. **Contrato consumido** — a API REST do projeto *Monitoramento UPS* (`v1` / `contract_version 3.0`),
   que é a **fonte de verdade**. Documento original: [`monitor/docs/api-unificada.md`](../monitor/docs/api-unificada.md)
   (API unificada, vários nobreaks em vários protocolos; §6.8 trata do teste de bateria) e
   [`monitor/docs/integracao-web-viewer.md`](../monitor/docs/integracao-web-viewer.md) §11 (guia de
   integração do teste de bateria).
2. **Contrato publicado** — o que o backend do Web Viewer expõe para a interface.

Nada foi renomeado, reinterpretado ou inventado em relação à API de origem.

---

## Parte 1 — API de telemetria (contrato consumido)

### 1.1 Endpoints

| Método | Caminho | Uso no Web Viewer |
|---|---|---|
| `GET` | `/health` | Saúde **agregada** de todos os coletores (`devices_total`, `devices_ok`, `devices{device_id:{...}}`) |
| `GET` | `/api/v1` | Índice do contrato (não consultado automaticamente; disponível para diagnóstico) |
| `GET` | `/api/v1/ups` | Descoberta dos equipamentos disponíveis (lista com marca, modelo, protocolo e `capabilities`) |
| `GET` | `/api/v1/ups/{device_id}/telemetry` | Medições, estados e metadados da coleta de **um** equipamento |
| `GET` | `/api/v1/ups/{device_id}/identity` | Identificação e informações nominais de **um** equipamento |
| `POST` | `/api/v1/ups/{device_id}/tests` | Pedido do teste de bateria (`duration_10s` ou `discharge_20pct`; contrato 3.0 — único ponto de escrita) |
| `GET` | `/api/v1/ups/{device_id}/tests` | Histórico de testes (`?limit=N`), sem a série de amostras |
| `GET` | `/api/v1/ups/{device_id}/tests/{test_id}` | Relatório do teste (parcial enquanto `running`) |
| `POST` | `/api/v1/ups/{device_id}/tests/{test_id}/abort` | Cancelamento, quando `abort_supported` |

Qualquer outro método responde `405 method_not_allowed`. O Web Viewer **só executa GET** — a única
escrita é o `POST` nas rotas de teste, e só depois de uma ação explícita do usuário. Qualquer outro
método é recusado localmente com o código `viewer_invalid_method`; o servidor do viewer responde `405`
a métodos ≠ GET, exceto `POST` nas rotas `/api/tests`.

**Multidispositivo.** Uma única instância da API publica **N** nobreaks em portas/protocolos
diferentes; o equipamento é escolhido pelo `device_id`. O Web Viewer descobre todos em
`GET /api/v1/ups`, permite ao usuário selecionar **um por vez** e envia a escolha em
`GET /api/dashboard?device_id=...` — nunca exibe dois ao mesmo tempo.

### 1.2 Códigos HTTP

| Código | Situação | Tratamento no Web Viewer |
|---|---|---|
| `200` | Dado íntegro | Repassado. Telemetria válida e fresca |
| `404` `not_found` | Caminho inexistente | Tratado como divergência de contrato (`502 upstream_contract_mismatch`) |
| `404` `device_not_found` | `device_id` não configurado na API | `404 device_not_found` para a interface |
| `405` `method_not_allowed` | Método ≠ GET | Fora das rotas de teste o viewer só envia GET |
| `503` | Aplicação de pé, sem dado utilizável (telemetria ausente/desatualizada, identidade indisponível) | **Não** é tratado como falha total: o payload é repassado com `200` e o estado fica explícito em `telemetry_valid`, `stale` e `communication.state` |
| `202` | Teste de bateria **aceito** (execução assíncrona) | Repassado com `202`; **não** é o resultado do teste (ver §1.6) |
| `400` `invalid_request` | Pedido de teste malformado | Repassado com o `error.code` da API |
| `403` `test_disabled` | Teste não habilitado no equipamento | Repassado; a interface só habilita o botão quando `capabilities.battery_test.enabled` é `true` |
| `409` `test_cooldown` / `battery_too_low` / `on_battery` / `battery_low` / `test_in_progress` / `test_unavailable` / `test_not_running` | Guardas do teste | Repassado com o `error.code`; a mensagem da API é exibida como veio |
| `422` `unsupported_test_type` / `test_not_supported` | Teste indisponível para este equipamento/protocolo | Repassado com o `error.code` |
| `404` `test_not_found` | `test_id` desconhecido | Repassado com `404 test_not_found` |

### 1.3 Envelope comum

Todas as respostas — inclusive erros — trazem `api_version` (`v1`) e `contract_version` (`3.0`).
Datas em ISO 8601 UTC com milissegundos e sufixo `Z`. Todo campo numérico carrega a unidade no nome
(`_v`, `_hz`, `_c`, `_percent`). Erros usam `{"error": {"code", "message"}}`.

O Web Viewer verifica os dois campos de versão e registra divergências em `viewer.warnings`.

### 1.4 Telemetria

```
api_version, contract_version, device_id,
telemetry_valid, stale, data_available,
data: {
  captured_at_utc, source, raw_frame, age_seconds,
  measurements: { ... dependem do protocolo ... },
  battery_charge: { percent, estimated, method, calibration { voltage_low_v, voltage_high_v } },  // megatec-q1
  battery: { charge_percent, charge_source, voltage_v, voltage_derived, voltage_nominal_v, packs }, // sms-1phase
  status: { raw_bits, raw_byte, active[], flags { ... } }
},
communication: { state, telemetry_valid, stale, last_attempt_utc, last_success_utc, age_seconds,
                 consecutive_failures, total_attempts, total_successes, last_error, serial_port,
                 poll_interval_s, stale_after_s }
```

`data.source` informa o **protocolo** que produziu a leitura (`megatec-q1`, `sms-1phase`) e é ele que
define **quais** medições e **qual** bloco de bateria aparecem:

| Medição | `megatec-q1` (TS Shara) | `sms-1phase` (SMS) |
|---|---|---|
| Tensão de entrada | `input_voltage_v` | `input_voltage_v` (+ `input_voltage_extended_v`) |
| Tensão de saída | `output_voltage_v` | `output_voltage_v` |
| Carga | `load_percent` | `load_percent` |
| Temperatura | `temperature_c` | `temperature_c` |
| Frequência | `input_frequency_hz` | `output_frequency_hz` |
| Tensão da bateria | `battery_voltage_v` | `battery.voltage_v` |
| Falha de entrada | `input_voltage_fault_v` | — |
| Bloco de bateria | `battery_charge` | `battery` |

Cada métrica publicada em `GET /api/config` traz **uma ou mais origens** (`sources`); a interface usa
a primeira origem presente no payload. Assim o mesmo cartão "Frequência" funciona nos dois
protocolos, sem renomear nenhum campo do contrato.

**Bateria — a regra é oposta entre os protocolos.**

- `megatec-q1` → `data.battery_charge`: `percent` é **sempre estimativa** (interpolação linear entre
  `calibration.voltage_low_v` = 0 % e `calibration.voltage_high_v` = 100 %; o protocolo Q1 não
  transmite percentual). `estimated: true`, `method: "linear_voltage_interpolation"`. A interface
  **sempre** exibe o selo "estimativa" e mostra `battery_voltage_v` em campo separado.
- `sms-1phase` → `data.battery`: `charge_percent` vem do **próprio equipamento**
  (`charge_source: "reported_by_device"`) e **não é estimativa**; `voltage_v` é derivada
  (`voltage_derived: true`). A interface **não** aplica o selo de estimativa ao percentual.

Quando não há valor válido, `percent`/`charge_percent` é `null` — e a interface mostra "Sem dados",
nunca `0`.

**Flags do quadro — o significado dos bits muda por protocolo.** A tabela de tradução é escolhida por
`data.source` (implementado em [status.ts](../src/frontend/src/model/status.ts)). Protocolo
desconhecido → tabela Q1.

`megatec-q1` (Q1):

| Bit | Flag | Significado | Severidade na interface |
|---|---|---|---|
| b7 | `OB` | Operando na bateria | atenção |
| b6 | `LB` | Bateria baixa | crítico |
| b5 | `BOOST` | Tensão de entrada baixa / reforço | atenção |
| b4 | `FAULT` | Falha | crítico |
| b3 | `STANDBY` | Modo espera | informativo |
| b2 | `TEST` | Teste em andamento (é o estado confirmado durante o teste de ~10 s) | informativo |
| b1 | `FSD` | Desligamento programado | atenção |
| b0 | `BEEP` | Alarme sonoro | atenção |

`sms-1phase` (SMS) — repare que b5/b4/b3 têm **significado diferente** de Q1:

| Bit | Flag | Significado | Severidade na interface |
|---|---|---|---|
| b7 | `OB` | Operando na bateria | atenção |
| b6 | `LB` | Bateria baixa | crítico |
| b5 | `BYPASS` | Bypass ativo | atenção |
| b4 | `BOOST` | Reforço/boost ativo | atenção |
| b3 | `UPSOK` | UPS em operação normal | informativo |
| b2 | `TEST` | Teste em andamento | informativo |
| b1 | `FSD` | Desligamento programado | atenção |
| b0 | `BEEP` | Alarme sonoro | atenção |

Alguns protocolos publicam também `status.raw_byte` (decimal) além de `raw_bits` (binário).

Flags não documentadas (outros modelos/marcas) são exibidas como informativas, com a descrição
"Estado não documentado no contrato atual" — sem inventar significado.

**Estados de `communication.state`**: `starting`, `ok`, `stale`, `port_unavailable`,
`permission_denied`, `disconnected`, `timeout`, `invalid_response`, `incomplete_response`,
`parse_error`, `checksum_error`, `out_of_range`, `serial_error`. Todos são traduzidos para português
em [status.ts](../src/frontend/src/model/status.ts); um estado novo aparece com o próprio código
(nunca é inventado um rótulo).

### 1.5 Identidade

```
api_version, contract_version, device_id, identity_available,
data: {
  captured_at_utc,
  device:   { manufacturer, model, firmware, raw_frame },
  nominal:  { voltage_label, voltage_v, input_current_a, battery_voltage_v, frequency_hz, raw_frame }
},
configured: { device_id, brand, model, protocol, transport, serial_port, serial_baud,
              poll_interval_s, stale_after_s },
communication: { ... }
```

Observação do contrato: no equipamento atual, `voltage_label` é `"Univ."` (não numérico), portanto
`voltage_v` é `null`. A interface exibe "—" nesse caso, sem valor fictício.

Falha na leitura de identificação **não** invalida a telemetria: `/identity` responde `503` e
`/telemetry` continua normal. A interface trata isso como ausência parcial de detalhes.

### 1.6 Teste de bateria (contrato 3.0)

O contrato 3.0 acrescenta **uma única escrita**: o teste de bateria. Ele é **assíncrono** — o `POST`
apenas enfileira o pedido, que o coletor executa no próximo ciclo; o resultado é obtido pelo relatório
em `report_url`.

**Dois tipos de teste.** O `type` enviado no `POST` escolhe o comportamento, e cada equipamento declara
em `test_types` **o que aceita** — enviar um tipo fora da lista responde `422 unsupported_test_type`:

| `type` | O que faz | Como termina |
|---|---|---|
| `duration_10s` *(padrão)* | janela **fixa** de ~10 s | fim da janela (`duration_elapsed`) ou `watchdog` |
| `discharge_20pct` | **sem janela**: roda até a carga cair ao **alvo de 20 %** | alvo atingido (`target_percent_reached`) ou o teto de segurança de **30 min** (`watchdog`) |

O `discharge_20pct` só existe onde o protocolo sabe **cancelar** o teste (`abort_supported: true`) —
hoje só o `sms-1phase`. O `megatec-q1` (TS Shara) declara **apenas** `duration_10s`: sem cancelamento,
um teste "sem janela" só terminaria quando a bateria baixasse, e o `megatec-q1` **recusa**
`discharge_20pct`. O viewer **não** presume capacidade a partir do protocolo: lê o que a API declara.

**Descoberta.** `GET /api/v1/ups` publica, por equipamento:

```
capabilities: { battery_test: {
  supported, enabled,
  test_types: ["duration_10s", "discharge_20pct"],
  types: { duration_10s:    { duration_s, target_percent: null, timeout_s, sample_interval_s },
           discharge_20pct: { duration_s: null, target_percent, timeout_s, sample_interval_s } },
  duration_s, sample_interval_s, cooldown_s, min_battery_percent, abort_supported } }
```

`enabled` decide se o botão pode ser acionado; `abort_supported` decide se o cancelamento é oferecido;
`types.<type>` traz o detalhe de cada tipo (janela × alvo/teto). No `discharge_20pct`,
`duration_s` é `null` e `timeout_s` (1800 s) é **teto**, não duração prevista — o teste costuma
terminar antes, quando a carga chega ao alvo.

**Fluxo**

```
POST .../tests  → 202 { test_id, type, status: "running", poll_interval_s, report_url, ... }
   ↓ (o coletor executa no próximo ciclo; até poll_interval_s depois)
GET report_url (a cada poll_interval_s ≈ 0,5 s)
   → running  (série parcial; deltas/estimate nulos)
   → completed | aborted | failed   (relatório final)
POST .../tests/{id}/abort → 202 { status: "aborting" }   (só com abort_supported)
```

**Aceite (`POST .../tests` → 202)** — não é o resultado: `test_id`, `device_id`, `type`, `status`,
`started_at_utc`, `expected_end_at_utc`, `requested_duration_s`, `target_percent`, `timeout_s`,
`sample_interval_s`, `poll_interval_s`, `report_url`. No teste de janela, `requested_duration_s` traz
a janela e `target_percent` é `null`; no teste por alvo é o inverso.

**Relatório (`GET .../tests/{test_id}` → 200)** — bloco `test`:

```
test_id, type, status (running|completed|aborted|failed),
started_at_utc, expected_end_at_utc, ended_at_utc, duration_s, sample_interval_s,
requested_duration_s, target_percent, timeout_s,
finish_reason,            // duration_elapsed | target_percent_reached | test_flag_cleared | aborted |
                          // battery_low | watchdog | stopping | serial_error
test_flag_observed,       // true quando o nobreak ligou a flag TEST — prova de que o teste ocorreu
flags_seen[],             // flags observadas na janela
baseline{}, final{},      // valores de referência e de fim (já normalizados)
deltas: { window_s, sample_count, metrics: { <métrica>: { start, end, min, max, delta, ripple,
                                                            max_abs_deviation, count } } },
estimate: { available, method, window_s, start_charge_percent, drop_percent_in_window,
            discharge_rate_pp_per_min, estimated_runtime_min, capped_at_min, confidence, reason },
samples_count, error,
samples[ { offset_s, normalized{}, measurements{}, status{}, battery{} } ]
```

**`samples[].normalized`** é o espelho **padronizado entre protocolos** e é a fonte dos gráficos
(`measurements` mantém os nomes originais de cada protocolo e **varia** por modelo). Chaves:
`input_voltage_v`, `output_voltage_v`, `load_percent`, `temperature_c`, `frequency_hz`,
`battery_charge_percent`, `battery_voltage_v`. Chave **ausente** significa "série indisponível para
este equipamento" — **nunca** zero; o viewer não desenha a linha nesse caso.

**Histórico (`GET .../tests?limit=N` → 200)** — `count` e `tests[]` com o mesmo formato do relatório,
**sem** a série de `samples`; cada item traz `type`.

**Estimativa.** `estimate` é uma **extrapolação linear de 1ª ordem** a partir da queda de carga na
janela, sempre com `confidence: "low"`; `estimated_runtime_min` é limitado por `capped_at_min`
(600 min) — quando empata com o teto, o valor é um **piso** ("≥ 10 h"), não uma precisão. Quando
`available` é `false`, o campo `reason` explica a ausência — **a interface nunca converte isso em
número**. Essa é a regra de ouro: **a API entrega os fatos; o Web Viewer apresenta** (nunca inventa).

**Confirmação do estado de teste.** O relatório traz `test_flag_observed` e `flags_seen`. Se o
equipamento não reportar a flag `TEST` durante a janela, a interface exibe um aviso explícito — é a
prova de que o teste realmente ocorreu no nobreak, e não apenas que a API o agendou.

**Cancelamento.** Com `abort_supported: false`, o `POST .../abort` apenas interrompe a amostragem; a
interface avisa isso antes do clique (guardas exibidas no painel).

**Guardas e erros** (envelope `{"error": {"code", "message"}}`, `message` em português, pronta para
exibir; o código é preservado pelo backend do viewer):

| HTTP | `error.code` | Quando |
|---|---|---|
| `403` | `test_disabled` | `allow_battery_test` não está ligado no dispositivo |
| `422` | `unsupported_test_type` | `type` fora dos aceitos **por este dispositivo** (ex.: `discharge_20pct` no `megatec-q1`) |
| `422` | `test_not_supported` | o protocolo não oferece teste |
| `422` | `test_requires_battery_percent` | `discharge_20pct` em telemetria **sem** percentual de bateria |
| `409` | `test_unavailable` / `test_in_progress` / `on_battery` / `battery_low` / `battery_too_low` / `battery_at_target` / `test_cooldown` / `test_not_running` | guardas de estado do teste |
| `400` | `invalid_request` | corpo não é objeto JSON válido (ou `type` não é string) |
| `404` | `device_not_found` / `test_not_found` | equipamento / teste inexistente |

### 1.7 Divergências observadas

Nenhuma divergência entre a implementação da API e o documento `api-unificada.md` foi encontrada. O
comportamento foi conferido contra os equipamentos reais:

- `GET /api/v1/ups` → `200`, `count: 2` — `tsshara-3200va-01` (`megatec-q1`, `telemetry_valid:true`)
  e `sms-ups3200s-01` (`sms-1phase`, `port_unavailable`: cabo USB ausente);
- `GET /health` → `503` `degraded`, agregado (`devices_total: 2`, `devices_ok: 1`, `devices{...}`);
- `GET /api/v1/ups/tsshara-3200va-01/telemetry` → `200`, entrada ~221 V, saída 111 V, 60 Hz,
  bateria 27 V, 26 °C, carga 11 %, bateria 100 % (estimada), `STANDBY` + `BEEP`;
- `GET /api/v1/ups/sms-ups3200s-01/telemetry` → `503` com `data: null` e
  `communication.state: "port_unavailable"` — repassado como `200` com o estado explícito;
- `?device_id=` desconhecido → `404 device_not_found`.

Os valores acima são **evidência de leituras específicas**, não valores esperados ou fixos.

---

## Parte 2 — API publicada pelo Web Viewer

Somente `GET`, exceto as rotas do teste de bateria (`/api/tests*`), que também aceitam `POST` — nunca
disparado de forma autônoma, só por ação do usuário. Os demais métodos recebem `405 method_not_allowed`.

### 2.1 `GET /healthz`

Saúde do **container** — não consulta a API de telemetria (um nobreak offline não deve reiniciar o
container).

```json
{ "status": "ok", "service": "ups-web-viewer", "version": "1.0.0", "read_only": true, "uptime_seconds": 123 }
```

### 2.2 `GET /api/config`

```json
{
  "viewer": { "name": "UPS Monitor — Web Viewer", "version": "1.0.0", "read_only": true,
              "refresh_interval_ms": 5000 },
  "upstream": { "base_url": "http://host.docker.internal:8080" },
  "device_id": null,
  "gauges": [ { "id": "input_voltage_v", "label": "Tensão de entrada", "unit": "V",
                "sources": [ { "path": "data.measurements.input_voltage_v" } ],
                "scale": { "min": 0, "max": 250, "ticks": [0, 50, 100, 150, 200, 250] },
                "bands": [ { "level": "critical", "from": 0, "to": 80, "label": "..." } ],
                "decimals": 0, "order": 1 } ],
  "threshold_problems": []
}
```

`sources[].path` é o caminho **exato** do campo no payload de telemetria; a interface lê o valor por
esse caminho — nenhum nome é reescrito no frontend. Uma métrica pode ter **mais de uma origem**
(protocolos diferentes publicam o mesmo dado em campos diferentes); a interface usa a **primeira
origem presente** no payload. Cada origem pode declarar, opcionalmente:

- `label` — rótulo alternativo da métrica quando essa origem é usada (ex.: "Frequência de saída");
- `origin_note` — selo exibido no cartão (ex.: `"estimativa"` no `megatec-q1`,
  `"informada pelo equipamento"` no `sms-1phase`);
- `secondary` — medição complementar exibida junto do gauge (`label`, `path`, `unit`, `decimals`),
  como a tensão da bateria.

`device_id` é `null` quando o backend descobre o equipamento automaticamente (ver §2.3).

`threshold_problems` lista incoerências de `VIEWER_GAUGE_THRESHOLDS` (JSON inválido, métrica
desconhecida, faixa fora da escala, faixas sobrepostas). Quando não está vazio, a interface exibe um
aviso informativo.

### 2.3 `GET /api/dashboard`

```json
{
  "viewer": {
    "name": "UPS Monitor — Web Viewer", "version": "1.0.0", "read_only": true,
    "generated_at_utc": "...", "refresh_interval_ms": 5000,
    "upstream": { "base_url": "...", "reachable": true, "http_status": 200,
                  "duration_ms": 12, "error": null },
    "device_id": "tsshara-3200va-01", "device_discovered": true,
    "upstream_contract": { "api_version": "v1", "contract_version": "3.0" },
    "warnings": [],
    "sources": {
      "health":    { "ok": true, "http_status": 200, "duration_ms": 8, "url": "...",
                     "error": null, "warnings": [] },
      "devices":   { "...": "..." },
      "telemetry": { "...": "..." },
      "identity":  { "...": "..." },
      "tests":     { "...": "..." }
    }
  },
  "health": null | { ... respostas da API, sem renomear campos ... },
  "devices": null | { ... },
  "telemetry": null | { ... },
  "identity": null | { ... },
  "tests": null | { ... histórico de `GET /api/v1/ups/{device_id}/tests` ... }
}
```

Os blocos `health`, `devices`, `telemetry`, `identity` e `tests` são **a resposta da API
preservada**, com os nomes de campo originais. `null` significa "não foi possível obter um payload
utilizável" e nunca é substituído por zeros. `health` traz o payload **agregado** (`devices_total`,
`devices_ok`, `devices{device_id:{...}}`); `devices` traz a lista de `GET /api/v1/ups` — é dela que a
interface monta o bloco "Nobreaks coletados" e lê `capabilities.battery_test`; `tests` traz o
histórico do teste de bateria (`count`, `tests[]`) e é consultado só quando há um teste em andamento
ou concluído. A **ausência** do histórico não derruba o dashboard: `tests` fica `null` e o painel
mostra o estado vazio.

**Escolha do equipamento.** `GET /api/dashboard?device_id=<id>` seleciona **um** nobreak. Sem o
parâmetro, o backend resolve pelo padrão, nesta ordem: `UPS_DEVICE_ID` → primeiro equipamento com
`telemetry_valid:true` → primeiro da lista → primeira chave de `health.devices`. Um `device_id`
desconhecido responde `404 device_not_found`. A interface envia a escolha do usuário no `query` e
sempre exibe o `device_id` que o backend **confirmou** ter servido (`viewer.device_id`), nunca o
pedido.

**Envelope de erro.** Quando o desfecho não é `200`, o corpo traz apenas `viewer` + `error`
(`{"viewer": {...}, "error": {"code": "...", "message": "..."}}`); os demais blocos ficam ausentes.
Nesses casos `viewer.upstream` **sempre** descreve a condição da API de origem (`reachable: false` e
`error` preenchido), inclusive quando a falha ocorreu na descoberta do equipamento em
`GET /api/v1/ups`. É o que permite à interface distinguir *"API de telemetria indisponível"* de
*"serviço do Web Viewer inacessível"* (escopo §10).

**Códigos**

| Código | `error.code` | Quando |
|---|---|---|
| `200` | — | Payload utilizável. Inclui o caso em que a API respondeu `503` mas publicou telemetria com `stale:true` |
| `404` | `device_not_found` | A API respondeu `device_not_found` para o `device_id` |
| `404` | `no_devices_configured` | `GET /api/v1/ups` não retornou equipamentos e `/health` não trouxe nenhum `device_id` |
| `502` | `upstream_unreachable` | Falha de rede/DNS/conexão até a API |
| `502` | `upstream_timeout` | Sem resposta dentro de `UPS_API_TIMEOUT_MS` |
| `502` | `upstream_invalid_json` | Resposta não é JSON válido |
| `502` | `upstream_unexpected_status` | Erro do contrato da API que não é `device_not_found` |
| `502` | `upstream_contract_mismatch` | JSON válido, mas fora do contrato documentado |
| `500` | `viewer_internal_error` | Falha inesperada do próprio Web Viewer |

### 2.4 `GET /api/devices`

`200` com `{ "viewer": {...}, "devices": {...} }`, ou o mesmo envelope de erro acima quando
`GET /api/v1/ups` falha.

### 2.5 `/api/tests…` — teste de bateria

As rotas de escrita do viewer **repassam** o pedido à API de origem (é ela quem executa o comando no
nobreak). Nenhum teste é disparado de forma autônoma: o `POST` só existe depois de uma ação
explicita do usuário no painel. Todas aceitam `?device_id=...`; sem o parâmetro, o backend resolve o
equipamento como em §2.3.

| Rota | Corpo | Sucesso | Erros |
|---|---|---|---|
| `POST /api/tests` | `{ "type": "duration_10s" }` ou `{ "type": "discharge_20pct" }` (opcional; ausente = `duration_10s`) | `202` com o aceite (`test_id`, `type`, `status`, `poll_interval_s`, `report_url`) | Envelope de erro (§2.3) com o `error.code` da API: `403 test_disabled`, `409 test_cooldown`/`battery_too_low`/`on_battery`/`battery_low`/`battery_at_target`/`test_in_progress`/`test_unavailable`, `422 unsupported_test_type`/`test_not_supported`/`test_requires_battery_percent`, `404 device_not_found` |
| `GET /api/tests/{test_id}` | — | `200` com o relatório (`test`), parcial enquanto `running` | `404 test_not_found`; `502 upstream_*` se a API não responder |
| `POST /api/tests/{test_id}/abort` | — | `202` com `status: "aborting"` | `409 test_not_running`; `422`/`403` quando o protocolo não cancela |

O corpo de sucesso é o payload da API **preservado** (mesmos nomes de campo). A interface oferece
**apenas** os tipos declarados em `capabilities.battery_test.test_types` do equipamento escolhido —
oferecer `discharge_20pct` onde a API não o declara só produziria `422 unsupported_test_type`. A
interface faz o polling do relatório a cada `poll_interval_s` informado no aceite e para quando o
`status` deixa de ser `running`.

### 2.6 Caminho inexistente

`404` `{ "error": { "code": "not_found", "message": "recurso não encontrado nesta aplicação" } }`.

### 2.7 Interface estática

Quando `VIEWER_STATIC_DIR` aponta para a interface compilada, qualquer rota que não seja `/api/*` ou
`/healthz` devolve `index.html` (SPA). É o que permite servir interface e API na mesma origem, sem
CORS.
