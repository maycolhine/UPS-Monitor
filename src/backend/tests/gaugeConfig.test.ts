import { describe, expect, it } from "vitest";

import { applyGaugeOverrides, GAUGE_DEFINITIONS, readMetricValue } from "../src/gaugeConfig.js";

describe("applyGaugeOverrides", () => {
  it("sem sobrescrita, mantém as faixas provisórias padrão e a ordem definida", () => {
    const { gauges, problems } = applyGaugeOverrides(undefined);
    expect(problems).toEqual([]);
    expect(gauges.map((gauge) => gauge.id)).toEqual([
      "input_voltage_v",
      "output_voltage_v",
      "input_frequency_hz",
      "temperature_c",
      "battery_charge_percent",
      "load_percent",
    ]);
  });

  it("as faixas padrão cobrem toda a escala sem sobreposição", () => {
    for (const gauge of GAUGE_DEFINITIONS) {
      expect(gauge.bands[0]?.from).toBe(gauge.scale.min);
      expect(gauge.bands[gauge.bands.length - 1]?.to).toBe(gauge.scale.max);
      gauge.bands.forEach((band, index) => {
        expect(band.from).toBeLessThan(band.to);
        if (index > 0) {
          expect(gauge.bands[index - 1]!.to).toBe(band.from);
        }
      });
    }
  });

  it("a frequência nominal de 60 Hz fica em uma faixa 'good'", () => {
    const frequency = GAUGE_DEFINITIONS.find((gauge) => gauge.id === "input_frequency_hz");
    // O valor no limite pertence à faixa que termina nele (ver metrics.evaluateBand).
    const band = frequency?.bands.find((item) => 60 >= item.from && 60 <= item.to);
    expect(band?.level).toBe("good");
    expect(band?.label).toContain("normal");
  });

  it("declara as origens da carga da bateria por protocolo, com o selo de origem", () => {
    const battery = GAUGE_DEFINITIONS.find((gauge) => gauge.id === "battery_charge_percent");
    // megatec-q1: percentual estimado + tensão medida como medição secundária.
    expect(battery?.sources[0]?.path).toBe("data.battery_charge.percent");
    expect(battery?.sources[0]?.origin_note).toBe("estimativa");
    expect(battery?.sources[0]?.secondary?.path).toBe("data.measurements.battery_voltage_v");
    // sms-1phase: percentual informado pelo equipamento (não é estimativa).
    expect(battery?.sources[1]?.path).toBe("data.battery.charge_percent");
    expect(battery?.sources[1]?.origin_note).toBe("informada pelo equipamento");
    expect(battery?.sources[1]?.secondary?.path).toBe("data.battery.voltage_v");
  });

  it("declara as origens da frequência (entrada no Q1, saída no SMS)", () => {
    const frequency = GAUGE_DEFINITIONS.find((gauge) => gauge.id === "input_frequency_hz");
    expect(frequency?.sources[0]?.path).toBe("data.measurements.input_frequency_hz");
    expect(frequency?.sources[1]?.path).toBe("data.measurements.output_frequency_hz");
    expect(frequency?.sources[1]?.label).toBe("Frequência de saída");
  });

  it("aplica sobrescrita válida de escala e faixas", () => {
    const override = JSON.stringify({
      output_voltage_v: {
        scale: { min: 0, max: 300, ticks: [0, 150, 300] },
        bands: [
          { level: "critical", from: 0, to: 198, label: "Fora da faixa" },
          { level: "good", from: 198, to: 242, label: "Faixa esperada (220 V)" },
          { level: "critical", from: 242, to: 300, label: "Fora da faixa" },
        ],
      },
    });

    const { gauges, problems } = applyGaugeOverrides(override);
    expect(problems).toEqual([]);
    const output = gauges.find((gauge) => gauge.id === "output_voltage_v");
    expect(output?.scale.max).toBe(300);
    expect(output?.bands).toHaveLength(3);
    expect(output?.bands[1]?.label).toBe("Faixa esperada (220 V)");
  });

  it("JSON inválido gera problema e mantém o padrão", () => {
    const { gauges, problems } = applyGaugeOverrides("{isso nao e json}");
    expect(problems.length).toBeGreaterThan(0);
    expect(gauges.find((gauge) => gauge.id === "output_voltage_v")?.bands).toHaveLength(5);
  });

  it("métrica desconhecida é reportada e não altera nada", () => {
    const { problems } = applyGaugeOverrides(JSON.stringify({ tensao_magica_v: { scale: { min: 0, max: 1 } } }));
    expect(problems.join(" ")).toContain("tensao_magica_v");
  });

  it("faixa fora da escala ou desordenada é recusada", () => {
    const outOfScale = applyGaugeOverrides(
      JSON.stringify({ load_percent: { bands: [{ level: "good", from: 0, to: 150, label: "x" }] } }),
    );
    expect(outOfScale.problems.join(" ")).toContain("fora da escala");
    expect(outOfScale.gauges.find((gauge) => gauge.id === "load_percent")?.bands).toHaveLength(3);

    const unordered = applyGaugeOverrides(
      JSON.stringify({
        load_percent: {
          bands: [
            { level: "good", from: 50, to: 100, label: "b" },
            { level: "critical", from: 0, to: 50, label: "a" },
          ],
        },
      }),
    );
    expect(unordered.problems.join(" ")).toContain("ordem crescente");
  });
});

describe("readMetricValue", () => {
  const payload = {
    data: {
      measurements: { input_voltage_v: 219, temperature_c: null },
      battery_charge: { percent: 100 },
    },
  };

  it("lê o valor pelo caminho exato do contrato", () => {
    expect(readMetricValue(payload, "data.measurements.input_voltage_v")).toBe(219);
    expect(readMetricValue(payload, "data.battery_charge.percent")).toBe(100);
  });

  it("distingue null (sem dado) de ausente", () => {
    expect(readMetricValue(payload, "data.measurements.temperature_c")).toBeNull();
    expect(readMetricValue(payload, "data.measurements.output_voltage_v")).toBeUndefined();
  });

  it("devolve undefined quando não há payload (sem dados)", () => {
    expect(readMetricValue(null, "data.measurements.input_voltage_v")).toBeUndefined();
  });
});
