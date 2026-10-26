import { BenefitsError } from "./errors.ts";
import { requireCivilDate, requireOneRow, sql, type SqlExecutor } from "./shared.ts";
import type { BenefitTransactionPolicy } from "./transaction-policy.ts";

/**
 * Dated revisions of an active benefit program. Editing an active program
 * keeps the rules it replaces: each revision stores the complete prior
 * policy (program row, measure scopes, source accounts and transaction
 * rules) with the date the change applies from. A period that starts before
 * that date measures under the prior policy, so a change never reinterprets
 * an earlier period, and settled awards keep the rules they were measured
 * under. Memberships are already dated and are not part of a revision.
 */

export interface ProgramRevisionSnapshot {
  /** The program row as stored before the change (column names). */
  readonly program: Record<string, unknown>;
  readonly scopes: ReadonlyArray<{
    department_id: string | null;
    project_id: string | null;
    customer_id: string | null;
    excluded: boolean;
  }>;
  readonly sources: ReadonlyArray<{ accountId: string; weightBps: number | null }>;
  readonly transactionPolicy: BenefitTransactionPolicy | null;
}

export interface ProgramRevisionInForce {
  readonly revisionId: string;
  /** The change date: the snapshot governs periods starting before it. */
  readonly changeEffectiveFrom: string;
  readonly snapshot: ProgramRevisionSnapshot;
}

/**
 * Record the policy being replaced, before the active program or its
 * transaction rules change in the same transaction. The database admits an
 * active-program edit only alongside a revision row written by the same
 * transaction. The caller holds the program row lock.
 */
export async function recordProgramRevision(
  exec: SqlExecutor,
  query: {
    readonly orgId: string;
    readonly actorId: string;
    readonly programId: string;
    readonly changeEffectiveFrom: unknown;
    readonly reason: string;
    readonly transactionPolicy: BenefitTransactionPolicy | null;
  },
): Promise<string> {
  const { orgId, actorId, programId } = query;
  if (
    query.changeEffectiveFrom === undefined ||
    query.changeEffectiveFrom === null ||
    query.changeEffectiveFrom === ""
  ) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "changing an active program needs the date the change applies from — earlier periods keep the current rules",
    );
  }
  const changeEffectiveFrom = requireCivilDate(query.changeEffectiveFrom, "changeEffectiveFrom");
  const program = requireOneRow(
    await exec.execute<{
      row: Record<string, unknown>;
      effective_from: string;
      effective_to: string | null;
      status: string;
    }>(
      sql`
    select to_jsonb(p) as row, p.effective_from::text as effective_from, p.effective_to::text as effective_to, p.status
      from hrm_benefit_programs p where p.org_id = ${orgId} and p.id = ${programId}
  `,
      "objects",
    ),
    "reading the program being revised",
  );
  if (program.status !== "active") {
    throw new BenefitsError(
      "BAD_STATE",
      `program is ${program.status} — only an active program is revised; drafts edit in place and closed programs keep their history`,
    );
  }
  if (changeEffectiveFrom < program.effective_from) {
    throw new BenefitsError(
      "REFUSED",
      `the change date ${changeEffectiveFrom} precedes the program start ${program.effective_from} — choose a date inside the program window`,
    );
  }
  if (program.effective_to !== null && changeEffectiveFrom > program.effective_to) {
    throw new BenefitsError(
      "REFUSED",
      `the change date ${changeEffectiveFrom} is after the program end ${program.effective_to} — choose a date inside the program window`,
    );
  }
  // Settled awards keep the rules they were measured under; a change cannot
  // reach back into a period that already settled.
  const settledThrough =
    (
      await exec.execute<{ through: string | null }>(
        sql`
    select max(coalesce(period_to, period_from))::text as through from hrm_benefit_awards
     where org_id = ${orgId} and program_id = ${programId} and status <> 'voided'
  `,
        "objects",
      )
    )[0]?.through ?? null;
  if (settledThrough !== null && changeEffectiveFrom <= settledThrough) {
    throw new BenefitsError(
      "REFUSED",
      `awards are already recorded through ${settledThrough} — choose a change date after ${settledThrough}; recorded awards keep the rules they were measured under`,
    );
  }
  const latest =
    (
      await exec.execute<{ effective_from: string }>(
        sql`
    select max(effective_from)::text as effective_from from hrm_benefit_program_revisions
     where org_id = ${orgId} and program_id = ${programId}
  `,
        "objects",
      )
    )[0]?.effective_from ?? null;
  if (latest !== null && changeEffectiveFrom < latest) {
    throw new BenefitsError(
      "REFUSED",
      `the program already changes on ${latest} — choose a change date on or after ${latest}; revisions apply in date order`,
    );
  }
  const scopes = await exec.execute<
    ProgramRevisionSnapshot["scopes"][number] & Record<string, unknown>
  >(
    sql`
    select department_id, project_id, customer_id, excluded from hrm_benefit_program_scopes
     where org_id = ${orgId} and program_id = ${programId}
     order by department_id, project_id, customer_id
  `,
    "objects",
  );
  const sources = await exec.execute<{ accountId: string; weightBps: number | null }>(
    sql`
    select account_id as "accountId", weight_bps as "weightBps" from hrm_benefit_program_sources
     where org_id = ${orgId} and program_id = ${programId}
     order by account_id
  `,
    "objects",
  );
  const snapshot: ProgramRevisionSnapshot = {
    program: program.row,
    scopes,
    sources,
    transactionPolicy: query.transactionPolicy,
  };
  return requireOneRow(
    await exec.execute<{ id: string }>(
      sql`
    insert into hrm_benefit_program_revisions (org_id, program_id, effective_from, prior_policy, reason, created_by)
    values (${orgId}, ${programId}, ${changeEffectiveFrom}::date, ${JSON.stringify(snapshot)}::jsonb, ${query.reason}, ${actorId})
    returning id
  `,
      "objects",
    ),
    "recording the program revision",
  ).id;
}

/**
 * The prior policy governing a period, or null when the current rules do.
 * A period that a change date falls inside refuses: it would be measured
 * half under each set of rules.
 */
export async function programRevisionInForce(
  exec: SqlExecutor,
  orgId: string,
  programId: string,
  periodFrom: string,
  periodTo: string,
): Promise<ProgramRevisionInForce | null> {
  const revisions = await exec.execute<{
    id: string;
    effective_from: string;
    prior_policy: ProgramRevisionSnapshot;
  }>(
    sql`
    select id, effective_from::text as effective_from, prior_policy from hrm_benefit_program_revisions
     where org_id = ${orgId} and program_id = ${programId}
     order by effective_from, created_at, id
  `,
    "objects",
  );
  const inside = revisions.find(
    (r) => r.effective_from > periodFrom && r.effective_from <= periodTo,
  );
  if (inside) {
    throw new BenefitsError(
      "REFUSED",
      `the program rules change on ${inside.effective_from}, inside ${periodFrom}..${periodTo} — settle the days before ${inside.effective_from} and the days from it as separate periods`,
    );
  }
  const governing = revisions.find((r) => r.effective_from > periodFrom);
  return governing
    ? {
        revisionId: governing.id,
        changeEffectiveFrom: governing.effective_from,
        snapshot: governing.prior_policy,
      }
    : null;
}
