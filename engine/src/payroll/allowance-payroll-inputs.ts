import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import { parseMoney, type Money } from "../money/brands.ts";
import { PayrollError } from "./error.ts";

export class AllowancePayrollInputError extends PayrollError {
  readonly code = "REFUSED";
}

export interface AllowancePayrollInput {
  readonly id: string;
  readonly entryKind: "per_diem" | "travel";
  readonly entryId: string;
  readonly employmentId: string;
  readonly employeePartyId: string;
  readonly payComponentId: string;
  readonly amount: Money;
  readonly currency: string;
  readonly coverageDate: string;
  readonly status: "pending" | "consumed";
  readonly consumedByRunDocumentId: string | null;
}

export interface AllowanceEarning {
  readonly id: string;
  readonly entryKind: AllowancePayrollInput["entryKind"];
  readonly payComponentId: string;
  readonly amount: Money;
  readonly coverageDate: string;
}

export function priceAllowancePayrollInputs(
  inputs: readonly AllowancePayrollInput[],
  payCurrency: string,
): AllowanceEarning[] {
  const currency = payCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AllowancePayrollInputError(
      "the pay run has no valid currency — set the payroll document currency and recalculate before paying approved allowances",
    );
  }
  return inputs.map((input) => {
    if (input.currency !== currency) {
      throw new AllowancePayrollInputError(
        `approved ${input.entryKind === "per_diem" ? "per-diem" : "travel-pay"} input ${input.id} is in ${input.currency}, but this pay run pays ${currency} — update the policy currency, then void, recompute and approve the entry again`,
      );
    }
    return {
      id: input.id,
      entryKind: input.entryKind,
      payComponentId: input.payComponentId,
      amount: input.amount,
      coverageDate: input.coverageDate,
    };
  });
}

const INPUT_COLUMNS = sql`id::text as id, entry_kind as "entryKind", entry_id::text as "entryId",
  employment_id::text as "employmentId", employee_party_id::text as "employeePartyId",
  pay_component_id::text as "payComponentId", amount::text as amount, currency,
  coverage_date::text as "coverageDate", status,
  consumed_by_run_document_id::text as "consumedByRunDocumentId"`;

function readInput(row: Record<string, unknown>): AllowancePayrollInput {
  const entryKind = String(row.entryKind);
  if (entryKind !== "per_diem" && entryKind !== "travel") {
    throw new AllowancePayrollInputError(
      `approved allowance input ${String(row.id)} has unsupported type ${JSON.stringify(row.entryKind)} — use a per-diem or travel-pay entry before calculating payroll`,
    );
  }
  const status = String(row.status);
  if (status !== "pending" && status !== "consumed") {
    throw new AllowancePayrollInputError(
      `approved allowance input ${String(row.id)} has unsupported status ${JSON.stringify(row.status)} — void or reapprove the source entry before calculating payroll`,
    );
  }
  const amount = parseMoney(row.amount);
  if (cmp(amount, "0") <= 0) {
    throw new AllowancePayrollInputError(
      `approved allowance input ${String(row.id)} is not a positive amount — correct the source entry before calculating payroll`,
    );
  }
  const currency = String(row.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AllowancePayrollInputError(
      `approved allowance input ${String(row.id)} has no valid currency — correct its per-diem or travel policy before calculating payroll`,
    );
  }
  return {
    id: String(row.id),
    entryKind,
    entryId: String(row.entryId),
    employmentId: String(row.employmentId),
    employeePartyId: String(row.employeePartyId),
    payComponentId: String(row.payComponentId),
    amount,
    currency,
    coverageDate: String(row.coverageDate).slice(0, 10),
    status,
    consumedByRunDocumentId:
      row.consumedByRunDocumentId == null ? null : String(row.consumedByRunDocumentId),
  };
}

export interface ConsumeAllowancePayrollInputsQuery {
  readonly orgId: string;
  readonly runDocumentId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly employeePartyId: string;
  readonly payCurrency: string;
  readonly simulate?: boolean;
}

