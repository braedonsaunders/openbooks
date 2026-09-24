import { sql } from "drizzle-orm";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../../organization/actor-subsidiaries.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import {
  HrmAuthorizationError,
  loadOwnEmploymentIds,
  requireHrmEmploymentRead,
  requireHrmSelfRead,
} from "../authorization.ts";
import { AiRailsError, aiSubjectRefused } from "./errors.ts";
import { logDecision } from "./governance.ts";

/**
 * HRM AI rails (HR-21) explain-pay: a DETERMINISTIC payslip trace. The
 * service assembles gross by component with the input that produced it
 * (hours × rate from stub lines, benefit/leave input rows, the wage rate
 * effective date), every deduction with its component's declared
 * treatment, employer contributions, net, plus a DIFF against the
 * previous stub naming which components changed and the input behind
 * the change. The assistant tool renders this trace in prose citing the
 * record ids; the trace is what the tests assert — prose is never the
 * evidence.
 *
 * Reads only through the payroll stub tables under the actor's scope:
 * own stubs through hrm.self.read, any stub through payroll.manage (or
 * hrm.employment.read for HR readers) GATED on the employment's employer
 * subsidiary — a grant alone never opens another entity's pay. Unknown,
 * cross-org, and out-of-scope employments refuse identically as
 * ai_subject_missing. Explaining another person's pay without a grant
 * refuses with the remedy.
 */

export interface ExplainPayLine {
  id: string;
  componentId: string | null;
  kind: string;
  description: string;
  hours: string | null;
  rate: string | null;
  amount: string;
  treatment: string | null;
}

export interface ExplainPayTrace {
  stubId: string;
  employmentId: string;
  payRunDocumentId: string;
  payDate: string;
  gross: string;
  netPay: string;
  employerCost: string;
  earnings: ExplainPayLine[];
  deductions: ExplainPayLine[];
  employerContributions: ExplainPayLine[];
  benefitInputs: { id: string; kind: string; amount: string; coverageFrom: string; coverageTo: string; status: string }[];
  leaveInputs: { id: string; kind: string; hours: string; absenceDate: string; status: string }[];
  wageRates: { id: string; rate: string; basis: string; effectiveFrom: string; effectiveTo: string | null }[];
  diffVsPrevious: {
    previousStubId: string | null;
    previousPayDate: string | null;
    changes: { description: string; previousAmount: string | null; amount: string | null; input: string }[];
  };
  sources: { kind: string; id: string }[];
}

type StubRow = {
  id: string;
  employmentId: string | null;
  payRunDocumentId: string;
  payDate: string;
  gross: string;
  netPay: string;
  employerCost: string;
}

async function assertExplainFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, "hrmExplainPay"))) {
    throw new AiRailsError(
      "ai_feature_off",
      "pay explanations are unavailable while hrmExplainPay is off — enable it under Company Settings → Features; existing payslips are unchanged",
    );
  }
}

/**
 * Uniform employment denial for the elevated paths: an unknown id, a
 * cross-org id, and an out-of-scope employment share one code and one
 * message, so a subsidiary-restricted actor probing a B employment learns
 * nothing a fabricated id would not teach. The ai_subject_missing shape
 * is this endpoint's not-found (404 through aiRailsErrorResponse) — the
 * HRM authorization error has no mapping here and must never escape as
 * a 500 that buries the refusal.
 */
function employmentNotVisible(): AiRailsError {
  return new AiRailsError(
    "ai_subject_missing",
    "payslip for this employment matched no visible row — it is missing, outside this organization, or outside your legal-entity scope; reload and retry",
  );
}

/**
 * Employer scope for the payroll.manage path, which carries no HRM
 * employment grant: the trusted employment row's employer subsidiary on
 * this runner, against the actor's allowed set. Unrestricted actors pass;
 * a missing employer fails closed like an unknown id.
 */
