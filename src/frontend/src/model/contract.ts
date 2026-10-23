/**
 * Tipos do payload publicado pelo backend do Web Viewer (`GET /api/dashboard`,
 * `GET /api/config`, `GET /api/devices`).
 *
 * O bloco `telemetry` reproduz literalmente o contrato da API de telemetria
 * (v1/3.0, multidispositivo e multiprotocolo): os nomes de campo abaixo são os
 * da API, não apelidos da interface.
 *
 * O contrato 3.0 acrescenta o teste de bateria: `capabilities.battery_test` na
 * descoberta (`GET /api/v1/ups`) e o relatório de previsibilidade
 * (`GET .../tests/{test_id}`). A leitura continua idêntica; a única escrita é o
 * pedido de teste, repassado pelo backend do viewer.
 */

export interface ViewerSourceStatus {
  ok: boolean;
  http_status: number | null;
  duration_ms: number | null;
  url: string | null;
  error: { code: string; message: string } | null;
  warnings: string[];
}

export interface ViewerSection {
  name: string;
  version: string;
  read_only: true;
  generated_at_utc: string;
  refresh_interval_ms: number;
  upstream: {
    base_url: string;
    reachable: boolean;
    http_status: number | null;
    duration_ms: number | null;
    error: { code: string; message: string } | null;
  };
  device_id: string | null;
  device_discovered: boolean;
  upstream_contract: { api_version: string; contract_version: string } | null;
  warnings: string[];
  sources: {
    health: ViewerSourceStatus;
    devices: ViewerSourceStatus;
    telemetry: ViewerSourceStatus;
    identity: ViewerSourceStatus;
    /** Histórico do teste de bateria (`GET .../tests?limit=N`, contrato 3.0). */
    tests: ViewerSourceStatus;
  };
}

export interface CommunicationLastError {
  code?: string;
  message?: string;
  at_utc?: string | null;
}

export interface CommunicationState {
  state: string;
  telemetry_valid?: boolean;
  stale?: boolean;
  last_attempt_utc?: string | null;
  last_success_utc?: string | null;
  age_seconds?: number | null;
  consecutive_failures?: number;
  total_attempts?: number;
  total_successes?: number;
  last_error?: CommunicationLastError | null;
  serial_port?: string | null;
  poll_interval_s?: number;
  stale_after_s?: number;
}

/** Bloco de bateria do `megatec-q1` (percentual ESTIMADO por interpolação). */
export interface BatteryCharge {
  percent: number | null;
  estimated?: boolean;
  method?: string;
  calibration?: { voltage_low_v?: number | null; voltage_high_v?: number | null };
}

/**
 * Bloco de bateria do `sms-1phase`: percentual **informado pelo equipamento** e
 * tensão **derivada** pela API (`voltage_derived`). Não é estimativa.
 */
export interface BatteryReported {
  charge_percent: number | null;
  charge_source?: string;
  voltage_v?: number | null;
  voltage_derived?: boolean;
  voltage_nominal_v?: number | null;
  packs?: number | null;
}

export interface StatusBlock {
  raw_bits?: string;
  /** O `sms-1phase` publica também o byte de estado em decimal. */
  raw_byte?: number;
  active?: string[];
  flags?: Record<string, boolean>;
}

export interface TelemetryData {
  captured_at_utc?: string | null;
  /** Protocolo que originou o quadro (`megatec-q1`, `sms-1phase`, ...). */
  source?: string;
  measurements: Record<string, number | null>;
  battery_charge?: BatteryCharge;
  battery?: BatteryReported;
  status?: StatusBlock;
  raw_frame?: string;
  age_seconds?: number | null;
}

export interface TelemetryPayload {
  api_version: string;
  contract_version: string;
  device_id: string;
  telemetry_valid: boolean;
  stale: boolean;
  data_available: boolean;
  data: TelemetryData | null;
  communication: CommunicationState;
}

export interface IdentityPayload {
  api_version: string;
  contract_version: string;
  device_id: string;
  identity_available: boolean;
  data: {
    captured_at_utc?: string | null;
    device?: {
      manufacturer?: string | null;
      model?: string | null;
      firmware?: string | null;
      raw_frame?: string | null;
    };
    nominal?: {
      voltage_label?: string | null;
      voltage_v?: number | null;
      input_current_a?: number | null;
      battery_voltage_v?: number | null;
      frequency_hz?: number | null;
      raw_frame?: string | null;
    };
  } | null;
  configured?: Record<string, unknown>;
  communication?: CommunicationState;
}

