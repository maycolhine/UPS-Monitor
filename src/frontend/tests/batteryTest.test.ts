import { describe, expect, it } from "vitest";

import type { BatteryTestReport } from "../src/model/contract.js";
import {
  buildChartPoints,
  buildEstimateView,
  buildHistoryRows,
  buildLineChart,
  buildObservationView,
  buildTestChartModels,
  buildTestGuards,
  buildTestProgress,
  buildTestTypeOptions,
  describeFinishReason,
  describeTestError,
  describeTestStatus,
  describeTestType,
  describeTestTypeParams,
  formatOffsetSeconds,
  readTestSupport,
  testPhase,
} from "../src/model/batteryTest.js";

/**
 * O modelo do teste de bateria é puro e não fala com a rede. Os casos abaixo
 * cobrem a regra de ouro do projeto: a API entrega FATOS e o viewer APRESENTA —
 * `estimate.available: false` nunca vira número.
 */

describe("readTestSupport", () => {
  it("lê as capacidades declaradas pela API (contrato 3.0)", () => {
    const support = readTestSupport({
      battery_test: {
        supported: true,
        enabled: true,
        abort_supported: true,
        duration_s: 10,
        sample_interval_s: 0.4,
        cooldown_s: 300,
        min_battery_percent: 50,
        test_types: ["duration_10s", "discharge_20pct"],
        types: {
          duration_10s: { duration_s: 10, sample_interval_s: 0.4 },
          discharge_20pct: { target_percent: 20, timeout_s: 1800, sample_interval_s: 1 },
        },
      },
    });
    expect(support).toMatchObject({
      supported: true,
      enabled: true,
      abortSupported: true,
      durationS: 10,
      sampleIntervalS: 0.4,
      cooldownS: 300,
      minBatteryPercent: 50,
      testTypes: ["duration_10s", "discharge_20pct"],
    });
    // O detalhe de cada tipo (janela × alvo/teto) vem de `types.<type>`.
    expect(support.types["discharge_20pct"]?.target_percent).toBe(20);
    expect(support.types["discharge_20pct"]?.timeout_s).toBe(1800);
  });

  it("trata ausência de capacidades como não suportado (sem inventar padrões)", () => {
    const support = readTestSupport(undefined);
    expect(support.supported).toBe(false);
    expect(support.enabled).toBe(false);
    expect(support.abortSupported).toBe(false);
    expect(support.durationS).toBeNull();
  });

  it("não promete cancelamento quando o equipamento não o suporta", () => {
    const support = readTestSupport({
      battery_test: { supported: true, enabled: false, abort_supported: false, cooldown_s: 300 },
    });
    const guards = buildTestGuards(support);
    expect(guards.join(" ")).toContain("não cancela");
    expect(guards.join(" ")).toContain("Espera de 5 min");
  });
});

describe("buildEstimateView", () => {
  it("apresenta a autonomia como extrapolação, com a confiança da API", () => {
    const view = buildEstimateView({
      available: true,
      method: "linear_charge_extrapolation",
      window_s: 10.03,
      drop_percent_in_window: 7.5,
      discharge_rate_pp_per_min: 44.86,
      estimated_runtime_min: 2.2,
      capped_at_min: 600,
      confidence: "low",
    });
    expect(view.available).toBe(true);
    expect(view.runtimeText).toBe("2 min 12 s");
    expect(view.note).toContain("Extrapolação linear de 1ª ordem");
    expect(view.note).toContain("confiança low");
    expect(view.note).toContain("Estimativa, não medição");
    expect(view.dischargeRateText).toBe("44,9 p.p./min");
    expect(view.dropText).toBe("7,5 p.p. em 10,0 s");
  });

  it("trata o teto de sanidade como piso, não como precisão", () => {
    const view = buildEstimateView({
      available: true,
      estimated_runtime_min: 600,
      capped_at_min: 600,
      confidence: "low",
    });
    expect(view.runtimeText).toBe("≥ 10 h (extrapolação)");
  });

  it("nunca inventa número quando a API marca a estimativa como indisponível", () => {
    const view = buildEstimateView({
      available: false,
      reason: "queda de carga abaixo da resolucao mensuravel",
      confidence: "low",
    });
    expect(view.available).toBe(false);
    expect(view.runtimeText).toBe("—");
    expect(view.note).toBe("Sem autonomia estimada: queda de carga abaixo da resolucao mensuravel");
  });

  it("avisa quando a API marca disponível mas omite a autonomia", () => {
    const view = buildEstimateView({ available: true, confidence: "low" });
    expect(view.available).toBe(false);
    expect(view.runtimeText).toBe("—");
    expect(view.note).toContain("não publicou a autonomia");
  });
});

