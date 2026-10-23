/**
 * DADOS SIMULADOS — NÃO SÃO TELEMETRIA REAL.
 *
 * Usados apenas quando `VITE_ENABLE_DEMO=true` (arquivo `.env.development`).
 * Servem para validar a hierarquia visual sem depender da API. A interface marca
 * explicitamente esse modo com uma faixa de aviso, e em produção a variável não
 * é definida, portanto este módulo nunca alimenta a tela publicada.
 *
 * O formato segue o contrato 3.0 (multidispositivo/multiprotocolo): a lista de
 * equipamentos traz dois nobreaks — cada um com `capabilities.battery_test` — e
 * cada gauge declara as origens possíveis por protocolo. A telemetria simulada é
 * a do TS Shara (`megatec-q1`) e o histórico traz um teste já concluído.
 */
import type { DashboardPayload, GaugeDefinition, ViewerConfigPayload } from "../model/contract.js";

const DEVICE_ID = "tsshara-3200va-01";
const SMS_DEVICE_ID = "sms-ups3200s-01";
const GENERATED_AT = "2026-10-22T12:00:00.000Z";

export const DEMO_GAUGES: GaugeDefinition[] = [
  {
    id: "input_voltage_v",
    label: "Tensão de entrada",
    unit: "V",
    sources: [{ path: "data.measurements.input_voltage_v" }],
    scale: { min: 0, max: 250, ticks: [0, 50, 100, 150, 200, 250] },
    bands: [
      { level: "critical", from: 0, to: 80, label: "Tensão fora da faixa (baixa)" },
      { level: "good", from: 80, to: 127, label: "Dentro da faixa esperada (127 V)" },
      { level: "critical", from: 127, to: 200, label: "Tensão fora da faixa (intermediária)" },
      { level: "good", from: 200, to: 225, label: "Dentro da faixa esperada (220 V)" },
      { level: "critical", from: 225, to: 250, label: "Tensão fora da faixa (alta)" },
    ],
    decimals: 0,
    order: 1,
  },
  {
    id: "output_voltage_v",
    label: "Tensão de saída",
    unit: "V",
    sources: [{ path: "data.measurements.output_voltage_v" }],
    scale: { min: 0, max: 250, ticks: [0, 50, 100, 150, 200, 250] },
    bands: [
      { level: "critical", from: 0, to: 80, label: "Tensão fora da faixa (baixa)" },
      { level: "good", from: 80, to: 127, label: "Dentro da faixa esperada (127 V)" },
      { level: "critical", from: 127, to: 200, label: "Tensão fora da faixa (intermediária)" },
      { level: "good", from: 200, to: 225, label: "Dentro da faixa esperada (220 V)" },
      { level: "critical", from: 225, to: 250, label: "Tensão fora da faixa (alta)" },
    ],
    decimals: 0,
    order: 2,
  },
  {
    id: "input_frequency_hz",
    label: "Frequência de entrada",
    unit: "Hz",
    sources: [
      { path: "data.measurements.input_frequency_hz" },
      { path: "data.measurements.output_frequency_hz", label: "Frequência de saída" },
    ],
    scale: { min: 20, max: 70, ticks: [20, 30, 40, 50, 60, 70] },
    bands: [
      { level: "critical", from: 20, to: 42, label: "Frequência fora da faixa (baixa)" },
      { level: "warning", from: 42, to: 47, label: "Atenção: frequência baixa" },
      { level: "good", from: 47, to: 53, label: "Frequência normal (50 Hz)" },
      { level: "warning", from: 53, to: 57, label: "Atenção: frequência fora do ideal" },
      { level: "good", from: 57, to: 60, label: "Frequência normal (60 Hz)" },
      { level: "warning", from: 60, to: 63, label: "Atenção: frequência alta" },
      { level: "critical", from: 63, to: 70, label: "Frequência fora da faixa (alta)" },
    ],
    decimals: 1,
    order: 3,
  },
  {
    id: "temperature_c",
    label: "Temperatura interna",
    unit: "°C",
    sources: [{ path: "data.measurements.temperature_c" }],
    scale: { min: 0, max: 50, ticks: [0, 10, 20, 30, 40, 50] },
    bands: [
      { level: "good", from: 0, to: 25, label: "Temperatura normal" },
      { level: "warning", from: 25, to: 35, label: "Atenção: temperatura elevada" },
      { level: "critical", from: 35, to: 50, label: "Temperatura crítica" },
    ],
    decimals: 0,
    order: 4,
  },
  {
    id: "battery_charge_percent",
    label: "Carga da bateria",
    unit: "%",
    sources: [
      {
        path: "data.battery_charge.percent",
        origin_note: "estimativa",
        secondary: {
          label: "Tensão da bateria (medição)",
          path: "data.measurements.battery_voltage_v",
          unit: "V",
          decimals: 1,
        },
      },
      {
        path: "data.battery.charge_percent",
        origin_note: "informada pelo equipamento",
        secondary: {
          label: "Tensão da bateria (derivada pela API)",
          path: "data.battery.voltage_v",
          unit: "V",
          decimals: 1,
        },
      },
    ],
    scale: { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] },
    bands: [
      { level: "critical", from: 0, to: 20, label: "Carga crítica" },
      { level: "warning", from: 20, to: 40, label: "Atenção: carga baixa" },
      { level: "good", from: 40, to: 100, label: "Carga adequada" },
    ],
    decimals: 0,
    order: 5,
  },
  {
    id: "load_percent",
    label: "Carga do nobreak",
    unit: "%",
    sources: [{ path: "data.measurements.load_percent" }],
    scale: { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] },
    bands: [
      { level: "good", from: 0, to: 50, label: "Carga adequada" },
      { level: "warning", from: 50, to: 75, label: "Atenção: carga elevada" },
      { level: "critical", from: 75, to: 100, label: "Carga crítica" },
    ],
    decimals: 0,
    order: 6,
  },
];