export interface DevicesPayload {
  api_version: string;
  contract_version: string;
  count?: number;
  devices: Array<{
    device_id: string;
    brand?: string | null;
    model?: string | null;
    transport?: string | null;
    protocol?: string | null;
    serial_port?: string | null;
    communication_state?: string | null;
    /** O `sms-1phase` e o `megatec-q1` publicam se há leitura fresca agora. */
    telemetry_valid?: boolean;
    telemetry_endpoint?: string | null;
    identity_endpoint?: string | null;
    /** Contrato 3.0: descreve o teste de bateria disponível neste equipamento. */
    capabilities?: DeviceCapabilities;
  }>;
}

/** Disponibilidade de UM equipamento dentro de `GET /health` (contrato 2.0). */
export interface HealthDeviceStatus {
  telemetry_valid?: boolean;
  stale?: boolean;
  state?: string;
  serial_port?: string | null;
  collector_thread?: string | null;
  telemetry_freshness?: string | null;
  communication?: string | null;
  identity?: string | null;
  last_success_utc?: string | null;
  age_seconds?: number | null;
}

/**
 * `GET /health` do contrato 2.0 é **agregado** por `device_id` em `devices`
 * (os campos `device_id`, `checks` e `collector` do contrato 1.0 não existem mais).
 */
export interface HealthPayload {
  api_version: string;
  contract_version: string;
  status: string;
  checked_at_utc?: string | null;
  uptime_seconds?: number | null;
  devices_total?: number | null;
  devices_ok?: number | null;
  devices?: Record<string, HealthDeviceStatus>;
}

export interface DashboardPayload {
  viewer: ViewerSection;
  /**
   * Presente quando o backend respondeu com envelope de erro (ex.: 502/404).
   * Descreve a condição da API de origem — não é falha do serviço do Web Viewer.
   */
  error?: { code: string; message: string } | null;
  health: HealthPayload | null;
  devices: DevicesPayload | null;
  telemetry: TelemetryPayload | null;
  identity: IdentityPayload | null;
  /**
   * Histórico recente do teste de bateria (`GET .../tests?limit=N`, contrato
   * 3.0) — sem a série de amostras. É um extra do painel: pode vir `null`
   * quando a API não expõe o histórico.
   */
  tests: TestsListPayload | null;
}

// ------------------------ teste de bateria (contrato 3.0) -------------------

/**
 * Parâmetros de UM tipo de teste, publicados em
 * `capabilities.battery_test.types.<type>`: é o que distingue o teste de janela
 * (`duration_s`) do teste por alvo (`target_percent` + `timeout_s`).
 */
export interface BatteryTestTypeParams {
  duration_s?: number | null;
  target_percent?: number | null;
  timeout_s?: number | null;
  sample_interval_s?: number | null;
}

/**
 * Contrato de descoberta do teste. `enabled` decide se o botão pode ser
 * acionado; `abort_supported` se existe cancelamento; os demais campos são os
 * parâmetros efetivos do dispositivo (janela, cadência de amostragem, cooldown
 * e carga mínima).
 */
export interface BatteryTestCapabilities {
  supported?: boolean;
  enabled?: boolean;
  /** Tipos aceitos por ESTE equipamento — nenhum tipo fora desta lista é oferecido. */
  test_types?: string[];
  /** Detalhe por tipo (janela × alvo). */
  types?: Record<string, BatteryTestTypeParams>;
  duration_s?: number | null;
  sample_interval_s?: number | null;
  cooldown_s?: number | null;
  min_battery_percent?: number | null;
  abort_supported?: boolean;
}

export interface DeviceCapabilities {
  battery_test?: BatteryTestCapabilities;
}

/** Aceite do pedido de teste (`POST .../tests` → 202; execução assíncrona). */
export interface BatteryTestAccept {
  accepted_at_utc?: string | null;
  poll_interval_s?: number | null;
  test_id: string;
  device_id: string;
  type?: string;
  status: string;
  started_at_utc?: string | null;
  expected_end_at_utc?: string | null;
  requested_duration_s?: number | null;
  /** Alvo de carga do teste de descarga; `null` no teste de janela. */
  target_percent?: number | null;
  /** Teto de segurança do teste. */
  timeout_s?: number | null;
  sample_interval_s?: number | null;
  report_url?: string | null;
}

/** Resposta do cancelamento (`POST .../tests/{id}/abort` → 202). */
export interface BatteryTestAbort {
  test_id: string;
  device_id: string;
  status: string;
}

/** Agregação por métrica dentro do relatório (`deltas.metrics`). */
export interface BatteryTestMetricDelta {
  start?: number | null;
  end?: number | null;
  min?: number | null;
  max?: number | null;
  delta?: number | null;
  ripple?: number | null;
  max_abs_deviation?: number | null;
  count?: number | null;
}

/**
 * Estimativa de autonomia: extrapolação linear de 1ª ordem, sempre
 * `confidence: "low"`. Quando `available` é `false`, o campo `reason` explica —
 * a interface NUNCA converte isso em número.
 */
