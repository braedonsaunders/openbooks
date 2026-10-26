import { sql, type SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  lockScopeRow,
  ScopeNotFoundError,
  subsidiaryScopeAllows,
} from "../organization/subsidiary-scope.ts";
import type { FlowSubjectScope, FlowSubjectTableScope } from "./types.ts";

/**
 * The one interpreter of FlowSubjectAdapter.scope. Every flow surface that
 * needs a subject's legal entity (gate decisions, the approvals worklist,
 * record-state, manual buttons, run listings) resolves it here from the
 * adapter's declaration, so registering a kind gives it every scope arm.
 */

const SQL_IDENT = /^[a-z_][a-z0-9_]*$/;

/** A table-backed scope, its identifiers validated when the adapter is built. */
export function tableScope(
  via: FlowSubjectTableScope["via"],
  table: string,
  column: string,
): FlowSubjectTableScope {
  for (const name of [table, column]) {
    if (!SQL_IDENT.test(name))
      throw new Error(`flow subject scope: "${name}" is not a plain SQL identifier`);
  }
  return { via, table, column };
}

/**
 * A subject whose scope owner row does not exist. A ScopeNotFoundError, so
 * every surface still answers it as a missing record, but named so a log
 * says which subject failed to resolve.
 */
export class FlowSubjectScopeUnresolvedError extends ScopeNotFoundError {
  constructor(
    readonly subjectKind: string,
    readonly subjectId: string,
  ) {
    super();
    this.name = "FlowSubjectScopeUnresolvedError";
    this.message = `flow subject ${subjectKind} ${subjectId} has no scope owner row`;
  }
}

function unreachableScope(scope: never): never {
  throw new Error(`unhandled flow subject scope ${JSON.stringify(scope)}`);
}

/** Owner tables a party/project/employment scope inherits its subsidiary from. */
const OWNERS = {
  party: { table: sql`parties`, subsidiary: sql`o.subsidiary_id` },
  project: { table: sql`projects`, subsidiary: sql`o.subsidiary_id` },
  employment: { table: sql`worker_employments`, subsidiary: sql`o.employer_subsidiary_id` },
} as const satisfies Record<
  Exclude<FlowSubjectTableScope["via"], "column">,
  { table: SQL; subsidiary: SQL }
>;

/**
 * Owning subsidiary of each subject id, in one query. Ids with no row are
 * absent from the map; a subject with no provable owner maps to null so
 * restricted callers fail closed on it. `allowed` only matters to custom
 * scopes, whose visibility depends on the caller.
 */
export async function resolveSubjectSubsidiaries(
  orgId: string,
  subjectKind: string,
  scope: FlowSubjectScope,
  ids: readonly string[],
  allowed: ReadonlySet<string> | null,
): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const idList = sql`(select jsonb_array_elements_text(${JSON.stringify(unique)}::jsonb)::uuid)`;
  let query: SQL;
  switch (scope.via) {
    case "none":
      return new Map(unique.map((id) => [id, null]));
    case "custom":
      return scope.subsidiaryOf(orgId, unique, allowed, false);
    case "document":
      query = sql`select id, subsidiary_id as "subsidiaryId" from documents
         where org_id = ${orgId} and kind = ${subjectKind} and id in ${idList}`;
      break;
    case "column":
      query = sql`select id, ${sql.identifier(scope.column)} as "subsidiaryId" from ${sql.identifier(scope.table)}
         where org_id = ${orgId} and id in ${idList}`;
      break;
    case "party":
    case "project":
    case "employment": {
      const owner = OWNERS[scope.via];
      query = sql`select s.id, ${owner.subsidiary} as "subsidiaryId"
          from ${sql.identifier(scope.table)} s
          join ${owner.table} o on o.id = s.${sql.identifier(scope.column)} and o.org_id = s.org_id
         where s.org_id = ${orgId} and s.id in ${idList}`;
      break;
    }
    default:
      return unreachableScope(scope);
  }
  const rows = await db.execute<{ id: string; subsidiaryId: string | null }>(query, "objects");
  return new Map(rows.map((row) => [row.id, row.subsidiaryId]));
}