describe("buildObservationView", () => {
  const base: Pick<BatteryTestReport, "status" | "test_flag_observed" | "flags_seen"> = {
    status: "completed",
    test_flag_observed: true,
    flags_seen: ["BEEP", "OB", "TEST"],
  };

  it("confirma quando o equipamento reportou a flag TEST", () => {
    const view = buildObservationView(base);
    expect(view.observed).toBe(true);
    expect(view.level).toBe("good");
    expect(view.text).toContain("reportou a flag TEST");
  });

  it("avisa quando o TEST apareceu nas amostras mas a API não confirmou", () => {
    const view = buildObservationView({ ...base, test_flag_observed: false });
    expect(view.observed).toBe(false);
    expect(view.level).toBe("warning");
    expect(view.text).toContain("não a confirmou");
  });

  it("avisa quando o estado de teste não foi observado na janela", () => {
    const view = buildObservationView({ status: "completed", test_flag_observed: false, flags_seen: ["OB"] });
    expect(view.observed).toBe(false);
    expect(view.text).toContain("NÃO reportou o estado de teste");
  });

  it("mantém o estado indefinido enquanto o teste corre", () => {
    const view = buildObservationView({ status: "running", test_flag_observed: true, flags_seen: [] });
    expect(view.observed).toBeNull();
    expect(view.level).toBe("unknown");
  });
});

describe("tipos de teste", () => {
  it("oferece SOMENTE os tipos declarados em test_types", () => {
    const support = readTestSupport({
      battery_test: {
        supported: true,
        enabled: true,
        test_types: ["duration_10s", "discharge_20pct"],
        types: {
          duration_10s: { duration_s: 10, sample_interval_s: 0.4 },
          discharge_20pct: { target_percent: 20, timeout_s: 1800, sample_interval_s: 1 },
        },
      },
    });
    const options = buildTestTypeOptions(support);
    expect(options.map((option) => option.type)).toEqual(["duration_10s", "discharge_20pct"]);
    expect(options[0]?.label).toBe("Teste rápido (~10 s)");
    expect(options[0]?.isTarget).toBe(false);
    expect(options[1]?.label).toBe("Descarga controlada (até 20 %)");
    expect(options[1]?.isTarget).toBe(true);
    expect(options[1]?.params?.target_percent).toBe(20);
  });

  it("não oferece tipo algum quando a API não publica test_types", () => {
    // O `megatec-q1` só lista `duration_10s`; sem lista, o seletor fica vazio em
    // vez de inventar um tipo que a API recusaria com 422.
    expect(buildTestTypeOptions(readTestSupport({ battery_test: { enabled: true } }))).toEqual([]);
  });

  it("descreve o tipo escolhido por janela × alvo", () => {
    const support = readTestSupport({
      battery_test: {
        enabled: true,
        test_types: ["duration_10s", "discharge_20pct"],
        types: {
          duration_10s: { duration_s: 10 },
          discharge_20pct: { target_percent: 20, timeout_s: 1800 },
        },
      },
    });
    const [windowOption, targetOption] = buildTestTypeOptions(support);
    expect(describeTestTypeParams(windowOption ?? null)).toBe("Janela de 10,0 s");
    expect(describeTestTypeParams(targetOption ?? null)).toBe("Descarga até 20%");
    expect(describeTestTypeParams(null)).toBe("—");
    expect(describeTestType("discharge_20pct")).toBe("Descarga controlada (até 20 %)");
    // Tipo novo mantém o próprio nome da API.
    expect(describeTestType("tipo_novo")).toBe("tipo_novo");
  });
});

