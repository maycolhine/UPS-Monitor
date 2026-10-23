/**
 * Block B of the Battery Test quadrant: the timeline charts.
 *
 * The left side bar lists the four metrics as selectable blocks (output
 * voltage, frequency, internal temperature and battery charge) and the area on
 * the right draws the chosen series. Each block already summarizes the
 * oscillation of its own metric coming from `deltas.metrics`, so the user sees
 * the number without having to switch charts.
 *
 * The points come from `samples[].normalized` (the standardized mirror across
 * protocols): an ABSENT key means "series unavailable for this device" and is
 * never drawn as a straight line at zero.
 *
 * The drawing is its own SVG (no chart library), with the pure geometry in
 * `model/batteryTest.ts` — the component only projects the numbers onto the
 * screen.
 */
import { useState } from "react";

import { buildLineChart, type TestChartModel } from "../model/batteryTest.js";

/** SVG coordinate system; the visual scale is handled by CSS. */
const CHART_WIDTH = 720;
const CHART_HEIGHT = 260;

export interface BatteryTestChartsProps {
  models: TestChartModel[];
}

export function BatteryTestCharts({ models }: BatteryTestChartsProps) {
  // An empty key falls back to the first block; the selection is derived, so
  // switching device (or test) never leaves an orphan block selected.
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
      <ul className="bt-charts__list" aria-label="Battery test metrics">
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
                  {model.available ? model.variationText : "series unavailable"}
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
            aria-label={`${selected.label} in ${selected.unit} over the battery test`}
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

            {/* Reference line (target of the discharge test); dashed, with no invented value. */}
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
            Series unavailable: the device did not publish {selected.label} in this test window. The
            panel does not draw zero in place of the missing data.
          </p>
        )}
      </figure>
    </div>
  );
}
