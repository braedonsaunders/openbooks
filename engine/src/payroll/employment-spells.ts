/**
 * An employment's separation spells. Each spell begins at the service start
 * (or the first active version after a termination, a rehire) and ends at a
 * recorded termination; the last spell may still be open. Separation filings
 * propose one event per spell, so a rehired worker's interruptions are never
 * folded into one.
 */
export type EmploymentSpell = { start: string | null; terminatedOn: string | null };
/** Spells from the current-recorded employment history; the role's termination date covers employments with none. */
export function employmentSpells(
  serviceStart: string | null,
  roleTerminatedOn: string | null,
  versions: readonly { status: string; effectiveFrom: string }[],
): EmploymentSpell[] {
  const spells: EmploymentSpell[] = [];
  let current: EmploymentSpell | null = {
    start: serviceStart ?? versions[0]?.effectiveFrom ?? null,
    terminatedOn: null,
  };
  for (const version of versions) {
    if (version.status === "terminated") {
      if (current) {
        spells.push({ ...current, terminatedOn: version.effectiveFrom });
        current = null;
      }
    } else if (!current && version.status !== "offered")
      current = { start: version.effectiveFrom, terminatedOn: null };
  }
  if (current)
    spells.push(spells.length === 0 ? { ...current, terminatedOn: roleTerminatedOn } : current);
  return spells;
}
