/**
 * Header: product identification, last valid reading (in the top corner, to the
 * right of the title) and the selection of the collected UPS units (received via
 * `children`).
 *
 * The communication state is no longer text here: each UPS in the list carries
 * its own on/off dot, and the detail is in the fourth quadrant.
 */
import type { ReactNode } from "react";

import { formatLocalDateTime } from "../model/format.js";

export interface HeaderProps {
  productName: string;
  lastTelemetryAtUtc: string | null;
  refreshIntervalMs: number;
  /** Block selection of the collected UPS units, shown below the title. */
  children?: ReactNode;
}

export function Header(props: HeaderProps) {
  const { productName, lastTelemetryAtUtc, refreshIntervalMs, children } = props;

  return (
    <header className="header">
      <div className="header__top">
        <h1 className="header__title">{productName}</h1>
        <dl className="header__reading">
          <dt>Last valid reading</dt>
          <dd>{formatLocalDateTime(lastTelemetryAtUtc)}</dd>
        </dl>
      </div>

      {children}

      <p className="header__refresh-note">
        Automatic refresh every {Math.round(refreshIntervalMs / 1000)} s
      </p>
    </header>
  );
}