async function assertPayrollEmploymentScope(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<void> {
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (allowed === null) return;
  const row = (await exec.execute<{ employerSubsidiaryId: string | null }>(sql`
    select employer_subsidiary_id as "employerSubsidiaryId" from worker_employments
     where org_id = ${orgId}::uuid and id = ${employmentId}::uuid`)).rows[0];
  if (!row?.employerSubsidiaryId || !allowed.has(row.employerSubsidiaryId)) {
    throw employmentNotVisible();
  }
}

/** Own employment or a held grant with the employer's scope — anything else refuses by name. */
async function assertExplainScope(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<void> {
  // Elevated paths check the employer's scope, never the grant alone: a
  // payroll.manage or hrm.employment.read holder restricted to subsidiary
  // A must not explain B's pay components, inputs, net pay, or stub diff.
  if (await actorHasPermission(exec, orgId, actorId, "payroll.manage")) {
    await assertPayrollEmploymentScope(exec, orgId, actorId, employmentId);
    return;
  }
  if (await actorHasPermission(exec, orgId, actorId, "hrm.employment.read")) {
    try {
      await requireHrmEmploymentRead(exec, orgId, actorId, employmentId);
    } catch (error) {
      // The grant held, so this half is the subject/scope check: unknown,
      // cross-org, and out-of-scope refuse identically.
      if (error instanceof HrmAuthorizationError) throw employmentNotVisible();
      throw error;
    }
    return;
  }
  await requireHrmSelfRead(exec, orgId, actorId);
  const own = await loadOwnEmploymentIds(exec, orgId, actorId);
  if (!own.includes(employmentId)) {
    throw aiSubjectRefused(
      `payslip for employment ${employmentId} is outside your self-service scope`,
      "open your own payslip from Me, or ask a payroll administrator to explain this one",
    );
  }
}

async function loadStub(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  stubId: string | null,
): Promise<StubRow> {
  const rows = stubId
    ? (await exec.execute<StubRow>(sql`
        select id::text as id, employment_id::text as "employmentId",
               pay_run_document_id::text as "payRunDocumentId",
               pay_date::text as "payDate", gross::text as gross,
               net_pay::text as "netPay", employer_cost::text as "employerCost"
          from pay_stubs
         where org_id = ${orgId}::uuid and id = ${stubId}::uuid
           and (employment_id = ${employmentId}::uuid or employment_id is null)`)).rows
    : (await exec.execute<StubRow>(sql`
        select id::text as id, employment_id::text as "employmentId",
               pay_run_document_id::text as "payRunDocumentId",
               pay_date::text as "payDate", gross::text as gross,
               net_pay::text as "netPay", employer_cost::text as "employerCost"
          from pay_stubs
         where org_id = ${orgId}::uuid and employment_id = ${employmentId}::uuid
         order by pay_date desc, id desc
         limit 1`)).rows;
  const stub = rows[0];
  if (!stub) {
    throw new AiRailsError(
      "ai_no_payslip",
      stubId
        ? `payslip ${stubId} matched no row for this employment — it is missing, outside this organization, or stamped to another employment; reload and retry`
        : "no calculated payslip exists for this employment yet — explanations appear after the first pay run calculates",
    );
  }
  return stub;
}

async function loadLines(exec: SqlExecutor, orgId: string, stubId: string): Promise<ExplainPayLine[]> {
  const rows = (await exec.execute<{
    id: string; componentId: string | null; kind: string; description: string;
    hours: string | null; rate: string | null; amount: string; treatment: string | null;
  }>(sql`
    select l.id::text as id, l.component_id::text as "componentId", l.kind,
           l.description, l.hours::text as hours, l.rate::text as rate,
           l.amount::text as amount,
           case when l.kind = 'deduction' then c.tax_treatment
                when l.kind = 'earning' then
                  case when coalesce(c.taxable, true) then 'taxable' else 'non-taxable' end
                else null end as treatment
      from pay_stub_lines l
      left join pay_components c
        on c.org_id = l.org_id and c.id = l.component_id
     where l.org_id = ${orgId}::uuid and l.stub_id = ${stubId}::uuid
     order by l.sequence, l.id`)).rows;
  return rows;
}

/** Deterministic diff: same description lines across two stubs. */
export function diffStubLines(
  previous: Pick<ExplainPayLine, "description" | "hours" | "rate" | "amount">[],
  current: Pick<ExplainPayLine, "description" | "hours" | "rate" | "amount">[],
): { description: string; previousAmount: string | null; amount: string | null; input: string }[] {
  const prevByDesc = new Map(previous.map((l) => [l.description, l]));
  const seen = new Set<string>();
  const changes: { description: string; previousAmount: string | null; amount: string | null; input: string }[] = [];
  for (const line of current) {
    seen.add(line.description);
    const prev = prevByDesc.get(line.description);
    if (!prev) {
      changes.push({
        description: line.description,
        previousAmount: null,
        amount: line.amount,
        input: line.hours !== null && line.rate !== null
          ? `new line: ${line.hours} hours × ${line.rate}`
          : "new line this period",
      });
    } else if (prev.amount !== line.amount) {
      const bits: string[] = [];
      if (prev.hours !== line.hours) bits.push(`hours ${prev.hours ?? "—"} → ${line.hours ?? "—"}`);
      if (prev.rate !== line.rate) bits.push(`rate ${prev.rate ?? "—"} → ${line.rate ?? "—"}`);
      changes.push({
        description: line.description,
        previousAmount: prev.amount,
        amount: line.amount,
        input: bits.length > 0 ? bits.join("; ") : "amount changed with same hours and rate",
      });
    }
  }
  for (const line of previous) {
    if (!seen.has(line.description)) {
      changes.push({
        description: line.description,
        previousAmount: line.amount,
        amount: null,
        input: "line absent this period",
      });
    }
  }
  return changes;
}

export async function explainPay(
  exec: SqlExecutor,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly employmentId: string;
    readonly stubId?: string | null;
  },
): Promise<ExplainPayTrace> {
  const { orgId, actorId, employmentId } = input;
  if (!orgId || !actorId || !employmentId) {
    throw new AiRailsError("ai_invalid_input", "orgId, actorId and employmentId are required");
  }
  await assertExplainFeature(exec, orgId);
  await assertExplainScope(exec, orgId, actorId, employmentId);
  const stub = await loadStub(exec, orgId, employmentId, input.stubId ?? null);
  const lines = await loadLines(exec, orgId, stub.id);

  const benefitInputs = (await exec.execute<{
    id: string; kind: string; amount: string; coverageFrom: string; coverageTo: string; status: string;
  }>(sql`
    select id::text as id, kind, amount::text as amount,
           coverage_from::text as "coverageFrom", coverage_to::text as "coverageTo", status
      from hrm_benefit_payroll_inputs
     where org_id = ${orgId}::uuid and employment_id = ${employmentId}::uuid
       and consumed_by_run_document_id = ${stub.payRunDocumentId}::uuid
     order by id`)).rows;

  const leaveInputs = (await exec.execute<{
    id: string; kind: string; hours: string; absenceDate: string; status: string;
  }>(sql`
    select id::text as id, kind, hours::text as hours,
           absence_date::text as "absenceDate", status
      from hrm_payroll_inputs
     where org_id = ${orgId}::uuid and employment_id = ${employmentId}::uuid
       and consumed_by_run_document_id = ${stub.payRunDocumentId}::uuid
     order by absence_date, id`)).rows;

  const partyRows = (await exec.execute<{ partyId: string }>(sql`
    select worker_party_id::text as "partyId" from worker_employments
     where org_id = ${orgId}::uuid and id = ${employmentId}::uuid`)).rows;
  const partyId = partyRows[0]?.partyId ?? null;
  const wageRates = partyId
    ? (await exec.execute<{
        id: string; rate: string; basis: string; effectiveFrom: string; effectiveTo: string | null;
      }>(sql`
        select id::text as id, rate::text as rate, basis,
               effective_from::text as "effectiveFrom",
               effective_to::text as "effectiveTo"
          from labor_cost_rates
         where org_id = ${orgId}::uuid and is_active
           and (employee_party_id = ${partyId}::uuid or employee_party_id is null)
           and effective_from <= ${stub.payDate}::date
           and (effective_to is null or effective_to >= ${stub.payDate}::date)
         order by effective_from desc
         limit 5`)).rows
    : [];

  const prevRows = (await exec.execute<StubRow>(sql`
    select id::text as id, employment_id::text as "employmentId",
           pay_run_document_id::text as "payRunDocumentId",
           pay_date::text as "payDate", gross::text as gross,
           net_pay::text as "netPay", employer_cost::text as "employerCost"
      from pay_stubs
     where org_id = ${orgId}::uuid and employment_id = ${employmentId}::uuid
       and pay_date < ${stub.payDate}::date
     order by pay_date desc, id desc
     limit 1`)).rows;
  const prev = prevRows[0] ?? null;
  const prevLines = prev ? await loadLines(exec, orgId, prev.id) : [];

  const sources: { kind: string; id: string }[] = [{ kind: "pay_stub", id: stub.id }];
  for (const b of benefitInputs) sources.push({ kind: "hrm_benefit_payroll_input", id: b.id });
  for (const l of leaveInputs) sources.push({ kind: "hrm_payroll_input", id: l.id });

  const trace: ExplainPayTrace = {
    stubId: stub.id,
    employmentId,
    payRunDocumentId: stub.payRunDocumentId,
    payDate: stub.payDate,
    gross: stub.gross,
    netPay: stub.netPay,
    employerCost: stub.employerCost,
    earnings: lines.filter((l) => l.kind === "earning"),
    deductions: lines.filter((l) => l.kind === "deduction"),
    employerContributions: lines.filter((l) => l.kind === "employer_contribution"),
    benefitInputs,
    leaveInputs,
    wageRates,
    diffVsPrevious: {
      previousStubId: prev?.id ?? null,
      previousPayDate: prev?.payDate ?? null,
      changes: diffStubLines(prevLines, lines),
    },
    sources,
  };

  // The ledger summary is a REFERENCE, never values: gross, net and line
  // amounts are readable only through the trace itself, which carries
  // the scope gate above. A restricted ledger reader must learn that a
  // trace exists for this employment and stub — never what it paid.
  await logDecision(exec, {
    orgId,
    actorId,
    capabilityKey: "hrmExplainPay",
    subjectKind: "employment",
    subjectId: employmentId,
    input: `explainPay employment=${employmentId} stub=${stub.id}`,
    output: `trace stub=${stub.id} gross=${stub.gross} net=${stub.netPay}`,
    outputSummary: `pay trace for employment ${employmentId} (stub ${stub.id}, ${lines.length} lines)`,
    sources,
    outcome: "shown",
    model: "explain-pay-service",
  });
  return trace;
}

/** Public boundary: explain a payslip. One transaction. */
export async function explainPayslip(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly stubId?: string | null;
}): Promise<ExplainPayTrace> {
  return withOrgTransaction(query.orgId, () =>
    explainPay(db, {
      orgId: query.orgId,
      actorId: query.actorId,
      employmentId: query.employmentId,
      stubId: query.stubId ?? null,
    }),
  );
}
