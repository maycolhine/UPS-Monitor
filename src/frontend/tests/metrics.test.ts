import { describe, expect, it } from "vitest";

import type { GaugeBand, GaugeDefinition } from "../src/model/contract.js";
import {
  GAUGE_GEOMETRY,
  arcPath,
  bandBoundaries,
  buildGaugeRenderModel,
  evaluateBand,
  readMetricPath,
  resolveGaugeSource,
  valueAngle,
  valueFraction,
} from "../src/model/metrics.js";

const definition: GaugeDefinition = {
  id: "input_voltage_v",
  label: "Tensão de entrada",
  unit: "V",
  sources: [{ path: "data.measurements.input_voltage_v" }],
  scale: { min: 0, max: 300, ticks: [0, 150, 300] },
  bands: [
    { level: "critical", from: 0, to: 100, label: "Fora da faixa" },
    { level: "good", from: 100, to: 200, label: "Normal" },
    { level: "critical", from: 200, to: 300, label: "Fora da faixa" },
  ],
  decimals: 0,
  order: 1,
};

describe("evaluateBand", () => {
  it("encontra a faixa que contém o valor", () => {
    expect(evaluateBand(150, definition.bands).level).toBe("good");
    expect(evaluateBand(150, definition.bands).text).toBe("Normal");
  });

  it("inverte para crítico acima do limite", () => {
    expect(evaluateBand(250, definition.bands).level).toBe("critical");
  });

  it("inclui o limite superior na última faixa", () => {
    expect(evaluateBand(300, definition.bands).level).toBe("critical");
  });

  it("retorna 'sem dados' para null/undefined/NaN", () => {
    expect(evaluateBand(null, definition.bands).level).toBe("unknown");
    expect(evaluateBand(undefined, definition.bands).level).toBe("unknown");
    expect(evaluateBand(Number.NaN, definition.bands).level).toBe("unknown");
  });
});

describe("limites das faixas", () => {
  // Mesmas faixas da frequência de entrada (60 Hz nominal deve ser normal).
  const bands: GaugeBand[] = [
    { level: "critical", from: 20, to: 42, label: "Frequência fora da faixa (baixa)" },
    { level: "warning", from: 42, to: 47, label: "Atenção: frequência baixa" },
    { level: "good", from: 47, to: 53, label: "Frequência normal (50 Hz)" },
    { level: "warning", from: 53, to: 57, label: "Atenção: frequência fora do ideal" },
    { level: "good", from: 57, to: 60, label: "Frequência normal (60 Hz)" },
    { level: "warning", from: 60, to: 63, label: "Atenção: frequência alta" },
    { level: "critical", from: 63, to: 70, label: "Frequência fora da faixa (alta)" },
  ];

  it("classifica 60,0 Hz como normal, e não como frequência alta", () => {
    expect(evaluateBand(60, bands).level).toBe("good");
    expect(evaluateBand(60, bands).text).toBe("Frequência normal (60 Hz)");
  });

  it("o valor exatamente no limite pertence à faixa que termina nele", () => {
    expect(evaluateBand(42, bands).level).toBe("critical");
    expect(evaluateBand(47, bands).level).toBe("warning");
    expect(evaluateBand(53, bands).level).toBe("good");
    expect(evaluateBand(57, bands).level).toBe("warning");
    expect(evaluateBand(63, bands).level).toBe("warning");
    expect(evaluateBand(70, bands).level).toBe("critical");
  });

  it("bandBoundaries devolve o início/fim de cada faixa, em ordem e sem repetição", () => {
    expect(bandBoundaries(bands)).toEqual([20, 42, 47, 53, 57, 60, 63, 70]);
  });
});

describe("escala", () => {
  it("valueFraction limita a fração entre 0 e 1", () => {
    expect(valueFraction(-10, 0, 100)).toBe(0);
    expect(valueFraction(50, 0, 100)).toBe(0.5);
    expect(valueFraction(500, 0, 100)).toBe(1);
  });

  it("valueAngle vai de 180° (mínimo) a 0° (máximo)", () => {
    expect(valueAngle(0, 0, 100)).toBe(180);
    expect(valueAngle(50, 0, 100)).toBe(90);
    expect(valueAngle(100, 0, 100)).toBe(0);
  });

  it("arcPath gera um caminho SVG válido, com raio igual ao da geometria", () => {
    const path = arcPath(0, 300, definition.scale, {
      cx: GAUGE_GEOMETRY.center.x,
      cy: GAUGE_GEOMETRY.center.y,
      radius: GAUGE_GEOMETRY.radius,
      strokeWidth: GAUGE_GEOMETRY.strokeWidth,
    });
    expect(path.startsWith("M ")).toBe(true);
    expect(path).toContain(`A ${GAUGE_GEOMETRY.radius} ${GAUGE_GEOMETRY.radius}`);
  });

  it("arcPath de um subintervalo não cruza o centro", () => {
    const [start] = arcPath(0, 300, definition.scale, {
      cx: 110,
      cy: 110,
      radius: 84,
      strokeWidth: 18,
    })
      .replace("M ", "")
      .split(" A ");
    expect(start).toBe("26 110");
  });
});