/**
 * SQL for the owning subsidiary of the subject a row names (a flow run or a
 * gate), from each registered kind's declared scope, for surfaces that page
 * in SQL and so cannot resolve entities after the page. Matches
 * resolveSubjectSubsidiaries kind by kind; custom and org-wide scopes yield
 * null, so restricted callers fail closed on them.
 */
export function subjectSubsidiarySql(
  kinds: ReadonlyArray<{ subjectKind: string; scope: FlowSubjectScope }>,
  ref: { kind: SQL; id: SQL; org: SQL },
): SQL {
  const arms = kinds.flatMap(({ subjectKind, scope }): SQL[] => {
    switch (scope.via) {
      case "document":
        return [
          sql`when ${ref.kind} = ${subjectKind} then (select o.subsidiary_id from documents o where o.org_id = ${ref.org} and o.id = ${ref.id})`,
        ];
      case "column":
        return [
          sql`when ${ref.kind} = ${subjectKind} then (select o.${sql.identifier(scope.column)} from ${sql.identifier(scope.table)} o where o.org_id = ${ref.org} and o.id = ${ref.id})`,
        ];
      case "party":
      case "project":
      case "employment": {
        const owner = OWNERS[scope.via];
        return [
          sql`when ${ref.kind} = ${subjectKind} then (select ${owner.subsidiary} from ${sql.identifier(scope.table)} s
          join ${owner.table} o on o.id = s.${sql.identifier(scope.column)} and o.org_id = s.org_id
         where s.org_id = ${ref.org} and s.id = ${ref.id})`,
        ];
      }
      case "custom":
      case "none":
        return [];
      default:
        return unreachableScope(scope);
    }
  });
  return arms.length > 0 ? sql`(case ${sql.join(arms, sql` `)} end)` : sql`null::uuid`;
}

/**
 * Share-lock a subject's canonical scope owner for the rest of the caller's
 * transaction. Throws ScopeNotFoundError when out of the caller's scope and
 * FlowSubjectScopeUnresolvedError when the subject row is missing.
 */
export async function lockSubjectScope(
  orgId: string,
  subjectKind: string,
  scope: FlowSubjectScope,
  subjectId: string,
  allowed: ReadonlySet<string> | null,
): Promise<void> {
  switch (scope.via) {
    case "document":
      await lockScopeRow(db, orgId, "document", subjectId, allowed, "share");
      return;
    case "none":
      // Org-wide subjects have no subsidiary owner: restricted readers fail
      // closed, exactly as the unlocked resolver answers them.
      if (allowed !== null) throw new ScopeNotFoundError();
      return;
    case "column":
    case "custom": {
      const owners =
        scope.via === "custom"
          ? await scope.subsidiaryOf(orgId, [subjectId], allowed, true)
          : new Map(
              (
                await db.execute<{ subsidiaryId: string | null }>(
                  sql`
            select ${sql.identifier(scope.column)} as "subsidiaryId" from ${sql.identifier(scope.table)}
             where id = ${subjectId} and org_id = ${orgId}
             for share
          `,
                  "objects",
                )
              ).map((row) => [subjectId, row.subsidiaryId]),
            );
      if (!owners.has(subjectId)) throw new FlowSubjectScopeUnresolvedError(subjectKind, subjectId);
      if (!subsidiaryScopeAllows(allowed, owners.get(subjectId))) throw new ScopeNotFoundError();
      return;
    }
    case "party":
    case "project":
    case "employment": {
      // Lock the REFERRING subject row as well as the owner: the link
      // column lives on the subject, so locking only the owner would let a
      // concurrent relink move the subject to another owner (and another
      // legal entity) while the owner's own row stays frozen. The share
      // lock on the subject row holds the relationship itself until the
      // caller's transaction ends; the owner id is then read from the
      // locked row, and the owner's share lock freezes its subsidiary.
      const row = (
        await db.execute<{ ownerId: string }>(
          sql`
        select ${sql.identifier(scope.column)} as "ownerId" from ${sql.identifier(scope.table)}
         where id = ${subjectId} and org_id = ${orgId}
         for share
      `,
          "objects",
        )
      )[0];
      if (!row) throw new FlowSubjectScopeUnresolvedError(subjectKind, subjectId);
      await lockScopeRow(db, orgId, scope.via, row.ownerId, allowed, "share");
      return;
    }
    default:
      unreachableScope(scope);
  }
}