export interface BatteryTestEstimate {
  available: boolean;
  method?: string;
  window_s?: number | null;
  start_charge_percent?: number | null;
  drop_percent_in_window?: number | null;
  discharge_rate_pp_per_min?: number | null;
  estimated_runtime_min?: number | null;
  capped_at_min?: number | null;
  confidence?: string;
  reason?: string;
}

/**
 * Uma amostra da linha do tempo. `normalized` é o espelho padronizado das
 * métricas entre protocolos e é a base dos gráficos; `measurements` mantém os
 * nomes crus de cada modelo.
 */
export interface BatteryTestSample {
  offset_s?: number | null;
  normalized?: Record<string, number | null>;
  measurements?: Record<string, number | null>;
  status?: StatusBlock;
  battery?: { charge_percent?: number | null; voltage_v?: number | null };
}

/** Relatório completo de um teste (parcial enquanto `status = "running"`). */
export interface BatteryTestReport {
  test_id: string;
  device_id?: string;
  type?: string;
  status: string;
  started_at_utc?: string | null;
  expected_end_at_utc?: string | null;
  ended_at_utc?: string | null;
  requested_duration_s?: number | null;
  duration_s?: number | null;
  sample_interval_s?: number | null;
  /** Alvo de carga do teste de descarga; `null` no teste de janela. */
  target_percent?: number | null;
  /** Teto de segurança do teste. */
  timeout_s?: number | null;
  finish_reason?: string | null;
  /** `true` se o nobreak ligou a flag `TEST` (confirma que o teste ocorreu). */
  test_flag_observed?: boolean;
  flags_seen?: string[];
  baseline?: Record<string, number | null>;
  final?: Record<string, number | null>;
  deltas?: {
    window_s?: number | null;
    sample_count?: number | null;
    metrics?: Record<string, BatteryTestMetricDelta>;
  };
  estimate?: BatteryTestEstimate | null;
  samples_count?: number | null;
  error?: { code: string; message: string } | null;
  samples?: BatteryTestSample[];
}

/** Item do histórico (`GET .../tests`): relatório sem a série de amostras. */
export interface BatteryTestListItem {
  test_id: string;
  type?: string;
  status: string;
  started_at_utc?: string | null;
  expected_end_at_utc?: string | null;
  ended_at_utc?: string | null;
  duration_s?: number | null;
  finish_reason?: string | null;
  samples_count?: number | null;
  flags_seen?: string[];
  estimate?: BatteryTestEstimate | null;
  error?: { code: string; message: string } | null;
}

export interface TestsListPayload {
  api_version: string;
  contract_version: string;
  device_id: string;
  count?: number;
  tests: BatteryTestListItem[];
}

/** Respostas das ações do teste publicadas pelo backend do viewer. */
export interface BatteryTestAcceptPayload {
  viewer: ViewerSection;
  accept: BatteryTestAccept;
}

export interface BatteryTestReportPayload {
  viewer: ViewerSection;
  report: BatteryTestReport;
}

export interface BatteryTestAbortPayload {
  viewer: ViewerSection;
  abort: BatteryTestAbort;
}

export interface ViewerErrorPayload {
  viewer: ViewerSection;
  error: { code: string; message: string };
}

export interface GaugeBand {
  level: "critical" | "warning" | "good";
  from: number;
  to: number;
  label: string;
}

/** Medição complementar exibida junto do gauge (ex.: tensão da bateria). */
export interface GaugeSecondarySource {
  label: string;
  path: string;
  unit: string;
  decimals: number;
}

/**
 * Origem de um valor no payload de telemetria — **um caminho por protocolo**.
 * A lista de `sources` é a ordem de preferência: o primeiro caminho presente vence.
 */
export interface GaugeSource {
  /** Caminho exato no payload de telemetria (nomes do contrato, sem renomear). */
  path: string;
  /** Rótulo exibido quando este caminho é usado (padrão: rótulo do gauge). */
  label?: string;
  /** Selo de origem ("estimativa", "informada pelo equipamento", ...). */
  origin_note?: string;
  secondary?: GaugeSecondarySource;
}

export interface GaugeDefinition {
  id: string;
  label: string;
  unit: string;
  /** Caminhos no payload de telemetria, em ordem de preferência. */
  sources: GaugeSource[];
  scale: { min: number; max: number; ticks: number[] };
  bands: GaugeBand[];
  decimals: number;
  order: number;
}

export interface ViewerConfigPayload {
  viewer: {
    name: string;
    version: string;
    read_only: true;
    refresh_interval_ms: number;
  };
  upstream: { base_url: string };
  device_id: string | null;
  gauges: GaugeDefinition[];
  threshold_problems: string[];
}
