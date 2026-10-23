/**
 * Modelo (puro) do teste de bateria do contrato 3.0.
 *
 * O contrato publica DOIS tipos de teste: `duration_10s` (janela fixa, em todos
 * os protocolos com teste) e `discharge_20pct` (sem janela: roda até a carga cair
 * ao alvo de 20 % ou até o teto de segurança de 30 min, só onde o equipamento
 * sabe cancelar). O seletor da interface é restrito a `test_types`.
 *
 * Regra de ouro: a API entrega os FATOS (série, agregações e a extrapolação
 * linear de 1ª ordem marcada `confidence: "low"`); o Web Viewer apenas
 * APRESENTA. Nenhum número é inventado aqui — quando `estimate.available` é
 * falso, o painel mostra o `reason` informado pela API, nunca uma autonomia.
 *
 * Os gráficos são desenhados a partir de `samples[].normalized` (o espelho
 * padronizado entre protocolos): chave AUSENTE significa "série indisponível" e
 * NUNCA vira zero.
 *
 * Todas as funções são puras para serem testáveis sem DOM, conforme a regra
 * 40-testing-and-docker do projeto.
 */
import { formatAge, formatNumber, MISSING_TEXT } from "./format.js";
import type {
  BatteryTestCapabilities,
  BatteryTestEstimate,
  BatteryTestListItem,
  BatteryTestMetricDelta,
  BatteryTestReport,
  BatteryTestSample,
  BatteryTestTypeParams,
  DeviceCapabilities,
} from "./contract.js";

export type TestPhase = "running" | "completed" | "aborted" | "failed" | "unknown";

export function testPhase(status: string | null | undefined): TestPhase {
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "aborted") return "aborted";
  if (status === "failed") return "failed";
  return "unknown";
}

const STATUS_TEXT: Record<string, string> = {
  running: "Em andamento",
  aborting: "Cancelando",
  completed: "Concluído",
  aborted: "Cancelado",
  failed: "Falhou",
  accepted: "Aceito (na fila do coletor)",
};

export function describeTestStatus(status: string | null | undefined): string {
  if (!status) return MISSING_TEXT;
  return STATUS_TEXT[status] ?? status;
}

/**
 * Motivo do encerramento. Diferente de `duration_elapsed`, a janela foi
 * atípica (cancelada, bateria baixa, watchdog) e o relatório não deve ser
 * tratado como um teste normal.
 */
const FINISH_REASON_TEXT: Record<string, string> = {
  duration_elapsed: "Janela completa do teste",
  target_percent_reached: "Carga da bateria atingiu o alvo do teste",
  test_flag_cleared: "O equipamento encerrou a flag de teste antes do tempo",
  aborted: "Cancelado durante a execução",
  battery_low: "Interrompido: bateria baixa (flag LB)",
  watchdog: "Interrompido pelo teto de tempo do coletor",
  stopping: "Interrompido: o serviço foi encerrado",
  serial_error: "Interrompido por erro na porta serial",
};

export function describeFinishReason(reason: string | null | undefined): string {
  if (!reason) return MISSING_TEXT;
  return FINISH_REASON_TEXT[reason] ?? reason;
}

/**
 * Mensagens de apoio para os códigos de erro do teste (§11.4 da doc de
 * integração). A API já devolve `message` em português pronto para exibir; este
 * mapa é apenas o fallback quando o envelope vier sem mensagem.
 */
const TEST_ERROR_TEXT: Record<string, string> = {
  test_disabled: "Teste de bateria não habilitado neste equipamento.",
  test_cooldown: "Aguarde alguns minutos entre testes (cooldown).",
  battery_too_low: "Carga da bateria abaixo do mínimo seguro para teste.",
  battery_at_target: "A carga da bateria já está no alvo deste teste.",
  on_battery: "O nobreak já está na bateria — teste não permitido.",
  battery_low: "Bateria baixa (flag LB) — teste não permitido.",
  test_in_progress: "Já existe um teste em andamento neste equipamento.",
  test_unavailable: "Sem telemetria fresca — verifique a comunicação do equipamento.",
  test_not_running: "Este teste já terminou.",
  unsupported_test_type: "Tipo de teste indisponível neste equipamento.",
  test_not_supported: "Este equipamento não suporta o teste de bateria.",
  test_requires_battery_percent:
    "Este tipo de teste exige que o equipamento informe o percentual da bateria.",
  device_not_found: "Equipamento não encontrado na API de telemetria.",
  test_not_found: "Teste não encontrado na API de telemetria.",
  invalid_request: "Requisição de teste malformada.",
};

