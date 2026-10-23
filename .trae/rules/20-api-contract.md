---
description: Regras obrigatórias de fidelidade ao contrato da API de telemetria
globs: ["src/**/*.ts", "src/**/*.tsx"]
alwaysApply: true
---

# 20 — Contrato da API

Contrato completo: [docs/contrato-api.md](../../docs/contrato-api.md). A fonte de verdade é
[`monitor/docs/api-unificada.md`](../../monitor/docs/api-unificada.md) (API unificada, vários
nobreaks em vários protocolos — `contract_version` **3.0**) e, para o teste de bateria,
[`monitor/docs/integracao-web-viewer.md`](../../monitor/docs/integracao-web-viewer.md) §11.

## Regras invioláveis

1. **Somente GET — com uma única exceção controlada.** O único `POST` é o do **teste de bateria**
   (`/api/tests` no viewer → `POST /api/v1/ups/{device_id}/tests`), e só por ação explícita do
   usuário: **nenhum teste é disparado de forma autônoma** e nenhum comando é enviado diretamente ao
   nobreak. `PUT`/`PATCH`/`DELETE` continuam proibidos: o `apiClient` recusa localmente
   (`viewer_invalid_method`) e o servidor do viewer responde `405` a métodos ≠ GET, exceto `POST` em
   `/api/tests*`.
2. **Não renomeie nada.** Nomes de campo, unidades e caminhos JSON são os da API
   (`input_voltage_v`, `load_percent`, `data.battery_charge.percent`, ...). A interface lê pelos
   caminhos em `sources[]` definidos em `gaugeConfig.ts` (uma ou mais origens, uma por protocolo).
3. **`null` continua `null`.** Nunca converta `null` em `0` nem em qualquer valor fictício. Campo
   ausente continua ausente e aparece como "Sem dados".
4. **Não invente campos, endpoints, unidades ou estados.** Se a resposta divergir do documento,
   registre a divergência em `viewer.warnings` e relate — sem adaptação silenciosa.
5. **Não dependa de FastAPI** nem de qualquer detalhe interno da API: o acoplamento é HTTP/JSON.
6. **HTTP 503 ≠ falha total.** Se a API responder `503` com payload de telemetria válido, repasse-o
   com `200` e deixe `telemetry_valid`, `stale` e `communication.state` explicarem o estado.
7. **A bateria tem regra OPOSTA por protocolo.** `megatec-q1`: `data.battery_charge.percent` é
   **ESTIMATIVA** (interpolação linear da tensão; o protocolo Q1 não transmite percentual) — a
   interface marca isso e mostra `battery_voltage_v` em campo separado. `sms-1phase`:
   `data.battery.charge_percent` é **informado pelo equipamento** (`charge_source:
   "reported_by_device"`) e **não é estimativa**; `voltage_v` é derivada (`voltage_derived: true`).
   O selo é por origem (`origin_note`), nunca fixo na métrica.
8. **Não infira "rede elétrica normal"** a partir da ausência da flag `OB`.
9. **Flags do quadro — o significado muda por protocolo.** `megatec-q1`: `OB` (b7), `LB` (b6),
   `BOOST` (b5), `FAULT` (b4), `STANDBY` (b3), `TEST` (b2), `FSD` (b1), `BEEP` (b0). `sms-1phase`:
   `OB` (b7), `LB` (b6), `BYPASS` (b5), `BOOST` (b4), `UPSOK` (b3), `TEST` (b2), `FSD` (b1),
   `BEEP` (b0) — b5/b4/b3 têm significado diferente. A tabela é escolhida por `data.source`
   (`flagMetaForProtocol`); protocolo desconhecido → tabela Q1. Flags novas (outros modelos) são
   exibidas como não documentadas, sem significado inventado.
10. **Estados de comunicação**: `starting`, `ok`, `stale`, `port_unavailable`, `permission_denied`,
    `disconnected`, `timeout`, `invalid_response`, `incomplete_response`, `parse_error`,
    `checksum_error`, `out_of_range`, `serial_error`. Estado novo → exibir o próprio código.
11. **Multidispositivo, um por vez.** A API publica N nobreaks; a interface seleciona **um** e envia
    `GET /api/dashboard?device_id=...`. Sem o parâmetro, o backend resolve por `UPS_DEVICE_ID` →
    primeiro com `telemetry_valid:true` → primeiro da lista → primeira chave de `health.devices`.
    `device_id` desconhecido → `404 device_not_found`. Nunca exiba dois ao mesmo tempo nem invente
    um equipamento.
12. **Teste de bateria (3.0) — a API entrega fatos, o viewer apresenta.** Só habilite o botão quando
    `capabilities.battery_test.enabled` é `true`; ofereça cancelamento só com `abort_supported`. Ofereça
    **apenas** os tipos de `test_types` (`duration_10s`; `discharge_20pct` só onde a API o declara) —
    presumir capacidade pelo protocolo produz `422 unsupported_test_type`. No `discharge_20pct` o
    `timeout_s` (1800 s) é **teto**, não duração prevista: o progresso vem da queda de carga até
    `target_percent` (indeterminado quando não há dado), nunca do relógio. O
    `POST` responde `202` e **não** é o resultado: acompanhe `report_url` e pare quando o `status`
    deixar de ser `running`. `estimate` é extrapolação linear de 1ª ordem (`confidence: "low"`);
    quando `available` é `false`, exiba o `reason` e **nunca** invente um número; `capped_at_min` é
    piso ("≥ 10 h"), não precisão. Exiba `test_flag_observed`/`flags_seen` para confirmar que o
    nobreak **realmente** reportou o estado de teste (`TEST`) na janela; se não reportou, avise.