/** Consume approved source amounts as ordinary component-backed earnings. */
export async function consumeAllowancePayrollInputs(
  exec: SqlExecutor,
  query: ConsumeAllowancePayrollInputsQuery,
): Promise<AllowancePayrollInput[]> {
  const { orgId, runDocumentId, periodStart, periodEnd, employeePartyId } = query;
  const payCurrency = query.payCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(payCurrency))
    throw new AllowancePayrollInputError(
      "the pay run has no valid currency — set the payroll document currency and recalculate before paying approved allowances",
    );
  const foreign = (
    await exec.execute<{ id: string; consumed_by_run_document_id: string }>(
      sql`
    select id::text as id, consumed_by_run_document_id::text as consumed_by_run_document_id
      from hrm_allowance_payroll_inputs
     where org_id = ${orgId} and employee_party_id = ${employeePartyId}
       and status = 'consumed' and consumed_by_run_document_id <> ${runDocumentId}
       and coverage_date between ${periodStart}::date and ${periodEnd}::date
     limit 1
  `,
      "objects",
    )
  )[0];
  if (foreign) {
    throw new AllowancePayrollInputError(
      `approved allowance input ${foreign.id} is already consumed by another pay run — release or void that run before recalculating this period`,
    );
  }
  const rows = await exec.execute<Record<string, unknown>>(
    sql`
    select ${INPUT_COLUMNS} from hrm_allowance_payroll_inputs
     where org_id = ${orgId} and employee_party_id = ${employeePartyId}
       and coverage_date between ${periodStart}::date and ${periodEnd}::date
       and (status = 'pending' ${
         query.simulate === true
           ? sql`or (status = 'consumed' and consumed_by_run_document_id = ${runDocumentId})`
           : sql``
       })
     order by coverage_date, entry_kind, id
  `,
    "objects",
  );
  const prepared: AllowancePayrollInput[] = [];
  for (const raw of rows) {
    const candidate = readInput(raw);
    const employment = (
      await exec.execute<{ worker_party_id: string }>(
        sql`
      select worker_party_id::text as worker_party_id from worker_employments
       where org_id = ${orgId} and id = ${candidate.employmentId}
    `,
        "objects",
      )
    )[0];
    if (!employment || employment.worker_party_id !== candidate.employeePartyId) {
      throw new AllowancePayrollInputError(
        `approved allowance input ${candidate.id} no longer matches its employment — void and reapprove the source entry after HR corrects the employment assignment`,
      );
    }
    const sourceTable =
      candidate.entryKind === "per_diem" ? "hrm_per_diem_entries" : "hrm_travel_pay_entries";
    const source = (
      await exec.execute<{ status: string }>(
        sql`
      select status from ${sql.identifier(sourceTable)}
       where org_id = ${orgId} and id = ${candidate.entryId}
       for share
    `,
        "objects",
      )
    )[0];
    if (source?.status !== "approved") {
      throw new AllowancePayrollInputError(
        `approved allowance input ${candidate.id} no longer has an approved source entry — correct or reapprove the per-diem or travel entry before calculating payroll`,
      );
    }
    const locked = (
      await exec.execute<Record<string, unknown>>(
        sql`
      select ${INPUT_COLUMNS} from hrm_allowance_payroll_inputs
       where org_id = ${orgId} and id = ${candidate.id} for update
    `,
        "objects",
      )
    )[0];
    if (!locked) {
      throw new AllowancePayrollInputError(
        `approved allowance input ${candidate.id} changed while payroll was calculating — recalculate the pay run`,
      );
    }
    const input = readInput(locked);
    if (
      input.entryId !== candidate.entryId ||
      input.entryKind !== candidate.entryKind ||
      (input.status !== "pending" &&
        !(
          query.simulate === true &&
          input.status === "consumed" &&
          input.consumedByRunDocumentId === runDocumentId
        ))
    ) {
      throw new AllowancePayrollInputError(
        `approved allowance input ${input.id} changed while payroll was calculating — recalculate the pay run`,
      );
    }
    const component = (
      await exec.execute<{ kind: string; is_active: boolean }>(
        sql`
      select kind, is_active from pay_components
       where org_id = ${orgId} and id = ${input.payComponentId}
       for share
    `,
        "objects",
      )
    )[0];
    if (!component?.is_active || component.kind !== "earning") {
      throw new AllowancePayrollInputError(
        `approved allowance input ${input.id} uses an inactive or non-earning component — choose an active earning component on its policy, then void, recompute and approve the entry`,
      );
    }
    prepared.push(input);
  }
  if (query.simulate === true) return prepared;
  for (const input of prepared) {
    const updated = (
      await exec.execute<{ id: string }>(
        sql`
      update hrm_allowance_payroll_inputs
         set status = 'consumed', consumed_by_run_document_id = ${runDocumentId}, updated_at = now()
       where org_id = ${orgId} and id = ${input.id} and status = 'pending'
      returning id::text as id
    `,
        "objects",
      )
    )[0];
    if (!updated) {
      throw new AllowancePayrollInputError(
        `approved allowance input ${input.id} changed while payroll was calculating — recalculate the pay run before committing`,
      );
    }
  }
  return prepared.map((input) => ({
    ...input,
    status: "consumed",
    consumedByRunDocumentId: runDocumentId,
  }));
}