export function describeTestError(
  error: { code: string; message: string } | null | undefined,
): string {
  if (!error) return MISSING_TEXT;
  const known = TEST_ERROR_TEXT[error.code];
  const message = error.message?.trim() ?? "";
  if (known) return message === "" || message === known ? known : message;
  return message === "" ? `Falha no teste (${error.code}).` : message;
}

// --------------------------------------------------------------- capacidades ---

export interface BatteryTestSupport {
  /** A API declarou o teste como suportado. */
  supported: boolean;
  /** `enabled` decide se o botão pode ser acionado (contrato §11.1). */
  enabled: boolean;
  abortSupported: boolean;
  durationS: number | null;
  sampleIntervalS: number | null;
  cooldownS: number | null;
  minBatteryPercent: number | null;
  /** Tipos aceitos por ESTE equipamento — o seletor nunca oferece outro. */
  testTypes: string[];
  /** Parâmetros por tipo (`types.<type>`): janela × alvo. */
  types: Record<string, BatteryTestTypeParams>;
}

/** Lê `capabilities.battery_test` do dispositivo descoberto em `GET /api/v1/ups`. */
export function readTestSupport(
  capabilities: DeviceCapabilities | undefined | null,
): BatteryTestSupport {
  const raw: BatteryTestCapabilities = capabilities?.battery_test ?? {};
  return {
    supported: raw.supported === true,
    enabled: raw.enabled === true,
    abortSupported: raw.abort_supported === true,
    durationS: raw.duration_s ?? null,
    sampleIntervalS: raw.sample_interval_s ?? null,
    cooldownS: raw.cooldown_s ?? null,
    minBatteryPercent: raw.min_battery_percent ?? null,
    testTypes: raw.test_types ?? [],
    types: raw.types ?? {},
  };
}

/** Avisos mostrados ANTES do clique, para evitar os 409 de guarda. */
export function buildTestGuards(support: BatteryTestSupport): string[] {
  const guards: string[] = [];
  if (support.cooldownS !== null && support.cooldownS > 0) {
    guards.push(`Espera de ${formatAge(support.cooldownS)} entre dois testes.`);
  }
  if (support.minBatteryPercent !== null) {
    guards.push(
      `Requer carga da bateria de pelo menos ${formatNumber(support.minBatteryPercent, 0)}%.`,
    );
  }
  if (!support.abortSupported) {
    guards.push("Este equipamento não cancela o teste: o cancelamento apenas para a amostragem.");
  }
  return guards;
}

// ---------------------------------------------------------- tipos de teste ---

/** Rótulos sugeridos pela doc do quadrante (§3.1), por `type` do contrato. */
const TEST_TYPE_LABEL: Record<string, string> = {
  duration_10s: "Teste rápido (~10 s)",
  discharge_20pct: "Descarga controlada (até 20 %)",
};

export interface TestTypeOption {
  type: string;
  label: string;
  /** Parâmetros publicados em `types.<type>`; `null` quando a API não os envia. */
  params: BatteryTestTypeParams | null;
  /** `true` no teste de descarga por alvo (sem janela). */
  isTarget: boolean;
}

export function describeTestType(type: string | null | undefined): string {
  if (!type) return MISSING_TEXT;
  return TEST_TYPE_LABEL[type] ?? type;
}

/**
 * Um teste é "por alvo" quando declara `target_percent` sem janela. Sem o
 * detalhe em `types`, o próprio nome do tipo decide — nunca inventamos
 * parâmetros que a API não publicou.
 */
function isTargetType(type: string, params: BatteryTestTypeParams | null): boolean {
  if (params?.target_percent != null) return true;
  if (params?.duration_s != null) return false;
  return type === "discharge_20pct";
}

/**
 * Opções do seletor: SOMENTE os tipos declarados em `test_types` — oferecer um
 * tipo fora da lista só produziria `422 unsupported_test_type` (ex.: o
 * `discharge_20pct` no `megatec-q1`).
 */
export function buildTestTypeOptions(support: BatteryTestSupport): TestTypeOption[] {
  return support.testTypes.map((type) => {
    const params = support.types[type] ?? null;
    return {
      type,
      label: TEST_TYPE_LABEL[type] ?? type,
      params,
      isTarget: isTargetType(type, params),
    };
  });
}

