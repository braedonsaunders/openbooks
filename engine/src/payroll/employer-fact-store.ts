import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, inDbTransaction } from "../platform/db.ts";
import { employerFact, isValidEmployerFactEffectiveDate, resolveEmployerFact } from "./employer-facts.ts";
import { PayrollPackError } from "./payroll-error.ts";

export type StoredPayrollEmployerFact = Record<string, unknown> & {
  id: string;
  subsidiaryId: string;
  country: string;
  factKey: string;
  effectiveFrom: string;
  effectiveThrough: string | null;
  valueKind: string;
  factValue: string;
  valueScale: number | null;
  changeReason: string;
  createdAt: string;
  createdBy: string | null;
};

export async function listPayrollEmployerFacts(
  orgId: string,
  input: { country?: string; subsidiaryId?: string } = {},
): Promise<StoredPayrollEmployerFact[]> {
  const rows = await db.execute<StoredPayrollEmployerFact>(sql`
    select id, subsidiary_id as "subsidiaryId", country, fact_key as "factKey",
           effective_from::text as "effectiveFrom",
           case when superseded_on is null then null else (superseded_on - 1)::text end as "effectiveThrough",
           value_kind as "valueKind",
           fact_value as "factValue", value_scale as "valueScale",
           change_reason as "changeReason", created_at::text as "createdAt",
           created_by as "createdBy"
      from payroll_employer_facts
     where org_id = ${orgId}
       and (superseded_on is null or superseded_on > CURRENT_DATE)
       and (${input.country ?? null}::text is null or country = ${input.country ?? null})
       and (${input.subsidiaryId ?? null}::uuid is null or subsidiary_id = ${input.subsidiaryId ?? null}::uuid)
     order by country, fact_key, effective_from desc
  `);
  return rows.rows;
}

/** Resolve one fact only for the exact legal employer and effective date. */
export async function resolveStoredEmployerFact(input: {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  subsidiaryId: string | null;
  country: string;
  factKey: string;
  asOf: string;
}): Promise<string | null> {
  const row = (await input.tx.execute<{ fact_value: string }>(sql`
    select fact_value
      from payroll_employer_facts
     where org_id = ${input.orgId}
       and subsidiary_id is not distinct from ${input.subsidiaryId}::uuid
       and country = ${input.country}
       and fact_key = ${input.factKey}
       and effective_from <= ${input.asOf}::date
       and (superseded_on is null or superseded_on > ${input.asOf}::date)
     order by effective_from desc, superseded_on asc nulls last
     limit 1
  `)).rows[0];
  return resolveEmployerFact(input.country, input.factKey, row?.fact_value);
}

