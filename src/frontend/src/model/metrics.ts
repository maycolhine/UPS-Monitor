/**
 * Geometria dos gauges semicirculares e avaliação das faixas semânticas.
 * Tudo aqui é função pura (testável sem navegador).
 *
 * Semântica: vermelho = ruim/crítico, âmbar = atenção, verde = normal.
 * A cor nunca é o único sinal: cada faixa carrega um rótulo textual.
 */
import type { GaugeBand, GaugeDefinition, GaugeSource } from "./contract.js";
import { formatNumber } from "./format.js";

export type MetricLevel = "good" | "warning" | "critical" | "unknown";

export const LEVEL_LABEL: Record<MetricLevel, string> = {
  good: "Normal",
  warning: "Atenção",
  critical: "Crítico",
  unknown: "Sem dados",
};

export interface BandEvaluation {
  level: MetricLevel;
  /** Rótulo textual da faixa (não depende de cor para comunicar o estado). */
  text: string;
  band: GaugeBand | null;
}

/**
 * Localiza a faixa que contém o valor.
 *
 * Convenção dos limites: o valor exatamente igual a um limite pertence à faixa
 * que TERMINA nesse limite — é assim que as faixas são descritas ao usuário
 * ("verde entre 57 e 60", "verde entre 0 e 50"). Assim um valor nominal como
 * 60,0 Hz ou 127,0 V é classificado como normal, e não como atenção.
 */
export function evaluateBand(value: number | null | undefined, bands: GaugeBand[]): BandEvaluation {
  if (value === null || value === undefined || !Number.isFinite(value) || bands.length === 0) {
    return { level: "unknown", text: "Sem dados", band: null };
  }
  for (const band of bands) {
    if (value >= band.from && value <= band.to) {
      return { level: band.level, text: band.label, band };
    }
  }
  return { level: "unknown", text: "Fora da escala exibida", band: null };
}

/**
 * Limites das faixas (início e fim de cada faixa), em ordem crescente e sem
 * repetições. É o que o gauge marca na escala, em vez de marcações fixas:
 * mostra onde cada faixa começa e termina (escopo §4.2 — a cor nunca é o único
 * sinal; o usuário precisa conseguir ler os limites).
 */
export function bandBoundaries(bands: GaugeBand[]): number[] {
  const values = new Set<number>();
  for (const band of bands) {
    values.add(band.from);
    values.add(band.to);
  }
  return [...values].sort((a, b) => a - b);
}

/** Fração de 0 a 1 do valor dentro da escala. */
export function valueFraction(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  const fraction = (value - min) / (max - min);
  return Math.min(1, Math.max(0, fraction));
}

/** Ângulo em graus: 180° na extremidade esquerda, 0° na direita. */
export function valueAngle(value: number, min: number, max: number): number {
  return 180 - 180 * valueFraction(value, min, max);
}

export interface Point {
  x: number;
  y: number;
}

export function polarPoint(cx: number, cy: number, radius: number, angleDeg: number): Point {
  const radians = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy - radius * Math.sin(radians),
  };
}

export interface ArcGeometry {
  cx: number;
  cy: number;
  radius: number;
  strokeWidth: number;
}

/** Caminho SVG para um arco entre dois valores da escala. */
export function arcPath(
  from: number,
  to: number,
  scale: { min: number; max: number },
  geometry: ArcGeometry,
): string {
  const startAngle = valueAngle(from, scale.min, scale.max);
  const endAngle = valueAngle(to, scale.min, scale.max);
  const start = polarPoint(geometry.cx, geometry.cy, geometry.radius, startAngle);
  const end = polarPoint(geometry.cx, geometry.cy, geometry.radius, endAngle);
  const sweep = startAngle > endAngle ? 1 : 0;
  const largeArc = Math.abs(startAngle - endAngle) > 180 ? 1 : 0;
  return `M ${round(start.x)} ${round(start.y)} A ${geometry.radius} ${geometry.radius} 0 ${largeArc} ${sweep} ${round(end.x)} ${round(end.y)}`;
}