/**
 * Rótulo curto do teste escolhido: "Janela de 10,0 s" (teste de janela) ou
 * "Descarga até 20 %" (teste por alvo). Sem `types`, cai no nome do tipo.
 */
export function describeTestTypeParams(option: TestTypeOption | null): string {
  if (!option) return MISSING_TEXT;
  if (option.isTarget) {
    const target = option.params?.target_percent;
    return target == null ? "Descarga até o alvo" : `Descarga até ${formatNumber(target, 0)}%`;
  }
  const duration = option.params?.duration_s;
  return duration == null ? "Janela fixa" : `Janela de ${formatNumber(duration, 1)} s`;
}

// ----------------------------------------------------------------- estimativa ---

export interface EstimateView {
  available: boolean;
  /** "2 min 12 s", "≥ 10 h (extrapolação)" ou o traço quando indisponível. */
  runtimeText: string;
  /** Observação curta sobre como o número foi obtido. */
  note: string;
  dischargeRateText: string;
  dropText: string;
}

/**
 * Traduz `estimate`. Quando `available` é falso, só o `reason` é exibido — a
 * interface nunca converte a ausência em número.
 */
export function buildEstimateView(estimate: BatteryTestEstimate | null | undefined): EstimateView {
  if (!estimate) {
    return {
      available: false,
      runtimeText: MISSING_TEXT,
      note: "Sem estimativa nesta leitura.",
      dischargeRateText: MISSING_TEXT,
      dropText: MISSING_TEXT,
    };
  }

  const rate = estimate.discharge_rate_pp_per_min;
  const drop = estimate.drop_percent_in_window;
  const windowS = estimate.window_s;

  const dischargeRateText =
    rate == null ? MISSING_TEXT : `${formatNumber(rate, 1)} p.p./min`;
  const dropText =
    drop == null
      ? MISSING_TEXT
      : `${formatNumber(drop, 1)} p.p.${windowS == null ? "" : ` em ${formatNumber(windowS, 1)} s`}`;

  if (!estimate.available) {
    return {
      available: false,
      runtimeText: MISSING_TEXT,
      note: estimate.reason ? `Sem autonomia estimada: ${estimate.reason}` : "Autonomia não estimada.",
      dischargeRateText,
      dropText,
    };
  }

  const runtime = estimate.estimated_runtime_min ?? null;
  if (runtime === null) {
    return {
      available: false,
      runtimeText: MISSING_TEXT,
      note: "A API marcou a estimativa como disponível, mas não publicou a autonomia.",
      dischargeRateText,
      dropText,
    };
  }

  // `estimated_runtime_min` é limitado a `capped_at_min` (teto de sanidade):
  // quando empata com o teto, o valor é um piso, não uma precisão.
  const capped = estimate.capped_at_min ?? null;
  const reachedCap = capped !== null && runtime >= capped;
  const runtimeText = reachedCap
    ? `≥ ${formatAge(capped * 60)} (extrapolação)`
    : formatAge(runtime * 60);

  const confidence = estimate.confidence ?? "low";
  const parts = ["Extrapolação linear de 1ª ordem"];
  if (estimate.method) parts.push(estimate.method);
  parts.push(`confiança ${confidence}`);

  return {
    available: true,
    runtimeText,
    note: `${parts.join(" · ")}. Estimativa, não medição.`,
    dischargeRateText,
    dropText,
  };
}

// ------------------------------------------------------------------ gráficos ---

export interface ChartPoint {
  /** `offset_s` — eixo X, em segundos desde o início da janela. */
  x: number;
  /** Valor da métrica normalizada — eixo Y. */
  y: number;
}

/** Como resumir a oscilação da métrica no bloco lateral. */
type ChartSummaryKind = "oscillation" | "variation" | "drop";

interface ChartDefinition {
  /** Chave em `samples[].normalized` (também o id do bloco selecionável). */
  key: string;
  label: string;
  unit: string;
  decimals: number;
  summary: ChartSummaryKind;
}

/**
 * Os QUATRO gráficos do quadrante: tensão de saída, frequência, temperatura
 * interna e carga da bateria. A ordem é a da barra lateral de seleção.
 */
