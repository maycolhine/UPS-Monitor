/**
 * Definição das métricas exibidas nos gauges semicirculares.
 *
 * IMPORTANTE (escopo §4.2 e §6.1): as faixas vermelho/amarelo/verde abaixo foram
 * **validadas pelo solicitante** em 2026-10-21. Não são limites oficiais do
 * fabricante, mas passam a ser a referência adotada pela interface. Continuam em um
 * único lugar e podem ser substituídas por `VIEWER_GAUGE_THRESHOLDS` (JSON).
 *
 * Cada gauge declara um ou mais `sources`: caminhos EXATOS do JSON da API, relativos
 * ao payload de telemetria (`/api/v1/ups/{device_id}/telemetry`). Nenhum nome de campo
 * é alterado. Há mais de um caminho porque o mesmo dado aparece em campos diferentes
 * conforme o PROTOCOLO do equipamento — a API unificada é multidispositivo/multiprotocolo:
 *   - carga da bateria: `data.battery_charge.percent` (megatec-q1, estimativa) ou
 *     `data.battery.charge_percent` (sms-1phase, informada pelo equipamento);
 *   - frequência: `data.measurements.input_frequency_hz` (megatec-q1) ou
 *     `data.measurements.output_frequency_hz` (sms-1phase).
 * A ordem da lista é a ordem de preferência (o primeiro caminho presente no payload vence).
 */

export type BandLevel = "critical" | "warning" | "good";

