import { fromUnits, toUnits } from "../money/money.ts";

/**
 * Empty-population rule for the project parity certificate.
 *
 * A present-but-empty source artifact (a `[]` JSON export, a header-only TSV
 * parsed to no rows) with an empty tenant compares nothing: every
 * mismatch/nonexact counter stays at zero, so the gate reads "exact" with
 * source=0 — a vacuous agreement that passes the migration parity gate. A
 * missing file is already "unproven"; an empty file must be too. Empty is
 * unproven, never agreement.
 *
 * Callers must route empty populations to emptyPopulationGate first: the
 * evaluators below compare populations, and comparing nothing is exact by
 * arithmetic, not by evidence.
 */
export interface EmptyPopulationGate {
  status: "unproven";
  sourceCount: 0;
  targetCount: number | null;
  exactCount: null;
  mismatchCount: null;
  detail: string;
}

/** A present-but-empty source population: not missing (null), but no rows. */
export function isEmptyPopulation(source: readonly unknown[] | null): boolean {
  return source !== null && source.length === 0;
}

/** The crew population arrives aggregated, so its emptiness is a map size. */
export function isEmptyCrewPopulation(
  crew: ReadonlyMap<unknown, unknown> | null,
): boolean {
  return crew !== null && crew.size === 0;
}

/** The unproven gate an empty source population earns, naming its artifact. */
export function emptyPopulationGate(
  targetCount: number | null,
  artifactPath: string,
): EmptyPopulationGate {
  return {
    status: "unproven",
    sourceCount: 0,
    targetCount,
    exactCount: null,
    mismatchCount: null,
    detail:
      `source artifact ${artifactPath} is present but empty — no data ` +
      "compared; an empty population is unproven, never agreement",
  };
}

/**
 * One target crew row: aggregated by ticket, employee, item, date, tier.
 * Every field is optional so plain record rows (whose columns may be absent)
 * are assignable; absent values aggregate under the empty string, exactly as
 * the certificate's inline scan did.
 */
export interface CrewTargetRow {
  source_id?: unknown;
  source_employee_id?: unknown;
  source_item_id?: unknown;
  worked_on?: unknown;
  time_kind?: unknown;
  hours?: unknown;
}

export interface CrewDifference {
  layer: "field_ticket_crew_hours";
  sourceRef: string;
  field: "hours";
  source: string;
  target: string;
}

export interface CrewGateEvaluation {
  status: "exact" | "different";
  sourceCount: number;
  targetCount: number;
  exactCount: number;
  mismatchCount: number;
  targetOnlyCount: number;
  detail: string;
  differences: CrewDifference[];
}

/**
 * Field-ticket crew parity over the WHOLE target population. Target rows
 * whose ticket is absent from the current source export are target-only —
 * counted, reported, and mismatched — instead of being dropped before the
 * comparison (dropping them let a deleted ticket read as agreement, unlike
 * the invoice gate's targetOnly accounting).
 */
export function evaluateCrewGate(
  sourceCrew: ReadonlyMap<string, bigint>,
  targetRows: readonly CrewTargetRow[],
): CrewGateEvaluation {
  const targetCrew = new Map<string, bigint>();
  for (const row of targetRows) {
    const key = [
      row.source_id,
      row.source_employee_id,
      row.source_item_id,
      row.worked_on,
      row.time_kind,
    ]
      .map((value) => String(value ?? ""))
      .join("|");
    targetCrew.set(key, (targetCrew.get(key) ?? 0n) + toUnits(String(row.hours ?? "0")));
  }
  const keys = new Set([...sourceCrew.keys(), ...targetCrew.keys()]);
  const differences: CrewDifference[] = [];
  let exact = 0;
  for (const key of keys) {
    const sourceHours = sourceCrew.get(key) ?? 0n;
    const targetHours = targetCrew.get(key) ?? 0n;
    if (sourceHours === targetHours) {
      exact++;
      continue;
    }
    differences.push({
      layer: "field_ticket_crew_hours",
      sourceRef: key,
      field: "hours",
      source: fromUnits(sourceHours),
      target: fromUnits(targetHours),
    });
  }
  const targetOnlyCount = [...targetCrew.keys()].filter((key) => !sourceCrew.has(key)).length;
  return {
    status: exact === keys.size ? "exact" : "different",
    sourceCount: sourceCrew.size,
    targetCount: targetCrew.size,
    exactCount: exact,
    mismatchCount: keys.size - exact,
    targetOnlyCount,
    detail:
      targetOnlyCount > 0
        ? `Aggregated by source ticket, employee, item, work date, and regular/overtime/double-time tier; ` +
          `${targetOnlyCount} target-only keys fall outside the current source population ` +
          `(deleted tickets read as differences, never agreement)`
        : "Aggregated by source ticket, employee, item, work date, and regular/overtime/double-time tier",
    differences,
  };
}
