/**
 * Operational state area (status frame flags).
 *
 * The full list is always visible (no `<details>`): ACTIVE states are
 * highlighted and INACTIVE ones are also shown, but dimmed — so the screen
 * leaves no empty space nor hides information. No condition is inferred (for
 * example, the absence of `OB` is NOT displayed as "normal mains power"), per
 * scope §5.1.
 *
 * The ORDER of the cards is fixed (the one of the protocol table, from the
 * calmest to the most critical) and does NOT change with active/inactive: if
 * the active ones rose to the top on every reading, the card would "dance" on
 * the screen and the user would not be able to follow the change. The color of
 * the side bar comes from `flagTone`, not from the severity.
 */
import type { FlagView } from "../model/status.js";
import { flagTone } from "../model/status.js";
import { formatText } from "../model/format.js";

export interface StatusFlagsProps {
  /** true when the telemetry brought a usable status block. */
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
    <section className="panel" aria-labelledby="operating-status">
      <h2 id="operating-status" className="panel__title">
        Operational state
      </h2>

      {!available ? (
        <p className="panel__empty">
          No state data: the API did not publish the status frame in this reading.
        </p>
      ) : (
        <>
          {!hasActive ? (
            <p className="panel__empty">
              No active state reported by the device in this reading.
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
                <span className="flag__hint">{flag.active ? "active" : "inactive"}</span>
                <span className="flag__description">{flag.description}</span>
              </li>
            ))}
          </ul>

          <p className="panel__bits">raw_bits: {formatText(rawBits)}</p>
        </>
      )}

      {stale ? (
        <p className="panel__warning">
          The states above come from a stale reading. They do not necessarily represent the
          current condition of the device.
        </p>
      ) : null}
    </section>
  );
}