const CHART_DEFINITIONS: ChartDefinition[] = [
  { key: "output_voltage_v", label: "Tensão de saída", unit: "V", decimals: 1, summary: "oscillation" },
  { key: "frequency_hz", label: "Frequência", unit: "Hz", decimals: 1, summary: "oscillation" },
  { key: "temperature_c", label: "Temperatura interna", unit: "°C", decimals: 1, summary: "variation" },
  { key: "battery_charge_percent", label: "Carga da bateria", unit: "%", decimals: 1, summary: "drop" },
];

export interface TestChartModel {
  key: string;
  label: string;
  unit: string;
  decimals: number;
  points: ChartPoint[];
  /** `false` quando a chave nunca apareceu: série indisponível, NUNCA zero. */
  available: boolean;
  /** Oscilação resumida na barra lateral (vem de `deltas.metrics`). */
  variationText: string;
  /** Linha de referência tracejada (o alvo de carga no teste de descarga). */
  reference: number | null;
  referenceLabel: string | null;
}

/** Pontos de UMA métrica: chave ausente/nula é IGNORADA (nunca vira 0). */
export function buildChartPoints(
  samples: BatteryTestSample[] | null | undefined,
  key: string,
): ChartPoint[] {
  const points: ChartPoint[] = [];
  for (const sample of samples ?? []) {
    const x = sample.offset_s;
    const y = sample.normalized?.[key];
    if (typeof x !== "number" || !Number.isFinite(x)) continue;
    if (typeof y !== "number" || !Number.isFinite(y)) continue;
    points.push({ x, y });
  }
  return points;
}

function buildVariationText(
  definition: ChartDefinition,
  metric: BatteryTestMetricDelta | null,
): string {
  if (!metric) return MISSING_TEXT;
  if (definition.summary === "oscillation") {
    const ripple = metric.ripple;
    if (ripple == null) return MISSING_TEXT;
    return `Oscilação ${formatNumber(ripple, definition.decimals)} ${definition.unit}`;
  }
  const delta = metric.delta;
  if (delta == null) return MISSING_TEXT;
  const signed = `${delta > 0 ? "+" : ""}${formatNumber(delta, definition.decimals)}`;
  return definition.summary === "drop"
    ? `Queda ${signed} p.p.`
    : `Variação ${signed} ${definition.unit}`;
}

/**
 * Modelos da barra lateral e do gráfico, montados a partir de
 * `samples[].normalized` (contrato §5) e do resumo em `deltas.metrics`.
 */
export function buildTestChartModels(
  report: Pick<BatteryTestReport, "samples" | "deltas" | "target_percent"> | null | undefined,
): TestChartModel[] {
  const samples = report?.samples ?? [];
  const metrics = report?.deltas?.metrics ?? {};
  const target = report?.target_percent ?? null;

  return CHART_DEFINITIONS.map((definition) => {
    const points = buildChartPoints(samples, definition.key);
    const reference = definition.key === "battery_charge_percent" ? target : null;
    return {
      key: definition.key,
      label: definition.label,
      unit: definition.unit,
      decimals: definition.decimals,
      points,
      available: points.length > 0,
      variationText: buildVariationText(definition, metrics[definition.key] ?? null),
      reference,
      referenceLabel: reference == null ? null : `alvo ${formatNumber(reference, 0)}%`,
    };
  });
}

// ------------------------- geometria do gráfico (SVG próprio, sem biblioteca) ---

export interface ChartTick {
  /** Posição no sistema de coordenadas do SVG (px). */
  pos: number;
  text: string;
}

export interface LineChartGeometry {
  width: number;
  height: number;
  /** Traçado `M`/`L` da série, já projetado no SVG. */
  path: string;
  yTicks: ChartTick[];
  xTicks: ChartTick[];
  /** Posição Y da linha de referência, quando houver. */
  referencePos: number | null;
  /** Limites horizontais da área de plotagem (para grade e linha de referência). */
  plotLeft: number;
  plotRight: number;
}

const CHART_PADDING = { top: 10, right: 12, bottom: 20, left: 42 };

/**
 * Eixo X: `offset_s` em segundos. O formato vale para o eixo inteiro — misturar
 * "0,0 s" com "4:06" no mesmo gráfico confunde —, então `clock` decide o modo:
 * `m:ss` quando a janela tem 60 s ou mais (o `discharge_20pct` dura minutos) e
 * `s.S` no teste curto de 10 s (doc do contrato §4.3).
 */
