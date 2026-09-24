import { sql, type SQL } from "drizzle-orm";
import { withOrgTransaction, type SqlExecutor } from "../platform/db.ts";

/**
 * Canonical subsidiary-scope shapes for every authorization-semantics fix.
 *
 * One module, four shapes — web routes import them through the engine
 * boundary, engine writers call them directly:
 *
 *   1. Engine (and service) writes take a REQUIRED
 *      `allowedSubsidiaryIds: ReadonlySet<string> | null` (null means
 *      unrestricted, by explicit sentinel only, never by omission), lock the
 *      parent row FOR UPDATE and assert scope inside the transaction,
 *      throwing a not-found-shaped domain error. `lockProjectForScope` is the
 *      project instance; the same lock-then-assert order applies to every
 *      other parent (party, document, kiosk unit).
 *   2. Org-wide policy and config writes use one route-level guard, a 403
 *      `requires unrestricted subsidiary access`. Record-level denials stay
 *      the uniform 404 (`guardSubsidiaryScope` in web/lib/authz): a B record
 *      is indistinguishable from a missing one, while an org-wide write
 *      names its remedy because the record itself is visible.
 *   3. Multi-query reads run in ONE REPEATABLE READ transaction
 *      (`withScopeSnapshot`) with the scope predicate
 *      (`subsidiaryVisibleFilter`) on every query, so a concurrent rehome
 *      cannot move a row between two reads of one response.
 *   4. Permission-before-existence: `assertAnyPermission` checks that the
 *      caller holds ANY permission of the family, else a uniform 404, and
 *      only then does the caller look the record up — a missing permission
 *      must never be reported as a missing record, nor a missing record as
 *      a missing permission.
 */

export interface SubsidiaryScopeOptions {
  /** Null-subsidiary rows are org-wide shared (parties), not private. */
  orgWideNull?: boolean;
}

/**
 * Subsidiary visibility for ONE loaded record — the direct-read/write twin of
 * the list WHERE fragments, so a record hidden from a restricted caller's
 * lists is equally unreachable by id. Unrestricted callers (null set) pass.
 *
 *   - documents/journals/payments/orders/runs: subsidiary_id must be IN the
 *     set; a null subsidiary fails closed.
 *   - parties carry org-wide identity: their lists expose null-subsidiary
 *     rows — pass orgWideNull for them.
 */
export function subsidiaryScopeAllows(
  scope: ReadonlySet<string> | null,
  subsidiaryId: string | null | undefined,
  opts: SubsidiaryScopeOptions = {},
): boolean {
  if (scope === null) return true;
  if (subsidiaryId === null || subsidiaryId === undefined || subsidiaryId === "") {
    return opts.orgWideNull === true;
  }
  return scope.has(subsidiaryId);
}

/**
 * WHERE fragment narrowing a documents-table `column` to the caller's visible
 * subsidiaries. Unrestricted callers get an empty fragment; an empty set
 * denies every row (`and false`). Master-data callers may explicitly allow
 * org-wide null assignments, matching the direct-record rule above.
 */
export function subsidiaryVisibleFilter(
  column: SQL,
  allowed: ReadonlySet<string> | null,
  options: { orgWideNull?: boolean } = {},
): SQL {
  if (allowed === null) return sql``;
  if (!allowed) return sql` and false`;
  const ids = [...allowed];
  if (options.orgWideNull) {
    return sql` and (${column} is null or ${column} = any(${`{${ids.join(',')}}`}::uuid[]))`;
  }
  return ids.length
    ? sql` and ${column} = any(${`{${ids.join(',')}}`}::uuid[])`
    : sql` and false`;
}

/** Denial body for org-wide policy/config writes by restricted callers. */
export const UNRESTRICTED_SCOPE_REQUIRED = "requires unrestricted subsidiary access";

/** An org-wide write attempted without unrestricted scope. Maps to 403. */
export class UnrestrictedScopeError extends Error {
  readonly status = 403;
  constructor() {
    super(UNRESTRICTED_SCOPE_REQUIRED);
    this.name = "UnrestrictedScopeError";
  }
}

