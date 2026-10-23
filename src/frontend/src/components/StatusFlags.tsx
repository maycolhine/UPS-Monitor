/**
 * Área de estado operacional (flags do quadro de status).
 *
 * A lista completa fica sempre visível (sem `<details>`): os estados ATIVOS
 * aparecem em destaque e os INATIVOS também ficam à mostra, porém apagados —
 * assim a tela não deixa espaço vazio nem esconde informação. Nenhuma condição
 * é inferida (por exemplo, ausência de `OB` NÃO é exibida como "rede elétrica
 * normal"), conforme escopo §5.1.
 *
 * A ORDEM dos cards é fixa (a da tabela do protocolo, do mais tranquilo ao mais
 * crítico) e NÃO muda conforme ativo/inativo: se os ativos subissem ao topo a
 * cada leitura, o card "dançaria" na tela e o usuário não conseguiria acompanhar
 * a mudança. A cor da barra lateral vem de `flagTone`, não da severidade.
 */
import type { FlagView } from "../model/status.js";
import { flagTone } from "../model/status.js";
import { formatText } from "../model/format.js";

export interface StatusFlagsProps {
  /** true quando a telemetria trouxe o bloco de status utilizável. */
  available: boolean;
  stale: boolean;
  flags: FlagView[];
  unknownFlags: FlagView[];
  rawBits: string | null;
}

export function StatusFlags({ available, stale, flags, unknownFlags, rawBits }: StatusFlagsProps) {
  const all = [...flags, ...unknownFlags];
  const hasActive = all.some((flag) => flag.active);

  return (
    <section className="panel" aria-labelledby="estado-operacional">
      <h2 id="estado-operacional" className="panel__title">
        Estado operacional
      </h2>

      {!available ? (
        <p className="panel__empty">
          Sem dados de estado: a API não publicou o quadro de status nesta leitura.
        </p>
      ) : (
        <>
          {!hasActive ? (
            <p className="panel__empty">
              Nenhum estado ativo informado pelo equipamento nesta leitura.
            </p>
          ) : null}

          <ul className="flag-list">
            {all.map((flag) => (
              <li
                key={flag.id}
                className={`flag flag--${flagTone(flag)} ${flag.active ? "flag--on" : "flag--off"}`}
              >
                <span className="flag__id">{flag.id}</span>
                <span className="flag__label">{flag.label}</span>
                <span className="flag__hint">{flag.active ? "ativo" : "inativo"}</span>
                <span className="flag__description">{flag.description}</span>
              </li>
            ))}
          </ul>

          <p className="panel__bits">raw_bits: {formatText(rawBits)}</p>
        </>
      )}

      {stale ? (
        <p className="panel__warning">
          Os estados acima são de uma leitura desatualizada. Não representam necessariamente a
          condição atual do equipamento.
        </p>
      ) : null}
    </section>
  );
}