export function formatOffsetSeconds(seconds: number, clock = false): string {
  if (!Number.isFinite(seconds)) return MISSING_TEXT;
  if (!clock) return `${formatNumber(seconds, 1)} s`;
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Projeta a série para o SVG. O eixo Y usa FOLGA proporcional: as oscilações de
 * tensão e frequência são pequenas (±2 V, ±0,5 Hz) e uma escala fixa de 0–250 V
 * as esconderia (doc do contrato §6). Devolve `null` quando não há pontos.
 */
export function buildLineChart(
  points: ChartPoint[],
  options: { width: number; height: number; decimals: number; reference?: number | null },
): LineChartGeometry | null {
  if (points.length === 0) return null;

  const { width, height, decimals } = options;
  const innerW = width - CHART_PADDING.left - CHART_PADDING.right;
  const innerH = height - CHART_PADDING.top - CHART_PADDING.bottom;

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const reference = options.reference;
  if (reference != null && Number.isFinite(reference)) ys.push(reference);

  const minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  if (maxX - minX < 1e-9) maxX = minX + 1;

  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  const span = maxY - minY;
  const padY = span > 0 ? span * 0.15 : Math.max(Math.abs(maxY) * 0.05, 1);
  minY -= padY;
  maxY += padY;

  const projectX = (x: number): number =>
    CHART_PADDING.left + ((x - minX) / (maxX - minX)) * innerW;
  const projectY = (y: number): number =>
    CHART_PADDING.top + innerH - ((y - minY) / (maxY - minY)) * innerH;

  const path = points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"} ${projectX(point.x).toFixed(1)} ${projectY(point.y).toFixed(1)}`,
    )
    .join(" ");

  const yTicks: ChartTick[] = [0, 1, 2, 3].map((step) => {
    const value = minY + ((maxY - minY) * step) / 3;
    return { pos: projectY(value), text: formatNumber(value, decimals) };
  });

  const xTicks: ChartTick[] = [0, 0.5, 1].map((ratio) => {
    const value = minX + (maxX - minX) * ratio;
    return { pos: projectX(value), text: formatOffsetSeconds(value, maxX - minX >= 60) };
  });

  return {
    width,
    height,
    path,
    yTicks,
    xTicks,
    referencePos: reference != null && Number.isFinite(reference) ? projectY(reference) : null,
    plotLeft: CHART_PADDING.left,
    plotRight: width - CHART_PADDING.right,
  };
}

// ------------------------------------------------ confirmação do estado de teste ---

export interface TestObservationView {
  /** `true`/`false` quando a API concluiu; `null` enquanto o teste corre. */
  observed: boolean | null;
  level: "good" | "warning" | "unknown";
  text: string;
}

/**
 * Confirma se o nobreak REALMENTE reportou o estado "Teste em andamento"
 * (`TEST` em `flags_seen`) durante a janela. É a prova de que o teste ocorreu.
 */
export function buildObservationView(
  report: Pick<BatteryTestReport, "status" | "test_flag_observed" | "flags_seen"> | null,
): TestObservationView {
  if (!report || report.status === "running") {
    return {
      observed: null,
      level: "unknown",
      text: "Verificando se o equipamento reportou o estado de teste…",
    };
  }
  const seen = report.flags_seen ?? [];
  const sawTestFlag = seen.includes("TEST");
  const observed = report.test_flag_observed === true;

  if (observed) {
    return {
      observed: true,
      level: "good",
      text: "O equipamento reportou a flag TEST durante o teste.",
    };
  }
  if (sawTestFlag) {
    return {
      observed: false,
      level: "warning",
      text: "A flag TEST apareceu nas amostras, mas a API não a confirmou nesta janela.",
    };
  }
  return {
    observed: false,
    level: "warning",
    text: "O equipamento NÃO reportou o estado de teste nesta janela — confirme o resultado.",
  };
}

// ------------------------------------------------------------------- progresso ---

/** Entrada comum ao aceite (`202`) e ao relatório — só o que é publicado. */
export interface TestProgressInput {
  status: string;
  type?: string | null;
  started_at_utc?: string | null;
  expected_end_at_utc?: string | null;
  requested_duration_s?: number | null;
  target_percent?: number | null;
  baseline?: Record<string, number | null> | null;
  final?: Record<string, number | null> | null;
  samples?: BatteryTestSample[] | null;
}