/**
 * Shape (2): assert the caller holds unrestricted scope before an org-wide
 * policy or config write (provider configs, quotas, dunning policy, agent
 * runs, report classification, org-wide pricing setup). Only an explicit
 * null is unrestricted — an absent (undefined) scope fails closed, so a
 * caller that forgot to resolve the actor can never write org-wide policy.
 */
export function assertUnrestrictedScope(scope: ReadonlySet<string> | null | undefined): void {
  if (scope === null) return;
  throw new UnrestrictedScopeError();
}

/**
 * Not-found-shaped scope denial for locked writes and guarded lookups: the
 * row is missing, cross-org, or outside the caller's scope, and the caller
 * must not distinguish the three. Maps to 404 with the uniform body.
 */
export class ScopeNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super("not found");
    this.name = "ScopeNotFoundError";
  }
}

/**
 * Shape (4): permission-before-existence. Assert the caller holds ANY of the
 * family's permissions before the record is looked up; otherwise the uniform
 * not-found. A missing permission must never surface as a missing record
 * (which would confirm the record exists to an unauthorized caller), nor may
 * a missing record surface as a permission error (which would confirm the
 * permission check passed).
 */
export function assertAnyPermission(
  isGranted: (permission: string) => boolean,
  candidates: readonly string[],
): void {
  if (candidates.some((permission) => isGranted(permission))) return;
  throw new ScopeNotFoundError();
}

export interface LockedProjectScope {
  id: string;
  subsidiaryId: string | null;
}

export type ScopeRowKind = "party" | "project" | "document" | "account" | "department" | "employment";
export interface LockedScopeRow {
  id: string;
  subsidiaryId: string | null;
}

/** Lock one canonical scope-bearing row and authorize against its value while
 * the same lock is held. Row kinds map to their authoritative entity table;
 * customer and employee entities are represented by party/employment rows.
 * Callers lock multiple targets through lockScopeRows, which orders by kind
 * and id before acquiring locks. */
export async function lockScopeRow(
  tx: SqlExecutor,
  orgId: string,
  kind: ScopeRowKind,
  id: string,
  scope: ReadonlySet<string> | null,
  mode: "update" | "share" = "update",
  options: SubsidiaryScopeOptions = {},
): Promise<LockedScopeRow> {
  const lock = mode === "share" ? "for share" : "for update";
  const result = kind === "party"
    ? await tx.execute<{ id: string; subsidiaryId: string | null }>(sql`
        select p.id, p.subsidiary_id as "subsidiaryId" from parties p
         where p.org_id = ${orgId} and p.id = ${id} ${sql.raw(lock)} of p`)
    : kind === "project"
      ? await tx.execute<{ id: string; subsidiaryId: string | null }>(sql`
          select p.id, p.subsidiary_id as "subsidiaryId" from projects p
           where p.org_id = ${orgId} and p.id = ${id} ${sql.raw(lock)} of p`)
      : kind === "document"
        ? await tx.execute<{ id: string; subsidiaryId: string | null }>(sql`
            select d.id, d.subsidiary_id as "subsidiaryId" from documents d
             where d.org_id = ${orgId} and d.id = ${id} ${sql.raw(lock)} of d`)
        : kind === "account"
          ? await tx.execute<{ id: string; subsidiaryId: string | null }>(sql`
              select a.id, a.subsidiary_id as "subsidiaryId" from accounts a
               where a.org_id = ${orgId} and a.id = ${id} ${sql.raw(lock)} of a`)
          : kind === "department"
            ? await tx.execute<{ id: string; subsidiaryId: string | null }>(sql`
                select d.id, d.subsidiary_id as "subsidiaryId" from departments d
                 where d.org_id = ${orgId} and d.id = ${id} ${sql.raw(lock)} of d`)
            : await tx.execute<{ id: string; subsidiaryId: string | null }>(sql`
                select e.id, e.employer_subsidiary_id as "subsidiaryId" from worker_employments e
                 where e.org_id = ${orgId} and e.id = ${id} ${sql.raw(lock)} of e`);
  const row = result.rows[0];
  if (!row || !subsidiaryScopeAllows(scope, row.subsidiaryId, options)) throw new ScopeNotFoundError();
  return row;
}