export const DEMO_CONFIG: ViewerConfigPayload = {
  viewer: {
    name: "UPS Monitor — Web Viewer",
    version: "1.0.0-demo",
    read_only: true,
    refresh_interval_ms: 5000,
  },
  upstream: { base_url: "http://(demonstração)/api/v1" },
  device_id: DEVICE_ID,
  gauges: DEMO_GAUGES,
  threshold_problems: [],
};

export const DEMO_DASHBOARD: DashboardPayload = {
  viewer: {
    name: "UPS Monitor — Web Viewer",
    version: "1.0.0-demo",
    read_only: true,
    generated_at_utc: GENERATED_AT,
    refresh_interval_ms: 5000,
    upstream: {
      base_url: "http://(demonstração)/api/v1",
      reachable: true,
      http_status: 200,
      duration_ms: 12,
      error: null,
    },
    device_id: DEVICE_ID,
    device_discovered: true,
    upstream_contract: { api_version: "v1", contract_version: "3.0" },
    warnings: ["MODO DEMONSTRAÇÃO: dados simulados, não são telemetria real."],
    sources: {
      health: { ok: true, http_status: 200, duration_ms: 8, url: "/health", error: null, warnings: [] },
      devices: { ok: true, http_status: 200, duration_ms: 9, url: "/api/v1/ups", error: null, warnings: [] },
      telemetry: { ok: true, http_status: 200, duration_ms: 14, url: "/telemetry", error: null, warnings: [] },
      identity: { ok: true, http_status: 200, duration_ms: 10, url: "/identity", error: null, warnings: [] },
      tests: { ok: true, http_status: 200, duration_ms: 11, url: "/tests?limit=10", error: null, warnings: [] },
    },
  },
  health: {
    api_version: "v1",
    contract_version: "3.0",
    status: "ok",
    checked_at_utc: GENERATED_AT,
    uptime_seconds: 3600,
    devices_total: 2,
    devices_ok: 2,
    devices: {
      [DEVICE_ID]: {
        telemetry_valid: true,
        stale: false,
        state: "ok",
        serial_port: "/dev/ttyACM0",
        collector_thread: "ok",
        telemetry_freshness: "ok",
        communication: "ok",
        identity: "ok",
        last_success_utc: GENERATED_AT,
        age_seconds: 2,
      },
      [SMS_DEVICE_ID]: {
        telemetry_valid: true,
        stale: false,
        state: "ok",
        serial_port: "/dev/ttyUSB0",
        collector_thread: "ok",
        telemetry_freshness: "ok",
        communication: "ok",
        identity: "ok",
        last_success_utc: GENERATED_AT,
        age_seconds: 1.4,
      },
    },
  },
  devices: {
    api_version: "v1",
    contract_version: "3.0",
    count: 2,
    devices: [
      {
        device_id: DEVICE_ID,
        brand: "TS Shara",
        model: "Universal UPS Senoidal 3200VA",
        transport: "usb-serial-cdc-acm",
        protocol: "megatec-q1",
        serial_port: "/dev/ttyACM0",
        communication_state: "ok",
        telemetry_valid: true,
        telemetry_endpoint: `/api/v1/ups/${DEVICE_ID}/telemetry`,
        identity_endpoint: `/api/v1/ups/${DEVICE_ID}/identity`,
        // O TS Shara (megatec-q1) NÃO expõe o teste por padrão: `enabled=false`.
        // O protocolo só oferece a janela de 10 s — a descarga controlada exige
        // que o equipamento informe o percentual da bateria.
        capabilities: {
          battery_test: {
            supported: true,
            enabled: false,
            test_types: ["duration_10s"],
            types: {
              duration_10s: { duration_s: 10, sample_interval_s: 0.4 },
            },
            duration_s: 10,
            sample_interval_s: 0.4,
            cooldown_s: 300,
            min_battery_percent: 50,
            abort_supported: false,
          },
        },
      },
      {
        device_id: SMS_DEVICE_ID,
        brand: "SMS",
        model: "Power Sinus NG uPS3200S",
        transport: "usb-serial",
        protocol: "sms-1phase",
        serial_port: "/dev/ttyUSB0",
        communication_state: "ok",
        telemetry_valid: true,
        telemetry_endpoint: `/api/v1/ups/${SMS_DEVICE_ID}/telemetry`,
        identity_endpoint: `/api/v1/ups/${SMS_DEVICE_ID}/identity`,
        // O SMS informa o percentual da bateria, então oferece também a descarga
        // controlada: até o alvo de 20 % ou o teto de 30 min, o que vier primeiro.
        capabilities: {
          battery_test: {
            supported: true,
            enabled: true,
            test_types: ["duration_10s", "discharge_20pct"],
            types: {
              duration_10s: { duration_s: 10, sample_interval_s: 0.4 },
              discharge_20pct: { target_percent: 20, timeout_s: 1800, sample_interval_s: 1.0 },
            },
            duration_s: 10,
            sample_interval_s: 0.4,
            cooldown_s: 300,
            min_battery_percent: 50,
            abort_supported: true,
          },
        },
      },
    ],
  },
  telemetry: {
    api_version: "v1",
    contract_version: "3.0",
    device_id: DEVICE_ID,
    telemetry_valid: true,
    stale: false,
    data_available: true,
    data: {
      captured_at_utc: GENERATED_AT,
      source: "megatec-q1",
      measurements: {
        input_voltage_v: 222,
        input_voltage_fault_v: 222,
        output_voltage_v: 112,
        load_percent: 11,
        input_frequency_hz: 60,
        battery_voltage_v: 27.4,
        temperature_c: 26,
      },
      battery_charge: {
        percent: 100,
        estimated: true,
        method: "linear_voltage_interpolation",
        calibration: { voltage_low_v: 20.1, voltage_high_v: 26.8 },
      },
      status: {
        raw_bits: "00001001",
        active: ["STANDBY", "BEEP"],
        flags: {
          OB: false,
          LB: false,
          BOOST: false,
          FAULT: false,
          STANDBY: true,
          TEST: false,
          FSD: false,
          BEEP: true,
        },
      },
      age_seconds: 2,
    },
    communication: {
      state: "ok",
      telemetry_valid: true,
      stale: false,
      last_attempt_utc: GENERATED_AT,
      last_success_utc: GENERATED_AT,
      age_seconds: 2,
      consecutive_failures: 0,
      total_attempts: 720,
      total_successes: 720,
      last_error: null,
      serial_port: "/dev/ttyACM0",
      poll_interval_s: 5,
      stale_after_s: 20,
    },
  },
  identity: {
    api_version: "v1",
    contract_version: "3.0",
    device_id: DEVICE_ID,
    identity_available: true,
    data: {
      captured_at_utc: GENERATED_AT,
      device: {
        manufacturer: "TS -222  091225",
        model: "Senoid  32",
        firmware: "V01020805A",
        raw_frame: "#TS -222  091225 Senoid  32 V01020805A",
      },
      nominal: {
        voltage_label: "Univ.",
        voltage_v: null,
        input_current_a: 100,
        battery_voltage_v: 24,
        frequency_hz: 60,
        raw_frame: "#Univ. 100 24.00 60.0",
      },
    },
    communication: { state: "ok", telemetry_valid: true, stale: false, age_seconds: 2 },
  },
  // Histórico simulado do teste de bateria (contrato 3.0): um teste já concluído,
  // para validar a hierarquia do painel sem precisar acionar o nobreak.
  tests: {
    api_version: "v1",
    contract_version: "3.0",
    device_id: DEVICE_ID,
    count: 1,
    tests: [
      {
        test_id: "demo-20261022T115900Z",
        type: "duration_10s",
        status: "completed",
        started_at_utc: "2026-10-22T11:59:00.000Z",
        expected_end_at_utc: "2026-10-22T11:59:10.000Z",
        ended_at_utc: "2026-10-22T11:59:10.320Z",
        duration_s: 10.3,
        finish_reason: "duration_elapsed",
        samples_count: 25,
        flags_seen: ["TEST", "OB"],
        estimate: {
          available: true,
          method: "linear_first_order_extrapolation",
          window_s: 10,
          start_charge_percent: 100,
          drop_percent_in_window: 1.6,
          discharge_rate_pp_per_min: 9.6,
          estimated_runtime_min: 10.4,
          capped_at_min: 600,
          confidence: "low",
        },
      },
    ],
  },
};
