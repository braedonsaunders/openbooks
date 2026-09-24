/**
 * Empty-population rule for the project parity certificate.
 *
 * A present-but-empty source artifact (a `[]` JSON export, a header-only TSV
 * parsed to no rows) with an empty tenant compares nothing: every
 * mismatch/nonexact counter stays at zero, so the gate reads "exact" with
 * source=0 — a vacuous agreement that passes the migration parity gate. A
 * missing file is already "unproven"; an empty file must be too. Empty is
 * unproven, never agreement.
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