/** Lock a set in one deterministic global order to avoid reverse-order
 * deadlocks when concurrent edits touch overlapping subsidiary targets. */
export async function lockScopeRows(
  tx: SqlExecutor,
  orgId: string,
  targets: readonly { kind: ScopeRowKind; id: string }[],
  scope: ReadonlySet<string> | null,
  mode: "update" | "share" = "update",
  options: SubsidiaryScopeOptions = {},
): Promise<readonly LockedScopeRow[]> {
  const ordered = [...new Map(targets.map((target) => [`${target.kind}:${target.id}`, target])).values()]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const rows: LockedScopeRow[] = [];
  for (const target of ordered) {
    rows.push(await lockScopeRow(tx, orgId, target.kind, target.id, scope, mode, options));
  }
  return rows;
}

/**
 * Shape (1), project instance: lock a project row and recheck the caller's
 * subsidiary scope inside the transaction, closing the rehome race where an
 * unlocked pre-read authorizes project A and a concurrent A→B reassignment
 * moves the write onto B before it commits. The scope predicate runs under
 * the row lock, so the check sees the latest committed subsidiary — never
 * the pre-read's stale one. Throws ScopeNotFoundError when the project is
 * missing, cross-org, or outside scope. Reads use 'share'; writes use
 * 'update' (the default).
 */
export async function lockProjectForScope(
  tx: SqlExecutor,
  orgId: string,
  projectId: string,
  scope: ReadonlySet<string> | null,
  mode: "update" | "share" = "update",
): Promise<LockedProjectScope> {
  return lockScopeRow(tx, orgId, "project", projectId, scope, mode);
}

/**
 * Shape (3): run multi-query reads in ONE REPEATABLE READ tenant
 * transaction, so every query sees the same committed state. Every query
 * inside `fn` must still carry the scope predicate (`subsidiaryVisibleFilter`
 * or a locked scope assertion above) — the snapshot pins the state, the
 * predicate enforces the visibility. Prefer this over sequences of pooled
 * reads whenever one response fans out (inbox facets, registers, party or
 * project bundles). Read-only: work that writes must use the writer's own
 * transaction, never this snapshot.
 */
export async function withScopeSnapshot<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return withOrgTransaction(orgId, fn, { isolationLevel: "REPEATABLE READ" });
}

export type DraftSubsidiaryResolution =
  | { ok: true; subsidiaryId: string | null }
  | { ok: false; error: "subsidiary_required" | "subsidiary_out_of_scope" };

/**
 * Draft-factory subsidiary rule: every draft or create factory takes the
 * actor's scope as a REQUIRED parameter and assigns an in-scope subsidiary —
 * the actor's single allowed one, or a required choice — never NULL or the
 * org root for a restricted actor, validated BEFORE any insert or numbering.
 * Unrestricted callers (explicit null) keep their requested subsidiary,
 * including an explicit null for the shared chart. A restricted caller naming
 * an out-of-scope subsidiary is refused by name; one that cannot be assigned
 * exactly one subsidiary (none, or several with no choice) is told to choose.
 * Both refusals are named, never silent nulls: a draft the actor's own reads
 * cannot observe must never be minted.
 */
export function resolveDraftSubsidiary(
  scope: ReadonlySet<string> | null,
  requested?: string | null,
): DraftSubsidiaryResolution {
  if (scope === null) return { ok: true, subsidiaryId: requested ?? null };
  if (requested !== null && requested !== undefined && requested !== "") {
    return scope.has(requested)
      ? { ok: true, subsidiaryId: requested }
      : { ok: false, error: "subsidiary_out_of_scope" };
  }
  if (scope.size === 1) {
    const only = [...scope][0];
    return only === undefined
      ? { ok: false, error: "subsidiary_required" }
      : { ok: true, subsidiaryId: only };
  }
  return { ok: false, error: "subsidiary_required" };
}