describe("séries dos gráficos", () => {
  it("ignora a chave ausente — a série indisponível nunca vira zero", () => {
    const points = buildChartPoints(
      [
        { offset_s: 0, normalized: { output_voltage_v: 218 } },
        { offset_s: 1, normalized: {} },
        { offset_s: 2, normalized: { output_voltage_v: null } },
        { offset_s: 3 },
      ],
      "output_voltage_v",
    );
    expect(points).toEqual([{ x: 0, y: 218 }]);
    expect(buildChartPoints(null, "output_voltage_v")).toEqual([]);
  });

  it("monta as quatro métricas na ordem da barra lateral", () => {
    const models = buildTestChartModels({
      samples: [
        {
          offset_s: 0,
          normalized: {
            output_voltage_v: 218,
            frequency_hz: 60,
            temperature_c: 26,
            battery_charge_percent: 100,
          },
        },
        {
          offset_s: 5,
          normalized: {
            output_voltage_v: 217,
            frequency_hz: 60.2,
            temperature_c: 27,
            battery_charge_percent: 90,
          },
        },
      ],
      deltas: {
        metrics: {
          output_voltage_v: { ripple: 1 },
          frequency_hz: { ripple: 0.2 },
          temperature_c: { delta: 1 },
          battery_charge_percent: { delta: -10 },
        },
      },
      target_percent: 20,
    });

    expect(models.map((model) => model.key)).toEqual([
      "output_voltage_v",
      "frequency_hz",
      "temperature_c",
      "battery_charge_percent",
    ]);
    expect(models[0]?.available).toBe(true);
    expect(models[0]?.variationText).toBe("Oscilação 1,0 V");
    expect(models[1]?.variationText).toBe("Oscilação 0,2 Hz");
    expect(models[2]?.variationText).toBe("Variação +1,0 °C");
    expect(models[3]?.variationText).toBe("Queda -10,0 p.p.");
    // A linha do alvo só existe na carga da bateria.
    expect(models[0]?.reference).toBeNull();
    expect(models[3]?.reference).toBe(20);
    expect(models[3]?.referenceLabel).toBe("alvo 20%");
  });

  it("marca como indisponível a métrica que o equipamento não publicou", () => {
    const models = buildTestChartModels({
      samples: [{ offset_s: 0, normalized: { output_voltage_v: 218 } }],
      target_percent: null,
    });
    expect(models[0]?.available).toBe(true);
    expect(models[1]?.available).toBe(false);
    expect(models[1]?.points).toEqual([]);
    expect(models[1]?.variationText).toBe("—");
    expect(models[3]?.reference).toBeNull();
  });
});

describe("geometria do gráfico", () => {
  it("formata o eixo X em segundos curtos e em m:ss nos testes longos", () => {
    expect(formatOffsetSeconds(0)).toBe("0,0 s");
    expect(formatOffsetSeconds(9.6)).toBe("9,6 s");
    expect(formatOffsetSeconds(12)).toBe("12,0 s");
    expect(formatOffsetSeconds(125)).toBe("125,0 s");
    expect(formatOffsetSeconds(125, true)).toBe("2:05");
  });

  it("projeta a série no SVG com eixo Y de folga e eixo X de tempo", () => {
    const geometry = buildLineChart(
      [
        { x: 0, y: 218 },
        { x: 5, y: 217 },
        { x: 10, y: 218 },
      ],
      { width: 200, height: 100, decimals: 1 },
    );
    expect(geometry).not.toBeNull();
    expect(geometry?.path.startsWith("M")).toBe(true);
    expect(geometry?.yTicks).toHaveLength(4);
    expect(geometry?.xTicks.map((tick) => tick.text)).toEqual(["0,0 s", "5,0 s", "10,0 s"]);
    expect(geometry?.plotLeft).toBe(42);
    expect(geometry?.plotRight).toBe(188);
    expect(geometry?.referencePos).toBeNull();
  });

  it("usa m:ss em todos os rótulos quando a janela passa de um minuto", () => {
    const geometry = buildLineChart(
      [
        { x: 0, y: 100 },
        { x: 246, y: 60 },
        { x: 492, y: 20 },
      ],
      { width: 200, height: 100, decimals: 0 },
    );
    expect(geometry?.xTicks.map((tick) => tick.text)).toEqual(["0:00", "4:06", "8:12"]);
  });

  it("posiciona a linha do alvo dentro da área de plotagem", () => {
    const geometry = buildLineChart(
      [
        { x: 0, y: 100 },
        { x: 10, y: 20 },
      ],
      { width: 200, height: 100, decimals: 0, reference: 20 },
    );
    expect(geometry?.referencePos).not.toBeNull();
    const pos = geometry?.referencePos ?? -1;
    expect(pos).toBeGreaterThan(0);
    expect(pos).toBeLessThan(100);
  });

  it("não desenha nada quando a série está vazia", () => {
    expect(buildLineChart([], { width: 200, height: 100, decimals: 1 })).toBeNull();
  });
});

