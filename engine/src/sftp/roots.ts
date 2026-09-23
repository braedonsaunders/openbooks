/**
 * Non-overlapping virtual-server roots. Each SFTP login's filesystem is
 * rooted at its `root_prefix`, and the daemon enforces only the org
 * namespace — so two logins with the same (or nested) root can read,
 * replace, and delete each other's statements and outbound payment files
 * despite separate credentials.
 *
 * These helpers are the single overlap policy used by the creation route
 * (POST) and the reactivation path (PATCH toggle): the candidate is
 * compared segment-wise against the org's locked server rows, and equal,
 * ancestor, and descendant prefixes are all refused by name. Enforcement
 * considers ACTIVE servers only — an inactive login serves nothing, and
 * reactivating into an overlap refuses — so a retired server never strands
 * its folder forever. `detectRootOverlaps` names every existing overlap
 * pair for preflight/reporting regardless of active flags.
 */

/** An existing server row as the overlap check sees it. */
export interface SftpRootRef {
  id: string;
  name: string;
  rootPrefix: string;
  isActive?: boolean;
}

/** Split a stored prefix into segments, tolerating legacy slash shapes. */
export function splitRootSegments(prefix: string): string[] {
  return String(prefix ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((segment) => segment !== "");
}

/** How two roots relate once both are split into segments. */
export type RootOverlapRelation = "equal" | "ancestor" | "descendant";

function relate(candidate: string[], existing: string[]): RootOverlapRelation | null {
  const shared = Math.min(candidate.length, existing.length);
  for (let i = 0; i < shared; i++) {
    if (candidate[i] !== existing[i]) return null;
  }
  if (candidate.length === existing.length) return "equal";
  return candidate.length < existing.length ? "ancestor" : "descendant";
}

/**
 * First existing row the candidate root overlaps (equal, ancestor, or
 * descendant), or null. Segment-wise: `sftp/org/x` overlaps
 * `sftp/org/x/sub` but NOT `sftp/org/x2`. Rows whose own prefix splits to
 * nothing are ignored — a missing root cannot contain anything.
 */
export function findRootOverlap(candidatePrefix: string, existing: readonly SftpRootRef[]): { row: SftpRootRef; relation: RootOverlapRelation } | null {
  const candidate = splitRootSegments(candidatePrefix);
  if (candidate.length === 0) return null;
  for (const row of existing) {
    const segments = splitRootSegments(row.rootPrefix);
    if (segments.length === 0) continue;
    const relation = relate(candidate, segments);
    if (relation) return { row, relation };
  }
  return null;
}

/** Every overlapping pair among the given rows (each pair reported once). */
export function detectRootOverlaps(rows: readonly SftpRootRef[]): { a: SftpRootRef; b: SftpRootRef; relation: RootOverlapRelation }[] {
  const out: { a: SftpRootRef; b: SftpRootRef; relation: RootOverlapRelation }[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = splitRootSegments(rows[i]!.rootPrefix);
      const b = splitRootSegments(rows[j]!.rootPrefix);
      if (a.length === 0 || b.length === 0) continue;
      const relation = relate(a, b);
      if (relation) out.push({ a: rows[i]!, b: rows[j]!, relation });
    }
  }
  return out;
}

/**
 * Refusal message naming the conflicting server and the remedy. `candidate`
 * is the requested prefix, `hit` the overlap found by `findRootOverlap`.
 */
export function rootOverlapRefusal(candidatePrefix: string, hit: { row: SftpRootRef; relation: RootOverlapRelation }): string {
  const { row, relation } = hit;
  const how =
    relation === "equal"
      ? `is the same folder as server '${row.name}'`
      : relation === "ancestor"
        ? `contains the folder of server '${row.name}'`
        : `is a folder inside server '${row.name}'`;
  return (
    `SFTP root '${candidatePrefix}' ${how} (root '${row.rootPrefix}'): ` +
    `two bank logins must never share a folder — choose a folder that is neither the same ` +
    `nor nested inside another server's folder, or delete the conflicting server first`
  );
}