export async function releaseAllowancePayrollInputs(
  exec: SqlExecutor,
  input: { orgId: string; runDocumentId: string },
): Promise<number> {
  const result = await exec.execute<{ n: string }>(
    sql`
    with released as (
      update hrm_allowance_payroll_inputs
         set status = 'pending', consumed_by_run_document_id = null, updated_at = now()
       where org_id = ${input.orgId} and consumed_by_run_document_id = ${input.runDocumentId}
         and status = 'consumed'
      returning id
    ) select count(*)::text as n from released
  `,
    "objects",
  );
  return Number(result[0]?.n ?? "0");
}

export async function lockAllowancePayrollInputSources(
  exec: SqlExecutor,
  orgId: string,
  runDocumentId: string,
): Promise<void> {
  for (const table of ["hrm_per_diem_entries", "hrm_travel_pay_entries"] as const) {
    await exec.execute(sql`
      select e.id from ${sql.identifier(table)} e
      join hrm_allowance_payroll_inputs i on i.org_id = e.org_id and i.entry_id = e.id
       where i.org_id = ${orgId} and i.consumed_by_run_document_id = ${runDocumentId}
         and i.entry_kind = ${table === "hrm_per_diem_entries" ? "per_diem" : "travel"}
       order by e.id for share of e
    `);
  }
  await exec.execute(sql`
    select id from hrm_allowance_payroll_inputs
     where org_id = ${orgId} and consumed_by_run_document_id = ${runDocumentId}
     order by id for share
  `);
  await exec.execute(sql`
    select c.id
      from hrm_allowance_payroll_inputs i
      join pay_components c on c.org_id = i.org_id and c.id = i.pay_component_id
     where i.org_id = ${orgId} and i.consumed_by_run_document_id = ${runDocumentId}
     order by i.id for share of c
  `);
}

export interface AllowancePayrollInputProblem {
  readonly code: "PENDING_ALLOWANCE_INPUTS" | "VOIDED_ALLOWANCE_INPUT";
  readonly message: string;
}

export async function allowancePayrollInputProblem(
  exec: SqlExecutor,
  query: {
    orgId: string;
    runDocumentId: string;
    periodStart: string;
    periodEnd: string;
    employeePartyIds: readonly string[];
  },
): Promise<AllowancePayrollInputProblem | null> {
  if (query.employeePartyIds.length === 0) return null;
  const scope = sql`employee_party_id in (
    select jsonb_array_elements_text(${JSON.stringify(query.employeePartyIds)}::jsonb)::uuid
  )`;
  const pending = (
    await exec.execute<{ id: string }>(
      sql`
    select id::text as id from hrm_allowance_payroll_inputs
     where org_id = ${query.orgId} and ${scope} and status = 'pending'
       and coverage_date between ${query.periodStart}::date and ${query.periodEnd}::date
     order by coverage_date, id limit 1
  `,
      "objects",
    )
  )[0];
  if (pending) {
    return {
      code: "PENDING_ALLOWANCE_INPUTS",
      message: `approved per-diem or travel-pay input ${pending.id} was not included in this calculation — recalculate the pay run before committing`,
    };
  }
  const voided = (
    await exec.execute<{ id: string }>(
      sql`
    select id::text as id from hrm_allowance_payroll_inputs
     where org_id = ${query.orgId} and ${scope} and status = 'voided'
       and consumed_by_run_document_id = ${query.runDocumentId}
       and coverage_date between ${query.periodStart}::date and ${query.periodEnd}::date
     order by coverage_date, id limit 1
  `,
      "objects",
    )
  )[0];
  return voided
    ? {
        code: "VOIDED_ALLOWANCE_INPUT",
        message: `approved allowance input ${voided.id} was voided after calculation — recalculate the pay run before committing`,
      }
    : null;
}