export interface TestProgressView {
  /** `window` = janela fixa; `target` = descarga até o alvo. */
  mode: "window" | "target";
  /** Fração 0..1; `null` quando não há dado suficiente (barra indeterminada). */
  fraction: number | null;
  text: string;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Carga atual: o `final` do relatório ou a última amostra com a chave. */
function currentChargePercent(report: TestProgressInput): number | null {
  const finalValue = report.final?.["battery_charge_percent"];
  if (typeof finalValue === "number" && Number.isFinite(finalValue)) return finalValue;
  const samples = report.samples ?? [];
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const value = samples[index]?.normalized?.["battery_charge_percent"];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function windowSecondsFromExpected(report: TestProgressInput): number | null {
  if (!report.started_at_utc || !report.expected_end_at_utc) return null;
  const start = Date.parse(report.started_at_utc);
  const end = Date.parse(report.expected_end_at_utc);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return (end - start) / 1000;
}

/**
 * Progresso do teste em execução.
 *
 * No teste de JANELA a fração é o tempo decorrido sobre a janela pedida. No teste
 * por ALVO (`discharge_20pct`) o progresso é a CARGA que caiu em direção ao alvo —
 * nunca os 30 min de `expected_end_at_utc`, que são apenas o teto de segurança.
 */
export function buildTestProgress(
  report: TestProgressInput | null,
  nowMs: number,
): TestProgressView | null {
  if (!report || report.status !== "running") return null;

  const target = report.target_percent;
  if (target != null) {
    const label = `Descarregando até ${formatNumber(target, 0)}%`;
    const startCharge = report.baseline?.["battery_charge_percent"] ?? null;
    const currentCharge = currentChargePercent(report);
    if (startCharge == null || currentCharge == null || startCharge <= target) {
      return {
        mode: "target",
        fraction: null,
        text:
          currentCharge == null
            ? `${label} (aguardando a primeira amostra)`
            : `${label} · atual: ${formatNumber(currentCharge, 0)}%`,
      };
    }
    return {
      mode: "target",
      fraction: clamp01((startCharge - currentCharge) / (startCharge - target)),
      text: `${label} · atual: ${formatNumber(currentCharge, 0)}%`,
    };
  }

  const windowSeconds = report.requested_duration_s ?? windowSecondsFromExpected(report);
  if (windowSeconds == null || windowSeconds <= 0 || !report.started_at_utc) return null;
  const start = Date.parse(report.started_at_utc);
  if (!Number.isFinite(start)) return null;

  const elapsed = Math.max(0, (nowMs - start) / 1000);
  return {
    mode: "window",
    fraction: clamp01(elapsed / windowSeconds),
    text: `${formatNumber(elapsed, 1)} s de ${formatNumber(windowSeconds, 1)} s`,
  };
}

// -------------------------------------------------------------------- histórico ---

export interface HistoryRowView {
  testId: string;
  startedText: string;
  /** Rótulo do tipo do teste (janela × descarga por alvo). */
  typeText: string;
  statusText: string;
  finishText: string;
  runtimeText: string;
  confidence: string;
  observedTestFlag: boolean;
}

/**
 * Histórico recente (`GET .../tests`) — só os fatos publicados pela API. O
 * histórico é em memória e se perde quando o serviço reinicia.
 */
export function buildHistoryRows(
  tests: BatteryTestListItem[] | null | undefined,
  formatDate: (iso: string | null | undefined) => string,
): HistoryRowView[] {
  if (!tests) return [];
  return tests.map((item) => {
    const estimate = item.estimate ?? null;
    const runtime =
      estimate && estimate.available && estimate.estimated_runtime_min != null
        ? formatAge(estimate.estimated_runtime_min * 60)
        : estimate?.reason
          ? `sem estimativa (${estimate.reason})`
          : MISSING_TEXT;
    return {
      testId: item.test_id,
      startedText: formatDate(item.started_at_utc ?? null),
      typeText: describeTestType(item.type ?? null),
      statusText: describeTestStatus(item.status),
      finishText: describeFinishReason(item.finish_reason ?? null),
      runtimeText: runtime,
      confidence: estimate?.confidence ?? MISSING_TEXT,
      observedTestFlag: (item.flags_seen ?? []).includes("TEST"),
    };
  });
}
