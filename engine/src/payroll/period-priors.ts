import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add } from "../money/money.ts";
import { PayrollError } from "./error.ts";
import { PERIODIC_RUN_TYPES } from "./run-contracts.ts";
import type { PayrollCountryPack, SupplementalTaxMethod } from "./pack-types.ts";

/**
 * Period-to-date priors for same-period runs.
 *
 * A supplemental run pays inside an already-open period, so the period's
 * statutory shares must be computed on the period-to-date total across the
 * period's runs — minus what earlier runs already withheld — rather than once
 * per run. The generic layer owns the sequencing and the bookkeeping (which
 * runs belong to the period, in what order, what they paid); the country pack
 * decides how each statutory item uses the priors, through its declared
 * `supplementalPayTreatment`.
 */

/** One employee's period-to-date figures from earlier runs of the same period. */
export interface PayPeriodPriors {
  /** Sum of `pensionable_earnings` over the employee's earlier period stubs. */
  pensionable: string;
  /** Sum of `insurable_earnings` over the employee's earlier period stubs. */
  insurable: string;
  /**
   * Every stub factor key summed over the employee's earlier period stubs
   * (C, C2, EI, QPIP, I, B, F, F3, F5B, …). The generic layer transports;
   * each pack reads the keys its own engine traced.
   */
  factors: Record<string, string>;
  /**
   * Earlier period stub-line amounts grouped by the line component's
   * `system_key` (income_tax, cpp, ei, …). The pack's declared income-tax
   * keys select the "tax already withheld in the period" the cumulative
   * method subtracts.
   */
  withheldBySystemKey: Record<string, string>;
}

export const EMPTY_PERIOD_PRIORS: PayPeriodPriors = {
  pensionable: "0",
  insurable: "0",
  factors: {},
  withheldBySystemKey: {},
};

export function periodPriorsEmpty(priors: PayPeriodPriors): boolean {
  return priors.pensionable === "0"
    && priors.insurable === "0"
    && Object.keys(priors.factors).length === 0
    && Object.keys(priors.withheldBySystemKey).length === 0;
}

type PeriodSibling = {
  document_id: string;
  document_number: string;
  run_type: string;
  run_status: string;
  doc_status: string;
  pay_date: string;
  created_at: string;
};

type PeriodRunIdentity = {
  documentId: string;
  documentNumber: string;
  payScheduleId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  createdAt: string;
  runType: string;
};

/**
 * Build the sequencing identity from a `select r.*` run row. A row missing
 * its period or schedule identity cannot sequence and must not calculate —
 * defaulting it would attach the wrong priors.
 */
export function periodRunIdentity(
  run: Record<string, string | undefined>,
  ref: { documentId: string; documentNumber?: string; runType: string },
): PeriodRunIdentity {
  const payScheduleId = run.pay_schedule_id;
  const periodStart = run.period_start;
  const periodEnd = run.period_end;
  const payDate = run.pay_date;
  const createdAt = run.created_at;
  if (!payScheduleId || !periodStart || !periodEnd || !payDate || !createdAt) {
    throw new PayrollError("pay run not found");
  }
  return {
    documentId: ref.documentId,
    documentNumber: ref.documentNumber ?? ref.documentId,
    payScheduleId, periodStart, periodEnd, payDate, createdAt,
    runType: ref.runType,
  };
}

/**
 * Every live periodic run on the schedule whose period overlaps this run's,
 * in period sequence (pay date, then creation, then document number — all
 * three are needed: same-day runs and same-instant creations must still order
 * deterministically). Bonus, termination, and retro runs are taxed with the
 * non-periodic method and never share the period basis, so they are not
 * siblings. Voided runs are history, not priors.
 */