/** Supersede the same effective point and append a fully audited successor. */
export async function upsertPayrollEmployerFact(input: {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  country: string;
  factKey: string;
  effectiveFrom: string;
  effectiveThrough?: string | null;
  value: string;
  changeReason: string;
}): Promise<StoredPayrollEmployerFact> {
  if (!isValidEmployerFactEffectiveDate(input.effectiveFrom)) {
    throw new PayrollPackError("employer fact effective date must be a real ISO calendar date");
  }
  const reason = input.changeReason.trim();
  if (!reason || reason.length > 500) {
    throw new PayrollPackError("employer fact change reason is required and limited to 500 characters");
  }
  const declaration = employerFact(input.country, input.factKey);
  // Values naming an authority-approved span (the Utah waiver's "approved")
  // require the inclusive final date up front: an open-ended approval would
  // suppress withholding past its authorization. Filing-account scoping is
  // out of scope here — this write is always for one legal employer.
  const value = resolveEmployerFact(input.country, input.factKey, input.value);
  if (value == null) throw new PayrollPackError(`${declaration.label} must have a value`);
  const needsEndDate = declaration.effectiveThroughRequiredFor?.includes(value) ?? false;
  if (needsEndDate && !input.effectiveThrough) {
    throw new PayrollPackError(`${declaration.label} must include the inclusive final date approved by the authority`);
  }
  if (input.effectiveThrough && !isValidEmployerFactEffectiveDate(input.effectiveThrough)) {
    throw new PayrollPackError("employer fact effective-through date must be a real ISO calendar date");
  }
  if (input.effectiveThrough && input.effectiveThrough < input.effectiveFrom) {
    throw new PayrollPackError("employer fact effective-through date cannot precede its effective-from date");
  }
  if (declaration.effectivePeriod === "calendar_year" && !/^\d{4}-01-01$/.test(input.effectiveFrom)) {
    throw new PayrollPackError(`${declaration.label} is effective by calendar year; use January 1 of the applicable year`);
  }
  const id = randomUUID();
  const lockKey = [input.orgId, input.subsidiaryId ?? "", input.country, input.factKey, input.effectiveFrom].join("\u001f");
  return await inDbTransaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const before = (await tx.execute<{ id: string; fact_value: string; change_reason: string; effective_through: string | null }>(sql`
      select id, fact_value, change_reason,
             case when superseded_on is null then null else (superseded_on - 1)::text end as effective_through
        from payroll_employer_facts
       where org_id = ${input.orgId}
         and subsidiary_id is not distinct from ${input.subsidiaryId}::uuid
         and country = ${input.country} and fact_key = ${input.factKey}
         and effective_from = ${input.effectiveFrom}::date
         and (superseded_on is null or superseded_on > CURRENT_DATE)
       for update
    `)).rows[0];
    if (before) {
      const changed = await tx.execute(sql`
        update payroll_employer_facts
           set superseded_on = greatest(CURRENT_DATE, effective_from), updated_by = ${input.actorId}, updated_at = now()
         where org_id = ${input.orgId} and id = ${before.id}
           and (superseded_on is null or superseded_on > CURRENT_DATE)
      `);
      if ((changed.rowCount ?? 0) !== 1) {
        throw new PayrollPackError(`${declaration.label} was not saved because its current value changed concurrently`);
      }
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${input.orgId}, 'payroll_employer_facts', ${before.id}, 'supersede',
          ${JSON.stringify({
            country: input.country, factKey: input.factKey, subsidiaryId: input.subsidiaryId,
            effectiveFrom: input.effectiveFrom,
            effectiveThrough: before.effective_through,
            before: before.fact_value, after: value, reason,
          })}::jsonb, ${input.actorId})
      `);
    }
    const inserted = await tx.execute<StoredPayrollEmployerFact>(sql`
      insert into payroll_employer_facts
        (id, org_id, subsidiary_id, country, fact_key, effective_from,
         value_kind, fact_value, value_scale, superseded_on, change_reason, created_by, updated_by)
      values (${id}, ${input.orgId}, ${input.subsidiaryId}::uuid, ${input.country},
        ${input.factKey}, ${input.effectiveFrom}::date, ${declaration.kind}, ${value},
        ${declaration.kind === "decimal" ? declaration.scale! : null},
        case when ${input.effectiveThrough ?? null}::date is null then null else ${input.effectiveThrough ?? null}::date + 1 end,
        ${reason},
        ${input.actorId}, ${input.actorId})
      returning id, subsidiary_id as "subsidiaryId", country, fact_key as "factKey",
        effective_from::text as "effectiveFrom",
        case when superseded_on is null then null else (superseded_on - 1)::text end as "effectiveThrough",
        value_kind as "valueKind",
        fact_value as "factValue", value_scale as "valueScale",
        change_reason as "changeReason", created_at::text as "createdAt",
        created_by as "createdBy"
    `);
    const row = inserted.rows[0];
    if (!row) throw new PayrollPackError(`${declaration.label} was not saved — insert returned no row`);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${input.orgId}, 'payroll_employer_facts', ${id}, 'insert',
        ${JSON.stringify({
          country: input.country, factKey: input.factKey, subsidiaryId: input.subsidiaryId,
          effectiveFrom: input.effectiveFrom, effectiveThrough: input.effectiveThrough ?? null,
          before: before?.fact_value ?? null,
          after: value, reason,
        })}::jsonb, ${input.actorId})
    `);
    return row;
  });
}