describe("buildGaugeRenderModel", () => {
  it("monta o modelo com valor válido", () => {
    const model = buildGaugeRenderModel({ definition, value: 150, stale: false });
    expect(model.hasValue).toBe(true);
    expect(model.displayValue).toBe("150");
    expect(model.level).toBe("good");
    expect(model.statusText).toBe("Normal");
    expect(model.ariaLabel).toContain("Tensão de entrada");
  });

  it("NÃO converte valor ausente em zero", () => {
    const missing = buildGaugeRenderModel({ definition, value: undefined, stale: false });
    expect(missing.hasValue).toBe(false);
    expect(missing.displayValue).toBe("—");
    expect(missing.emptyText).toBe("Sem dados");
    expect(missing.level).toBe("unknown");
  });

  it("trata null explícito como ausência, não como zero", () => {
    const nullValue = buildGaugeRenderModel({ definition, value: null, stale: false });
    expect(nullValue.hasValue).toBe(false);
    expect(nullValue.displayValue).toBe("—");
    expect(nullValue.statusText).toBe("Sem dados");
  });

  it("rejeita NaN como valor utilizável", () => {
    const invalid = buildGaugeRenderModel({ definition, value: Number.NaN, stale: false });
    expect(invalid.hasValue).toBe(false);
  });

  it("mostra o número, mas rotula como desatualizado, quando stale", () => {
    const model = buildGaugeRenderModel({ definition, value: 150, stale: true });
    expect(model.hasValue).toBe(true);
    expect(model.displayValue).toBe("150");
    expect(model.statusText).toBe("Desatualizado");
    expect(model.stale).toBe(true);
  });

  it("respeita o número de decimais da definição", () => {
    const model = buildGaugeRenderModel({
      definition: { ...definition, decimals: 1 },
      value: 60.25,
      stale: false,
    });
    expect(model.displayValue).toBe("60,3");
  });
});

describe("readMetricPath", () => {
  const payload = {
    data: {
      measurements: { input_voltage_v: 219, output_voltage_v: null },
      battery_charge: { percent: 100 },
    },
  };

  it("lê pelo caminho exato do contrato", () => {
    expect(readMetricPath(payload, "data.measurements.input_voltage_v")).toBe(219);
    expect(readMetricPath(payload, "data.battery_charge.percent")).toBe(100);
  });

  it("distingue null informado de caminho ausente", () => {
    expect(readMetricPath(payload, "data.measurements.output_voltage_v")).toBeNull();
    expect(readMetricPath(payload, "data.measurements.temperature_c")).toBeUndefined();
  });

  it("não converte strings numéricas em número", () => {
    expect(readMetricPath({ a: "10" }, "a")).toBeUndefined();
  });

  it("retorna undefined ao atravessar nó não-objeto", () => {
    expect(readMetricPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(readMetricPath(null, "a")).toBeUndefined();
  });
});

describe("resolveGaugeSource", () => {
  const frequency: GaugeDefinition = {
    id: "input_frequency_hz",
    label: "Frequência de entrada",
    unit: "Hz",
    sources: [
      { path: "data.measurements.input_frequency_hz" },
      { path: "data.measurements.output_frequency_hz", label: "Frequência de saída" },
    ],
    scale: { min: 20, max: 70, ticks: [20, 70] },
    bands: [{ level: "good", from: 20, to: 70, label: "Normal" }],
    decimals: 1,
    order: 3,
  };

  it("escolhe a primeira origem presente no payload (megatec-q1 → entrada)", () => {
    const payload = { data: { measurements: { input_frequency_hz: 60 } } };
    const resolved = resolveGaugeSource(frequency, payload);
    expect(resolved.source?.path).toBe("data.measurements.input_frequency_hz");
    expect(resolved.value).toBe(60);
  });

  it("cai para a origem seguinte quando o protocolo publica o outro caminho (sms-1phase → saída)", () => {
    const payload = { data: { measurements: { output_frequency_hz: 59.9 } } };
    const resolved = resolveGaugeSource(frequency, payload);
    expect(resolved.source?.path).toBe("data.measurements.output_frequency_hz");
    expect(resolved.value).toBe(59.9);
  });

  it("trata null explícito como origem presente (nunca cai para outro protocolo)", () => {
    const payload = { data: { measurements: { input_frequency_hz: null, output_frequency_hz: 59.9 } } };
    const resolved = resolveGaugeSource(frequency, payload);
    expect(resolved.source?.path).toBe("data.measurements.input_frequency_hz");
    expect(resolved.value).toBeNull();
  });

  it("sem nenhum caminho presente, devolve a primeira origem e valor ausente", () => {
    const resolved = resolveGaugeSource(frequency, { data: { measurements: {} } });
    expect(resolved.source?.path).toBe("data.measurements.input_frequency_hz");
    expect(resolved.value).toBeUndefined();
  });

  it("usa o rótulo da origem escolhida no modelo do gauge", () => {
    const payload = { data: { measurements: { output_frequency_hz: 59.9 } } };
    const resolved = resolveGaugeSource(frequency, payload);
    const model = buildGaugeRenderModel({
      definition: frequency,
      value: resolved.value,
      stale: false,
      source: resolved.source,
    });
    expect(model.label).toBe("Frequência de saída");
    expect(model.ariaLabel).toContain("Frequência de saída");
  });
});