export async function listPeriodSiblings(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  run: PeriodRunIdentity,
): Promise<PeriodSibling[]> {
  const rows = (await tx.execute<PeriodSibling>(sql`
    select r.document_id::text as document_id, d.document_number,
           r.run_type, r.run_status, d.status as doc_status,
           r.pay_date::text as pay_date, r.created_at::text as created_at
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId}
       and r.pay_schedule_id = ${run.payScheduleId}
       and r.run_type = any(${`{${[...PERIODIC_RUN_TYPES].join(",")}}`}::text[])
       and r.period_start <= ${run.periodEnd}
       and r.period_end >= ${run.periodStart}
       and r.run_status <> 'voided'
       and d.status <> 'voided'
     order by r.pay_date, r.created_at, d.document_number
  `));
  return rows.rows;
}

/**
 * The period must be built in sequence: a run may only calculate (or commit)
 * when every earlier run of the period is already committed, and no later run
 * of the period is. An earlier draft would withhold after this run and apply
 * the period's exemptions twice; a later committed run was computed without
 * this run's share and is now stale. Both refuse by name with the remedy.
 */
export async function assertPeriodSequence(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  run: PeriodRunIdentity,
  phase: "calculate" | "commit",
): Promise<PeriodSibling[]> {
  const siblings = await listPeriodSiblings(tx, orgId, run);
  const selfIndex = siblings.findIndex((s) => s.document_id === run.documentId);
  // The run always reads itself back: anything else means it is voided (the
  // listing excludes voided runs) or concurrently gone, and neither state may
  // calculate. Under RLS an unscoped read silently matches nothing, so a
  // missing row is a failure, never an empty period.
  if (selfIndex < 0) throw new PayrollError("pay run not found");
  const verb = phase === "calculate" ? "be calculated" : "be committed";
  for (const earlier of siblings.slice(0, selfIndex)) {
    if (earlier.run_status !== "committed") {
      throw new PayrollError(
        `pay run ${run.documentNumber} cannot ${verb} while ${earlier.document_number} `
        + `(${earlier.run_type}) for the same period is still ${earlier.run_status} — `
        + `commit ${earlier.document_number} first (or discard it), so the period builds in pay-date order`,
      );
    }
  }
  for (const later of siblings.slice(selfIndex + 1)) {
    if (later.run_status === "committed") {
      throw new PayrollError(
        `pay run ${run.documentNumber} cannot ${verb} — ${later.document_number} `
        + `(${later.run_type}) for the same period is already committed and was computed without this run's share — `
        + `void ${later.document_number} and re-process the period in pay-date order`,
      );
    }
  }
  return siblings;
}

/**
 * This run's period-to-date priors, per employee, from the committed earlier
 * runs of the period (in period sequence). Draft and calculated runs withheld
 * nothing, so they contribute nothing; the sequence guard above refuses to
 * calculate while an earlier run is still in those states.
 */
