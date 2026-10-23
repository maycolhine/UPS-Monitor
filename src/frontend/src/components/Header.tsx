/**
 * Cabeçalho: identificação do produto, última leitura válida (no canto
 * superior, à direita do título) e a seleção dos nobreaks coletados (recebida
 * via `children`).
 *
 * O estado de comunicação não é mais um texto aqui: cada nobreak da lista traz
 * a sua própria bolinha on/off, e o detalhamento fica no quarto quadrante.
 */
import type { ReactNode } from "react";

import { formatLocalDateTime } from "../model/format.js";

export interface HeaderProps {
  productName: string;
  lastTelemetryAtUtc: string | null;
  refreshIntervalMs: number;
  /** Seleção em bloco dos nobreaks coletados, exibida abaixo do título. */
  children?: ReactNode;
}

export function Header(props: HeaderProps) {
  const { productName, lastTelemetryAtUtc, refreshIntervalMs, children } = props;

  return (
    <header className="header">
      <div className="header__top">
        <h1 className="header__title">{productName}</h1>
        <dl className="header__reading">
          <dt>Última leitura válida</dt>
          <dd>{formatLocalDateTime(lastTelemetryAtUtc)}</dd>
        </dl>
      </div>

      {children}

      <p className="header__refresh-note">
        Atualização automática a cada {Math.round(refreshIntervalMs / 1000)} s
      </p>
    </header>
  );
}
