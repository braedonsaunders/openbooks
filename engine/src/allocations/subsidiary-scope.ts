/**
 * Subsidiary allocation scope (m40_allocation_scope): the ONE authoritative
 * helper every allocation route and tool uses to decide what a
 * subsidiary-restricted caller may see or compute.
 *
 * Principle: a restricted caller (`allowed` non-null) may see and act on an
 * allocation only when EVERY subsidiary the computation touches is visible
 * to them — sources, targets and the run pin. Org-wide work (a null pin)
 * aggregates subsidiaries the caller may not see, so it stays invisible to
 * restricted callers. Unrestricted callers (`allowed` null) see everything.
 *
 * Pure and db-free: callers load the row/computation, this module judges.
 * Each surface maps the answer onto its own refusal shape (route 403/404,
 * engine AllocationRunError/RunQueryError, tool { ok: false }) — but the
 * scope decision itself never varies per route.
 */

export type SubsidiaryScope = ReadonlySet<string> | null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function subsidiaryList(value: unknown): Array<{ subsidiaryId?: string | null } | null> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value as Array<{ subsidiaryId?: string | null } | null>;
}

/**
 * Preview-pin refusal for subsidiary-restricted callers. Returns the named
 * refusal, or null when the pin is acceptable. An omitted pin would sweep
 * every legal entity, so omitted means refuse — never fall through to an
 * org-wide computation.
 */
export function previewPinError(
  allowed: SubsidiaryScope,
  subsidiaryId: string | null | undefined,
): string | null {
  if (allowed === null) return null;
  if (subsidiaryId == null) return "a subsidiary pin is required for subsidiary-restricted callers";
  if (!allowed.has(subsidiaryId)) return "subsidiary outside the caller's scope";
  return null;
}

/**
 * Every subsidiary a run/computation touches: the pin, every source, every
 * target coordinate and every built line. A null target/line coordinate
 * inherits its source coordinate at build time (`sameDims`), so nulls carry
 * no independent scope — except a null PIN, which means org-wide and is
 * reported as null so restricted callers refuse it.
 *
 * A present-but-malformed section marks the evidence incomplete: the stored
 * computation cannot be trusted, so restricted callers refuse it rather
 * than guessing.
 */
export function allocationTouchedSubsidiaries(
  subsidiaryId: string | null,
  computation?: unknown,
): { touched: (string | null)[]; complete: boolean } {
  const touched: (string | null)[] = [subsidiaryId];
  const record = asRecord(computation);
  if (!record) return { touched, complete: true };
  const sources = subsidiaryList(record.sources);
  if (sources === null) return { touched, complete: false };
  for (const source of sources) touched.push(source?.subsidiaryId ?? null);
  const targets = record.targets;
  if (targets !== undefined) {
    if (!Array.isArray(targets)) return { touched, complete: false };
    for (const target of targets) {
      const coordinate = asRecord((target as Record<string, unknown> | null)?.coordinate);
      touched.push(typeof coordinate?.subsidiaryId === "string" ? coordinate.subsidiaryId : null);
    }
  }
  const lines = subsidiaryList(record.lines);
  if (lines === null) return { touched, complete: false };
  for (const line of lines) touched.push(line?.subsidiaryId ?? null);
  return { touched, complete: true };
}

/**
 * The authoritative visibility predicate: a restricted caller sees the
 * run/computation only when the pin is set AND every touched subsidiary is
 * in their set. Null coordinates inherit already-checked sources, so only
 * non-null entries need membership.
 */
export function allocationScopeVisible(
  allowed: SubsidiaryScope,
  subsidiaryId: string | null,
  computation?: unknown,
): boolean {
  if (allowed === null) return true;
  if (subsidiaryId === null) return false;
  if (!allowed.has(subsidiaryId)) return false;
  const { touched, complete } = allocationTouchedSubsidiaries(subsidiaryId, computation);
  if (!complete) return false;
  return touched.every((sub) => sub === null || allowed.has(sub));
}

/**
 * S4: a run pinned to subsidiary X whose explicit targets cross into another
 * subsidiary. The kernel has no intercompany balancing (contributed lines
 * must balance per subsidiary), so preview/post refuse by name instead of
 * silently posting into a legal entity the pin excludes. Unpinned (org-wide)
 * sweeps keep their existing behaviour. Returns the refusal, or null.
 */
export function targetPinViolation(
  ruleKey: string,
  subsidiaryId: string | null,
  targetSubsidiaryIds: (string | null)[],
): string | null {
  if (subsidiaryId === null) return null;
  const outside = [...new Set(targetSubsidiaryIds.filter((sub) => sub !== null && sub !== subsidiaryId))];
  if (outside.length === 0) return null;
  return (
    `allocation rule ${ruleKey} targets ` +
    `${outside.length === 1 ? "subsidiary" : "subsidiaries"} ${outside.join(", ")} ` +
    `outside the pinned subsidiary ${subsidiaryId}`
  );
}

/**
 * S5: the run pin intersected with the published rule's subsidiary filter.
 * A rule restricted to company B sources, pinned to A, would otherwise
 * allocate A's ledger under a rule that does not cover A. An empty
 * intersection refuses by name instead of sweeping the wrong books.
 */
export function sourceScopeViolation(
  ruleName: string,
  subsidiaryId: string | null,
  filterSubsidiaryIds: string[],
): string | null {
  if (subsidiaryId === null) return null;
  if (filterSubsidiaryIds.length === 0) return null;
  if (filterSubsidiaryIds.includes(subsidiaryId)) return null;
  return `allocation rule ${ruleName} does not cover subsidiary ${subsidiaryId}`;
}
