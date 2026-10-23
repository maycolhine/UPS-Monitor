/**
 * Semicircular gauge in SVG (no chart library).
 *
 * Shows: semantic bands (red/amber/green), scale with marks, needle, central
 * value with unit and the textual state of the metric.
 * Color is never the only signal — it always accompanies the value and the
 * textual label (scope §4.2 and §6).
 */
import { formatNumber } from "../model/format.js";
import type { GaugeRenderModel } from "../model/metrics.js";
import {
  GAUGE_GEOMETRY,
  arcPath,
  bandBoundaries,
  needlePoint,
  polarPoint,
  valueAngle,
} from "../model/metrics.js";

const GEOMETRY = {
  cx: GAUGE_GEOMETRY.center.x,
  cy: GAUGE_GEOMETRY.center.y,
  radius: GAUGE_GEOMETRY.radius,
  strokeWidth: GAUGE_GEOMETRY.strokeWidth,
};

const TICK_INNER = GEOMETRY.radius + GEOMETRY.strokeWidth / 2 + 2;
const TICK_OUTER = TICK_INNER + 5;
const TICK_LABEL_RADIUS = TICK_OUTER + 8;

function tickAnchor(angleDeg: number): "start" | "middle" | "end" {
  const cosine = Math.cos((angleDeg * Math.PI) / 180);
  if (cosine < -0.3) return "start";
  if (cosine > 0.3) return "end";
  return "middle";
}

export interface GaugeProps {
  model: GaugeRenderModel;
}

export function Gauge({ model }: GaugeProps) {
  const { definition } = model;
  const { min, max } = definition.scale;
  const classes = ["gauge", `gauge--${model.level}`];
  if (!model.hasValue) classes.push("gauge--empty");
  if (model.stale) classes.push("gauge--stale");
  const originNote = model.source?.origin_note ?? null;
  const showOriginNote =
    originNote !== null &&
    !(definition.id === "battery_charge_percent" && originNote === "reported by the device");

  const needle =
    model.hasValue && model.value !== null
      ? needlePoint(model.value, definition.scale, GEOMETRY, GAUGE_GEOMETRY.needleLength)
      : null;

  return (
    <figure className={classes.join(" ")} role="group" aria-label={model.ariaLabel}>
      <svg
        className="gauge__svg"
        viewBox={`0 0 ${GAUGE_GEOMETRY.width} ${GAUGE_GEOMETRY.height}`}
        role="img"
        aria-hidden="true"
        focusable="false"
      >
        {/* Neutral background track */}
        <path
          className="gauge__track"
          d={arcPath(min, max, definition.scale, GEOMETRY)}
          strokeWidth={GEOMETRY.strokeWidth}
          fill="none"
        />

        {/* Semantic bands */}
        <g className="gauge__bands">
          {definition.bands.map((band) => (
            <path
              key={`${band.level}-${band.from}-${band.to}`}
              className={`gauge__band gauge__band--${band.level}`}
              d={arcPath(band.from, band.to, definition.scale, GEOMETRY)}
              strokeWidth={GEOMETRY.strokeWidth}
              fill="none"
            />
          ))}
        </g>

        {/* Band limits: marks where each band starts and ends */}
        <g className="gauge__ticks">
          {bandBoundaries(definition.bands).map((boundary) => {
            const angle = valueAngle(boundary, min, max);
            const from = polarPoint(GEOMETRY.cx, GEOMETRY.cy, TICK_INNER, angle);
            const to = polarPoint(GEOMETRY.cx, GEOMETRY.cy, TICK_OUTER, angle);
            const label = polarPoint(GEOMETRY.cx, GEOMETRY.cy, TICK_LABEL_RADIUS, angle);
            return (
              <g key={boundary}>
                <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="gauge__tick" />
                <text
                  x={label.x}
                  y={label.y}
                  className="gauge__tick-label"
                  textAnchor={tickAnchor(angle)}
                  dominantBaseline="middle"
                >
                  {formatNumber(boundary, Number.isInteger(boundary) ? 0 : 1)}
                </text>
              </g>
            );
          })}
        </g>

        {/* Needle */}
        {needle ? (
          <g className="gauge__needle-group">
            <line
              className="gauge__needle"
              x1={GEOMETRY.cx}
              y1={GEOMETRY.cy}
              x2={needle.x}
              y2={needle.y}
            />
            <circle className="gauge__hub" cx={GEOMETRY.cx} cy={GEOMETRY.cy} r={5} />
          </g>
        ) : null}

        {/* Central value */}
        <text className="gauge__value" x={GEOMETRY.cx} y={GEOMETRY.cy - 24} textAnchor="middle">
          {model.displayValue}
        </text>
        <text className="gauge__unit" x={GEOMETRY.cx} y={GEOMETRY.cy - 6} textAnchor="middle">
          {definition.unit}
        </text>
      </svg>

      <figcaption className="gauge__caption">
        <span className="gauge__label">
          {model.label}
          {showOriginNote ? (
            <span className="badge badge--estimate">{originNote}</span>
          ) : null}
        </span>
        <span className={`gauge__status gauge__status--${model.level}`}>
          <span className="gauge__dot" aria-hidden="true" />
          {model.statusText}
        </span>
      </figcaption>
    </figure>
  );
}