13. **Gráficos do teste: `samples[].normalized`, nunca `measurements`.** Os gráficos são
    `samples[].offset_s` (X) contra uma chave de `normalized` (`output_voltage_v`, `frequency_hz`,
    `temperature_c`, `battery_charge_percent`, `load_percent`, `battery_voltage_v`) — o bloco
    `measurements` varia por protocolo. Chave **ausente** = série indisponível: mostre isso e **nunca**
    desenhe zero no lugar do dado ausente.

## Campos de telemetria (caminhos exatos)

```
data.captured_at_utc, data.source (protocolo), data.raw_frame, data.age_seconds
data.measurements.input_voltage_v, .output_voltage_v, .load_percent, .temperature_c   (comuns)
   megatec-q1: .input_voltage_fault_v, .input_frequency_hz, .battery_voltage_v
   sms-1phase: .input_voltage_extended_v, .output_frequency_hz
data.battery_charge.percent, .estimated, .method, .calibration.voltage_low_v/.voltage_high_v   (megatec-q1)
data.battery.charge_percent, .charge_source, .voltage_v, .voltage_derived, .voltage_nominal_v, .packs   (sms-1phase)
data.status.raw_bits, .raw_byte, .active[], .flags{}
communication.state, .telemetry_valid, .stale, .age_seconds, .last_success_utc,
              .consecutive_failures, .last_error{code,message,at_utc}, .serial_port,
              .poll_interval_s, .stale_after_s
```

`/health` (2.0+) é agregado: `status` (`ok`/`degraded`/`down`), `devices_total`, `devices_ok` e
`devices.{device_id}.{telemetry_valid, stale, state, serial_port, communication, identity,
last_success_utc, age_seconds}`.

Teste de bateria (3.0): `capabilities.battery_test.{supported, enabled, test_types[], types.{duration_10s,
discharge_20pct}.{duration_s, target_percent, timeout_s, sample_interval_s}, duration_s,
sample_interval_s, cooldown_s, min_battery_percent, abort_supported}` em `GET /api/v1/ups`;
`POST .../tests` com `{type}` → aceite `202` (`test_id`, `type`, `status`, `poll_interval_s`,
`report_url`, `requested_duration_s`, `target_percent`, `timeout_s`);
`GET .../tests/{test_id}` → `test.{type, status, started_at_utc, expected_end_at_utc, ended_at_utc,
duration_s, requested_duration_s, target_percent, timeout_s, finish_reason, test_flag_observed,
flags_seen, baseline, final, deltas.window_s,
deltas.sample_count, deltas.metrics.{start,end,min,max,delta,ripple,max_abs_deviation,count},
estimate.{available, method, window_s, start_charge_percent, drop_percent_in_window,
discharge_rate_pp_per_min, estimated_runtime_min, capped_at_min, confidence, reason}, samples_count,
error, samples[{offset_s, normalized{}, measurements{}, status{}, battery{}}]}`;
`GET .../tests?limit=N` → `count` + `tests[]` (sem `samples`);
`POST .../tests/{test_id}/abort` → `202` com `status: "aborting"`. `finish_reason`:
`duration_elapsed`, `target_percent_reached`, `test_flag_cleared`, `aborted`, `battery_low`,
`watchdog`, `stopping`, `serial_error`.

Envelope: `api_version` (`v1`) e `contract_version` (`3.0`) em **todas** as respostas, inclusive
erros (`{"error": {"code", "message"}}`). Datas em ISO 8601 UTC com sufixo `Z`.

## Códigos HTTP da API

| Código | Significado | Tratamento |
|---|---|---|
| `200` | Dado íntegro | Repassar |
| `202` | Teste de bateria aceito (assíncrono) | Repassar; **não** é o resultado do teste |
| `404` `not_found` | Caminho inexistente | `502 upstream_contract_mismatch` |
| `404` `device_not_found` | `device_id` não configurado | `404 device_not_found` |
| `404` `test_not_found` | `test_id` desconhecido | `404 test_not_found` |
| `405` `method_not_allowed` | Método ≠ GET (fora de `/tests`) | Não deve ocorrer |
| `403` `test_disabled` | Teste não habilitado | Repassar; botão só com `enabled: true` |
| `409` | Guardas do teste (`test_cooldown`, `battery_too_low`, `on_battery`, `battery_low`, `test_in_progress`, `test_unavailable`, `test_not_running`) | Repassar com o `error.code` da API |
| `422` | `unsupported_test_type`, `test_not_supported` | Repassar com o `error.code` da API |
| `503` | Sem dado utilizável | Repassar com `200` e estado explícito |