export interface GaugeBand {
  level: BandLevel;
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

/** Origem de um valor no payload de telemetria (um caminho por protocolo). */
export interface GaugeSource {
  /** Caminho exato no payload de telemetria (nomes do contrato, sem renomear). */
  path: string;
  /** Rótulo da métrica quando este caminho é usado (padrão: o rótulo do gauge). */
  label?: string;
  /**
   * Selo de origem exibido no cartão. Só deve afirmar "estimativa" quando a API de
   * fato estima o valor (o SMS informa o percentual da bateria, então não é estimativa).
   */
  origin_note?: string;
  secondary?: GaugeSecondarySource;
}

export interface GaugeDefinition {
  /** Identificador estável da métrica (chave usada em VIEWER_GAUGE_THRESHOLDS). */
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

/**
 * Tensão CA: verde nas duas janelas de operação adotadas (127 V e 220 V nominais,
 * com tolerância), vermelho no restante da escala.
 */
const VOLTAGE_BANDS = [
  { level: "critical" as BandLevel, from: 0, to: 80, label: "Tensão fora da faixa (baixa)" },
  { level: "good" as BandLevel, from: 80, to: 127, label: "Dentro da faixa esperada (127 V)" },
  { level: "critical" as BandLevel, from: 127, to: 200, label: "Tensão fora da faixa (intermediária)" },
  { level: "good" as BandLevel, from: 200, to: 225, label: "Dentro da faixa esperada (220 V)" },
  { level: "critical" as BandLevel, from: 225, to: 250, label: "Tensão fora da faixa (alta)" },
];

const VOLTAGE_SCALE = { min: 0, max: 250, ticks: [0, 50, 100, 150, 200, 250] };

/** Copia as faixas de tensão para que cada métrica tenha a própria lista mutável. */
function voltageBands(): GaugeBand[] {
  return VOLTAGE_BANDS.map((band) => ({ ...band }));
}

export const GAUGE_DEFINITIONS: GaugeDefinition[] = [
  {
    id: "input_voltage_v",
    label: "Tensão de entrada",
    unit: "V",
    sources: [{ path: "data.measurements.input_voltage_v" }],
    scale: { ...VOLTAGE_SCALE, ticks: [...VOLTAGE_SCALE.ticks] },
    bands: voltageBands(),
    decimals: 0,
    order: 1,
  },
  {
    id: "output_voltage_v",
    label: "Tensão de saída",
    unit: "V",
    sources: [{ path: "data.measurements.output_voltage_v" }],
    scale: { ...VOLTAGE_SCALE, ticks: [...VOLTAGE_SCALE.ticks] },
    bands: voltageBands(),
    decimals: 0,
    order: 2,
  },
  {
    // O id permanece "input_frequency_hz" porque é a chave estável de configuração;
    // o rótulo muda conforme o protocolo publique entrada ou saída.
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
        // megatec-q1: percentual ESTIMADO por interpolação linear da tensão.
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
        // sms-1phase: percentual INFORMADO pelo equipamento (não é estimativa).
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

const LEVELS: BandLevel[] = ["critical", "warning", "good"];
const METRIC_IDS = GAUGE_DEFINITIONS.map((definition) => definition.id);

export interface GaugeConfigResult {
  gauges: GaugeDefinition[];
  problems: string[];
}

/**
 * Aplica uma sobrescrita parcial (JSON) sobre as faixas padrão.
 * O JSON inválido não é ignorado em silêncio: gera problemas e mantém o padrão.
 */
export function applyGaugeOverrides(rawJson: string | undefined): GaugeConfigResult {
  const gauges = GAUGE_DEFINITIONS.map((definition) => ({
    ...definition,
    sources: definition.sources.map((source) => ({
      ...source,
      ...(source.secondary ? { secondary: { ...source.secondary } } : {}),
    })),
    scale: { ...definition.scale, ticks: [...definition.scale.ticks] },
    bands: definition.bands.map((band) => ({ ...band })),
  }));
  const problems: string[] = [];
  if (!rawJson || rawJson.trim() === "") {
    return { gauges, problems };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    problems.push(`VIEWER_GAUGE_THRESHOLDS não é JSON válido: ${(error as Error).message}`);
    return { gauges, problems };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    problems.push("VIEWER_GAUGE_THRESHOLDS deve ser um objeto JSON");
    return { gauges, problems };
  }

  for (const [metricId, overrideRaw] of Object.entries(parsed as Record<string, unknown>)) {
    const target = gauges.find((definition) => definition.id === metricId);
    if (!target) {
      problems.push(
        `VIEWER_GAUGE_THRESHOLDS: métrica '${metricId}' desconhecida (disponíveis: ${METRIC_IDS.join(", ")})`,
      );
      continue;
    }
    if (typeof overrideRaw !== "object" || overrideRaw === null || Array.isArray(overrideRaw)) {
      problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'] deve ser um objeto`);
      continue;
    }
    const override = overrideRaw as Record<string, unknown>;

    const scaleRaw = override["scale"];
    if (scaleRaw !== undefined) {
      if (typeof scaleRaw !== "object" || scaleRaw === null) {
        problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'].scale deve ser um objeto`);
      } else {
        const scale = scaleRaw as Record<string, unknown>;
        const min = typeof scale["min"] === "number" ? scale["min"] : target.scale.min;
        const max = typeof scale["max"] === "number" ? scale["max"] : target.scale.max;
        if (!(min < max)) {
          problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'].scale inválida (min >= max)`);
        } else {
          target.scale.min = min;
          target.scale.max = max;
        }
        if (Array.isArray(scale["ticks"]) && scale["ticks"].every((tick) => typeof tick === "number")) {
          target.scale.ticks = scale["ticks"] as number[];
        } else if (scale["ticks"] !== undefined) {
          problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'].scale.ticks deve ser lista de números`);
        }
      }
    }

    const bandsRaw = override["bands"];
    if (bandsRaw !== undefined) {
      if (!Array.isArray(bandsRaw) || bandsRaw.length === 0) {
        problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'].bands deve ser uma lista não vazia`);
      } else {
        const bands: GaugeBand[] = [];
        let valid = true;
        bandsRaw.forEach((bandRaw, index) => {
          if (typeof bandRaw !== "object" || bandRaw === null) {
            problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'].bands[${index}] deve ser um objeto`);
            valid = false;
            return;
          }
          const band = bandRaw as Record<string, unknown>;
          const level = band["level"];
          const from = band["from"];
          const to = band["to"];
          const label = band["label"];
          if (!LEVELS.includes(level as BandLevel)) {
            problems.push(
              `VIEWER_GAUGE_THRESHOLDS['${metricId}'].bands[${index}].level deve ser critical|warning|good`,
            );
            valid = false;
            return;
          }
          if (typeof from !== "number" || typeof to !== "number" || !(from < to)) {
            problems.push(
              `VIEWER_GAUGE_THRESHOLDS['${metricId}'].bands[${index}] precisa de from/to numéricos com from < to`,
            );
            valid = false;
            return;
          }
          if (from < target.scale.min || to > target.scale.max) {
            problems.push(
              `VIEWER_GAUGE_THRESHOLDS['${metricId}'].bands[${index}] fora da escala (${target.scale.min}–${target.scale.max})`,
            );
            valid = false;
            return;
          }
          bands.push({
            level: level as BandLevel,
            from,
            to,
            label: typeof label === "string" && label !== "" ? label : target.label,
          });
        });
        const ordered = bands.every(
          (band, index) => index === 0 || (bands[index - 1] as GaugeBand).to <= band.from,
        );
        if (!ordered) {
          problems.push(`VIEWER_GAUGE_THRESHOLDS['${metricId}'].bands deve estar em ordem crescente e sem sobreposição`);
          valid = false;
        }
        if (valid) target.bands = bands;
      }
    }

    if (typeof override["label"] === "string" && override["label"] !== "") target.label = override["label"];
    if (typeof override["unit"] === "string" && override["unit"] !== "") target.unit = override["unit"];
    if (typeof override["decimals"] === "number" && Number.isInteger(override["decimals"]) && override["decimals"] >= 0) {
      target.decimals = override["decimals"];
    }
  }

  gauges.sort((a, b) => a.order - b.order);
  return { gauges, problems };
}

/** Lê um valor numérico por um caminho (`.`-separado) do payload de telemetria. */
export function readMetricValue(
  telemetryPayload: unknown,
  sourcePath: string,
): number | null | undefined {
  let current: unknown = telemetryPayload;
  for (const segment of sourcePath.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) return undefined;
  if (current === null) return null;
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}