describe("buildTestProgress", () => {
  it("no teste de janela, usa o tempo decorrido sobre a janela pedida", () => {
    const view = buildTestProgress(
      {
        status: "running",
        started_at_utc: "2026-10-22T15:04:11.400Z",
        expected_end_at_utc: "2026-10-22T15:04:21.400Z",
      },
      Date.parse("2026-10-22T15:04:16.400Z"),
    );
    expect(view?.mode).toBe("window");
    expect(view?.fraction).toBeCloseTo(0.5, 5);
    expect(view?.text).toBe("5,0 s de 10,0 s");
  });

  it("no teste por alvo, progride pela carga e ignora o teto de 30 min", () => {
    const view = buildTestProgress(
      {
        status: "running",
        type: "discharge_20pct",
        target_percent: 20,
        // O teto de 30 min é apenas segurança: se fosse usado como janela, a
        // barra ficaria quase vazia mesmo com metade da descarga concluída.
        started_at_utc: "2026-10-22T15:20:00.000Z",
        expected_end_at_utc: "2026-10-22T15:50:00.000Z",
        baseline: { battery_charge_percent: 100 },
        samples: [{ offset_s: 1, normalized: { battery_charge_percent: 70 } }],
      },
      Date.parse("2026-10-22T15:24:00.000Z"),
    );
    expect(view?.mode).toBe("target");
    expect(view?.fraction).toBeCloseTo(0.375, 5);
    expect(view?.text).toBe("Descarregando até 20% · atual: 70%");
  });

  it("no teste por alvo, deixa a barra indeterminada enquanto não há carga", () => {
    const view = buildTestProgress(
      {
        status: "running",
        target_percent: 20,
        started_at_utc: "2026-10-22T15:20:00.000Z",
        baseline: null,
        samples: [],
      },
      Date.parse("2026-10-22T15:20:01.000Z"),
    );
    expect(view?.mode).toBe("target");
    expect(view?.fraction).toBeNull();
    expect(view?.text).toContain("aguardando a primeira amostra");
  });

  it("não projeta progresso fora da execução", () => {
    expect(
      buildTestProgress(
        { status: "completed", started_at_utc: null, expected_end_at_utc: null },
        Date.now(),
      ),
    ).toBeNull();
  });
});

describe("descrições e histórico", () => {
  it("traduz status, motivo de encerramento e erros do contrato", () => {
    expect(describeTestStatus("running")).toBe("Em andamento");
    expect(describeTestStatus("aborting")).toBe("Cancelando");
    expect(describeTestStatus("status_novo")).toBe("status_novo");
    expect(describeFinishReason("duration_elapsed")).toBe("Janela completa do teste");
    expect(describeFinishReason("target_percent_reached")).toContain("atingiu o alvo");
    expect(describeFinishReason("watchdog")).toContain("teto de tempo");
    expect(describeFinishReason(null)).toBe("—");
    expect(describeTestError({ code: "test_cooldown", message: "" })).toContain("cooldown");
    expect(describeTestError({ code: "battery_at_target", message: "" })).toContain("alvo");
    expect(describeTestError({ code: "test_requires_battery_percent", message: "" })).toContain(
      "percentual da bateria",
    );
    expect(describeTestError({ code: "codigo_novo", message: "detalhe da API" })).toBe("detalhe da API");
    expect(describeTestError(null)).toBe("—");
  });

  it("mapeia o status para a fase visual, sem inventar fase", () => {
    expect(testPhase("completed")).toBe("completed");
    expect(testPhase("aborting")).toBe("unknown");
    expect(testPhase(null)).toBe("unknown");
  });

  it("monta o histórico com os fatos publicados pela API", () => {
    const rows = buildHistoryRows(
      [
        {
          test_id: "abc",
          type: "duration_10s",
          status: "completed",
          started_at_utc: "2026-10-22T15:04:11.400Z",
          finish_reason: "duration_elapsed",
          flags_seen: ["TEST"],
          estimate: { available: true, estimated_runtime_min: 2.2, confidence: "low" },
        },
        {
          test_id: "def",
          type: "discharge_20pct",
          status: "completed",
          finish_reason: "target_percent_reached",
          flags_seen: [],
          estimate: { available: false, reason: "queda pequena", confidence: "low" },
        },
      ],
      () => "22/10/2026 12:04:11",
    );
    expect(rows[0]?.runtimeText).toBe("2 min 12 s");
    expect(rows[0]?.typeText).toBe("Teste rápido (~10 s)");
    expect(rows[1]?.typeText).toBe("Descarga controlada (até 20 %)");
    expect(rows[1]?.finishText).toContain("atingiu o alvo");
    expect(rows[0]?.observedTestFlag).toBe(true);
    expect(rows[1]?.runtimeText).toBe("sem estimativa (queda pequena)");
    expect(rows[1]?.observedTestFlag).toBe(false);
    expect(buildHistoryRows(null, () => "")).toEqual([]);
  });
});
