/**
 * Metric card: wraps the semicircular gauge with the label and the optional
 * secondary value (e.g., battery voltage on the estimated charge card).
 */
import type { GaugeRenderModel } from "../model/metrics.js";
import { Gauge } from "./Gauge.js";

export interface GaugeCardSecondary {
  label: string;
  value: string;
}

export interface GaugeCardProps {
  model: GaugeRenderModel;
  secondary?: GaugeCardSecondary;
}

export function GaugeCard({ model, secondary }: GaugeCardProps) {
  return (
    <article className="card">
      <Gauge model={model} />
      {secondary ? (
        <p className="card__secondary">
          <span className="card__secondary-label">{secondary.label}</span>
          <span className="card__secondary-value">{secondary.value}</span>
        </p>
      ) : null}
    </article>
  );
}