/** Geometria do ponteiro na posição do valor. */
export function needlePoint(
  value: number,
  scale: { min: number; max: number },
  geometry: ArcGeometry,
  length: number,
): Point {
  return polarPoint(geometry.cx, geometry.cy, length, valueAngle(value, scale.min, scale.max));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface GaugeGeometry {
  width: number;
  height: number;
  center: Point;
  radius: number;
  strokeWidth: number;
  needleLength: number;
}

/** Geometria padrão do semicírculo (mesma para todos os gauges). */
export const GAUGE_GEOMETRY: GaugeGeometry = {
  width: 220,
  height: 132,
  center: { x: 110, y: 110 },
  radius: 84,
  strokeWidth: 18,
  needleLength: 66,
};

export interface GaugeRenderModel {
  definition: GaugeDefinition;
  /** Origem efetivamente usada (define rótulo e selo exibidos). */
  source: GaugeSource | null;
  /** Rótulo da métrica na origem usada (padrão: o da definição). */
  label: string;
  value: number | null;
  hasValue: boolean;
  displayValue: string;
  level: MetricLevel;
  statusText: string;
  /** true quando o valor é exibido, mas fora de validade (leitura desatualizada). */
  stale: boolean;
  /** Texto de ausência: "Sem dados" ou "Desatualizado". */
  emptyText: string | null;
  ariaLabel: string;
}

export interface BuildGaugeModelInput {
  definition: GaugeDefinition;
  /** Valor já extraído do contrato (`null` = informado como nulo, `undefined` = ausente). */
  value: number | null | undefined;
  /** Telemetria da API marcada como desatualizada. */
  stale: boolean;
  /** Origem escolhida para este payload (ver `resolveGaugeSource`). */
  source?: GaugeSource | null;
}

/**
 * Monta o modelo visual de um gauge.
 *
 * Regras do escopo §6.2: valor ausente/inválido NUNCA vira zero. Quando não há
 * número utilizável, o gauge é neutralizado e recebe o texto "Sem dados".
 * Quando a leitura existe mas está desatualizada, o número é mostrado com o
 * rótulo "Desatualizado" — nunca como se fosse atual.
 */
export function buildGaugeRenderModel(input: BuildGaugeModelInput): GaugeRenderModel {
  const { definition, stale } = input;
  const source = input.source ?? null;
  const label = source?.label ?? definition.label;
  const usable = typeof input.value === "number" && Number.isFinite(input.value);

  if (!usable) {
    const emptyText = stale ? "Desatualizado" : "Sem dados";
    return {
      definition,
      source,
      label,
      value: null,
      hasValue: false,
      displayValue: "—",
      level: "unknown",
      statusText: emptyText,
      stale,
      emptyText,
      ariaLabel: `${label}: ${emptyText}`,
    };
  }

  const value = input.value as number;
  const bandEvaluation = evaluateBand(value, definition.bands);
  const displayValue = formatNumber(value, definition.decimals);
  const statusText = stale ? "Desatualizado" : bandEvaluation.text;

  return {
    definition,
    source,
    label,
    value,
    hasValue: true,
    displayValue,
    level: bandEvaluation.level,
    statusText,
    stale,
    emptyText: stale ? "Desatualizado" : null,
    ariaLabel: `${label}: ${displayValue} ${definition.unit} — ${statusText}`,
  };
}

/**
 * Lê um valor por um caminho do payload de telemetria (caminho exato do
 * contrato, sem renomear campos).
 *
 * Retorna:
 *  - `number`   → valor utilizável;
 *  - `null`     → o contrato informou `null` explicitamente;
 *  - `undefined`→ caminho ausente ou tipo inesperado (nunca tratado como zero).
 */
export function readMetricPath(payload: unknown, sourcePath: string): number | null | undefined {
  let current: unknown = payload;
  for (const segment of sourcePath.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) return undefined;
  if (current === null) return null;
  if (typeof current === "number" && Number.isFinite(current)) return current;
  return undefined;
}

export interface ResolvedGaugeSource {
  /** Origem efetivamente escolhida (define rótulo e selo exibidos). */
  source: GaugeSource | null;
  /** Valor lido no caminho dessa origem (`undefined` = ausente, `null` = nulo informado). */
  value: number | null | undefined;
}

/**
 * Escolhe a origem do gauge para o payload recebido.
 *
 * O mesmo dado aparece em campos diferentes conforme o PROTOCOLO do equipamento
 * (contrato 2.0 é multiprotocolo). Por isso a definição lista `sources` em ordem
 * de preferência e esta função devolve a PRIMEIRA cujo caminho esteja presente
 * no payload — seja número ou `null` explícito. Se nenhum caminho existir,
 * devolve a primeira origem como referência (o valor fica ausente e o gauge
 * exibe "Sem dados", nunca zero).
 */
export function resolveGaugeSource(
  definition: GaugeDefinition,
  payload: unknown,
): ResolvedGaugeSource {
  const sources = definition.sources ?? [];
  for (const source of sources) {
    const value = readMetricPath(payload, source.path);
    if (value !== undefined) {
      return { source, value };
    }
  }
  return { source: sources[0] ?? null, value: undefined };
}