export async function loadPeriodPriors(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  siblings: PeriodSibling[],
  documentId: string,
): Promise<Map<string, PayPeriodPriors>> {
  const selfIndex = siblings.findIndex((s) => s.document_id === documentId);
  const earlier = siblings.slice(0, selfIndex < 0 ? 0 : selfIndex)
    .filter((s) => s.run_status === "committed")
    .map((s) => s.document_id);
  const priors = new Map<string, PayPeriodPriors>();
  if (earlier.length === 0) return priors;
  const byEmployee = (await tx.execute<{
    employee_party_id: string;
    pensionable: string;
    insurable: string;
    factors: Record<string, string | number> | null;
  }>(sql`
    select s.employee_party_id::text as employee_party_id,
           sum(s.pensionable_earnings)::text as pensionable,
           sum(s.insurable_earnings)::text as insurable,
           jsonb_object_agg(s.pay_run_document_id::text, s.factors) as factors
      from pay_stubs s
     where s.org_id = ${orgId}
       and s.pay_run_document_id = any(${`{${earlier.join(",")}}`}::uuid[])
     group by s.employee_party_id
  `));
  // Factors arrive per stub (one JSON object per earlier run) and sum in
  // application code: the key set is the pack's own trace vocabulary, which
  // SQL must not enumerate.
  const stubFactors = new Map<string, Record<string, string>[]>();
  for (const row of byEmployee.rows) {
    const perStub = Object.values(
      (row.factors ?? {}) as unknown as Record<string, Record<string, string | number>>,
    );
    stubFactors.set(row.employee_party_id, perStub.map((factors) =>
      Object.fromEntries(Object.entries(factors ?? {}).map(([key, value]) => [key, String(value)]))));
  }
  const withheld = (await tx.execute<{
    employee_party_id: string;
    system_key: string;
    amount: string;
  }>(sql`
    select s.employee_party_id::text as employee_party_id,
           c.system_key,
           sum(l.amount)::text as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where l.org_id = ${orgId}
       and s.pay_run_document_id = any(${`{${earlier.join(",")}}`}::uuid[])
       and c.system_key is not null
     group by s.employee_party_id, c.system_key
  `));
  const withheldByEmployee = new Map<string, Record<string, string>>();
  for (const row of withheld.rows) {
    const entry = withheldByEmployee.get(row.employee_party_id) ?? {};
    entry[row.system_key] = row.amount;
    withheldByEmployee.set(row.employee_party_id, entry);
  }
  for (const row of byEmployee.rows) {
    const factors: Record<string, string> = {};
    for (const perStub of stubFactors.get(row.employee_party_id) ?? []) {
      for (const [key, value] of Object.entries(perStub)) {
        factors[key] = factors[key] === undefined ? value : add(factors[key]!, value);
      }
    }
    priors.set(row.employee_party_id, {
      pensionable: row.pensionable,
      insurable: row.insurable,
      factors,
      withheldBySystemKey: withheldByEmployee.get(row.employee_party_id) ?? {},
    });
  }
  // An employee whose earlier stubs carried only withheld lines (no stub
  // row is impossible — lines hang off stubs), so every withheld entry has a
  // stub row above. Nothing to merge here.
  return priors;
}

/**
 * The pack must declare how a supplemental-period share is taxed before the
 * generic layer can compute one: the declaration names the tax methods the
 * pack implements and the withheld system keys each one subtracts. A pack
 * that declares nothing has not answered the question, and its runs refuse
 * rather than apply another pack's answer.
 */
export function assertSupplementalSupported(
  pack: PayrollCountryPack,
  country: string,
  runType: string,
  hasPriors: boolean,
): void {
  if (runType !== "supplemental" && !hasPriors) return;
  if (!pack.supplementalPayTreatment) {
    throw new PayrollError(
      `supplemental-period payroll is not supported for ${country} — the payroll pack `
      + "does not declare supplemental-period treatment",
    );
  }
}

/**
 * The org's supplemental income-tax method (orgs.settings.payroll.
 * supplementalTaxMethod): `period_cumulative` taxes the period-to-date income
 * as one periodic pay minus tax already withheld in the period;
 * `per_run` taxes each run's pay standalone with the periodic method.
 * Unset means the pack's default — stated in the setting's help text, not
 * guessed here. A stored value the pack does not
 * declare refuses by name rather than silently running the other method.
 */
export async function supplementalTaxMethodForOrg(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  pack: PayrollCountryPack,
): Promise<SupplementalTaxMethod> {
  const treatment = pack.supplementalPayTreatment!;
  const stored = (await tx.execute<{ method: string | null }>(sql`
    select settings#>>'{payroll,supplementalTaxMethod}' as method from orgs where id = ${orgId}
  `)).rows[0]?.method ?? null;
  if (stored == null || stored === "") return treatment.defaultTaxMethod;
  if (!(treatment.taxMethods as readonly string[]).includes(stored)) {
    throw new PayrollError(
      `unknown supplemental tax method "${stored}" — choose one of ${treatment.taxMethods.join(", ")} `
      + "in payroll settings",
    );
  }
  return stored as SupplementalTaxMethod;
}
