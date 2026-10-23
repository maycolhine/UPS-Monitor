/**
 * Bloco B do quadrante de Teste de Bateria: os gráficos da linha do tempo.
 *
 * A barra lateral esquerda lista as quatro métricas como blocos selecionáveis
 * (tensão de saída, frequência, temperatura interna e carga da bateria) e a área
 * à direita desenha a série escolhida. Cada bloco já resume a oscilação da
 * própria métrica vinda de `deltas.metrics`, para que o usuário veja o número
 * sem precisar trocar de gráfico.
 *
 * Os pontos vêm de `samples[].normalized` (espelho padronizado entre
 * protocolos): chave AUSENTE significa "série indisponível para este
 * equipamento" e nunca é desenhada como uma linha reta em zero.
 *
 * O desenho é SVG próprio (sem biblioteca de gráficos), com a geometria pura em
 * `model/batteryTest.ts` — a componente só projeta os números na tela.
 */
import { useState } from "react";

import { buildLineChart, type TestChartModel } from "../model/batteryTest.js";

/** Sistema de coordenadas do SVG; a escala visual fica por conta do CSS. */
const CHART_WIDTH = 720;
const CHART_HEIGHT = 260;

export interface BatteryTestChartsProps {
  models: TestChartModel[];
}

export function BatteryTestCharts({ models }: BatteryTestChartsProps) {
  // Chave vazia cai no primeiro bloco; a seleção é derivada, então trocar de
  // equipamento (ou de teste) nunca deixa um bloco órfão selecionado.
  const [selectedKey, setSelectedKey] = useState("");
  const selected = models.find((model) => model.key === selectedKey) ?? models[0] ?? null;

  if (!selected) return null;

  const geometry = buildLineChart(selected.points, {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    decimals: selected.decimals,
    reference: selected.reference,
  });

  return (
    <div className="bt-charts">
      <ul className="bt-charts__list" aria-label="Métricas do teste de bateria">
        {models.map((model) => {
          const active = model.key === selected.key;
          return (
            <li key={model.key}>
              <button
                type="button"
                className={active ? "bt-charts__block bt-charts__block--active" : "bt-charts__block"}
                aria-pressed={active}
                onClick={() => setSelectedKey(model.key)}
              >
                <span className="bt-charts__block-label">{model.label}</span>
                <span className="bt-charts__block-value">
                  {model.available ? model.variationText : "série indisponível"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <figure className="bt-charts__figure">
        <figcaption className="bt-charts__caption">
          <span className="bt-charts__caption-label">{selected.label}</span>
          <span className="bt-charts__caption-unit">{selected.unit}</span>
        </figcaption>

        {geometry ? (
          <svg
            className="bt-charts__svg"
            viewBox={`0 0 ${geometry.width} ${geometry.height}`}
            role="img"
            aria-label={`${selected.label} em ${selected.unit} ao longo do teste de bateria`}
          >
            {geometry.yTicks.map((tick) => (
              <g key={`y-${tick.pos.toFixed(1)}`}>
                <line
                  className="bt-charts__grid"
                  x1={geometry.plotLeft}
                  x2={geometry.plotRight}
                  y1={tick.pos}
                  y2={tick.pos}
                />
                <text className="bt-charts__axis" x={geometry.plotLeft - 6} y={tick.pos + 3} textAnchor="end">
                  {tick.text}
                </text>
              </g>
            ))}

            {geometry.xTicks.map((tick, index) => (
              <text
                key={`x-${index}`}
                className="bt-charts__axis"
                x={tick.pos}
                y={geometry.height - 5}
                textAnchor={index === 0 ? "start" : index === geometry.xTicks.length - 1 ? "end" : "middle"}
              >
                {tick.text}
              </text>
            ))}

            {/* Linha de referência (alvo do teste de descarga); tracejada, sem valor inventado. */}
            {geometry.referencePos !== null ? (
              <>
                <line
                  className="bt-charts__reference"
                  x1={geometry.plotLeft}
                  x2={geometry.plotRight}
                  y1={geometry.referencePos}
                  y2={geometry.referencePos}
                />
                <text
                  className="bt-charts__reference-label"
                  x={geometry.plotRight}
                  y={geometry.referencePos - 4}
                  textAnchor="end"
                >
                  {selected.referenceLabel}
                </text>
              </>
            ) : null}

            <path className="bt-charts__line" d={geometry.path} />
          </svg>
        ) : (
          <p className="bt-charts__unavailable">
            Série indisponível: o equipamento não publicou {selected.label} nesta janela de teste. O
            painel não desenha zero no lugar do dado ausente.
          </p>
        )}
      </figure>
    </div>
  );
}
