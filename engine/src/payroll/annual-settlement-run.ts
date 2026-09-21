import { sql } from "drizzle-orm";
import type { db } from "../platform/db.ts";
import { add } from "../money/money.ts";
import { PayrollPackError } from "./payroll-error.ts";
import { PayrollError } from "./error.ts";
import {
  createSettlementPush,
  isFinalPeriodOfTaxYear,
  missingSettlementInputs,
  resolveAnnualSettlement,
  type AnnualSettlementPriors,
} from "./annual-settlement.ts";
import { createPushStatutory } from "./push-statutory.ts";
import {
  assertPayrollRegionSupported,
  type PayrollCountryPack,
} from "./packs.ts";
import type { ResolvedCertificate, StoredCertificate } from "./certificates.ts";
import type {
  PayrollEmployerLevyFactors,
  StubLine,
} from "./statutory-context.ts";

/**
 * Annual-settlement run wiring — the generic half of the pack capability
 * declared in engine/src/payroll/annual-settlement.ts.
 *
 * Packs declare; this module invokes. It names no country, no levy, and no
 * key: the pack answers every question through its declaration, so a future
 * pack (JP, DE) wires itself by declaring, never by branching here.
 *
 * WHEN IT RUNS. On the final period of the pack's own tax year
 * (`isFinalPeriodOfTaxYear` over the pack's tax-year definition), on a
 * regular run only — the settlement supplements the ordinary monthly pass,
 * and a one-off run carries no ordinary pass to supplement. Any other
 * period, any other run type, or a pack declaring nothing returns null and
 * the monthly path is untouched by construction.
 *
 * WHAT IT READS. Committed stubs only, plus the current stub's own monthly
 * pass from memory. A calculated-but-uncommitted run is a draft that may be
 * abandoned or recalculated, and counting it would let unpaid figures move
 * an employee's refund — so drafts (including other stubs of the run being
 * calculated, which are drafts until commit) never enter the priors. The
 * current run contributes its just-calculated monthly bases, never a
 * database read-back of itself.
 *
 * The year-to-date map carries every deduction AND credit systemKey the
 * committed stubs moved — never deductions alone, never one key. Payout
 * credits (IT `ti_payout`, `somma_payout`) ride the monthly rail as credit
 * lines, and a map that dropped them would read paid as zero while the
 * annual figure is not: a false credit-guard refusal, or worse, a wrong
 * refund. Keys with no committed line are simply absent, and the packs read
 * absent as zero per the committed-stub doctrine. Non-system lines (a
 * garnishment, union dues: deduction-kind lines with no system key) are not
 * withholding and stay out of the map.
 *
 * WHAT IT REFUSES. A settlement edition whose mode the run layer cannot
 * honour (`final_period_recomputation`: a different December program, not
 * an extra line) refuses by name on the final run — silently skipping is
 * precisely the defect this wiring exists to fix. Missing declared inputs
 * refuse naming the employee and the missing keys. A settlement pushing a
 * (systemKey, kind) with no seeded component fails out of the run's own
 * `need` naming the missing component: the refund must ride a declared
 * credit row, because the remittance groups and negates by COMPONENT kind
 * and reusing the deduction row would overstate the payable by twice the
 * refund.
 */

export interface AnnualSettlementRunInput {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  documentId: string;
  /** The pack resolved for this run — asked, never branched on. */
  pack: PayrollCountryPack;
  run: Record<string, string>;
  emp: Record<string, string | null>;
  country: string;
  region: string;
  taxYear: number;
  periodsPerYear: number;
  runType: string;
  employeePartyId: string;
  employeeName: string;
  /** The current stub's monthly periodic taxable base (in memory). */
  income: string;
  /** The current stub's monthly one-off base (in memory). */
  nonPeriodic: string;
  /** The current stub's monthly line set; settlement lines are appended. */
  lines: StubLine[];
  /** The run's component assertion (names the missing setup, never defaults). */
  need: (systemKey: string, kind: string) => Record<string, unknown>;
  /** The run's component rows, for attributing the current lines. */
  components: Record<string, unknown>[];
  filingAccountId: string | null;
  storedCertificates: readonly StoredCertificate[];
  certificateFor: (key: string) => ResolvedCertificate | null;
  bool: (value: string | null | undefined) => boolean;
  employerLevies: PayrollEmployerLevyFactors;
}

/** Committed taxable gross for the employee's tax year (history half). */
async function committedPriorGross(
  tx: Pick<typeof db, "execute">,
  input: { orgId: string; employeePartyId: string; country: string; taxYear: number },
): Promise<string> {
  const rows = (await tx.execute<{ prior: string }>(sql`
    select coalesce(sum(s.gross), 0) as prior
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where s.org_id = ${input.orgId} and s.employee_party_id = ${input.employeePartyId}
       and s.tax_year = ${input.taxYear} and s.country = ${input.country}
       and r.run_status = 'committed' and d.status <> 'voided'
  `));
  return rows.rows[0]!.prior;
}

/**
 * Committed withheld-and-paid sums by systemKey (history half): deduction
 * and credit lines of committed stubs, attributed through their components.
 * Employer shares never leave the employee's pay and stay out of the map.
 */
async function committedPriorWithheld(
  tx: Pick<typeof db, "execute">,
  input: { orgId: string; employeePartyId: string; country: string; taxYear: number },
): Promise<Record<string, string>> {
  const rows = (await tx.execute<{ key: string; total: string }>(sql`
    select c.system_key as key, sum(l.amount)::text as total
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where s.org_id = ${input.orgId} and s.employee_party_id = ${input.employeePartyId}
       and s.tax_year = ${input.taxYear} and s.country = ${input.country}
       and r.run_status = 'committed' and d.status <> 'voided'
       and l.kind in ('deduction', 'credit')
       and c.system_key is not null
     group by c.system_key
  `));
  return Object.fromEntries(rows.rows.map((row) => [row.key, row.total]));
}

/**
 * Price the pack's annual settlement for one stub, appending its lines.
 * Returns the settlement's trace factors for the stub, or null when no
 * settlement applies (pack declares none, period not final, run not
 * regular) — the monthly path untouched. Throws the pack's refusal, the
 * mode refusal, or the missing-input refusal: all ride the run's existing
 * per-employee refusal channel.
 */
export async function settleAnnualSettlement(
  input: AnnualSettlementRunInput,
): Promise<Record<string, string> | null> {
  const {
    tx, orgId, documentId, pack, run, emp, country, region, taxYear,
    periodsPerYear, runType, employeePartyId, employeeName,
    income, nonPeriodic, lines, need, components, filingAccountId,
    storedCertificates, certificateFor, bool, employerLevies,
  } = input;

  // Wiring-time resolution: absent declaration or a null edition settles
  // nothing, while an edition against an undeclared systemKey refuses
  // before any employee's pay is touched.
  const settlement = resolveAnnualSettlement(pack, taxYear);
  if (settlement === null) return null;
  const payDate = run.pay_date!;
  if (!isFinalPeriodOfTaxYear(pack.taxYear, periodsPerYear, payDate)) return null;
  // One-off runs carry no ordinary monthly pass for the settlement to
  // supplement: a bonus, retro, or termination run in the final period
  // calculates exactly as it always has.
  if (runType !== "regular") return null;
  // The two settlement shapes are different programs, not options. The run
  // layer honours one extra line on the final run; a pack declaring the
  // recomputation shape refuses by name rather than being skipped in
  // silence — a skipped settlement is an unpaid refund nobody reports.
  if (settlement.mode !== "adjustment_line") {
    throw new PayrollPackError(
      `annual settlement: "${settlement.label}" declares mode "${settlement.mode}" for ${employeeName} — `
      + 'the run layer honours "adjustment_line" only (one extra line on an otherwise normal final run), '
      + "so this employee's year is left unsettled by this run. Settle the residual through a pay-run "
      + "adjustment (engine/src/payroll/run-adjustments.ts) and recalculate.",
    );
  }
  const missing = missingSettlementInputs(settlement, { emp, certificateFor });
  if (missing.length > 0) {
    throw new PayrollPackError(
      `annual settlement: "${settlement.label}" cannot settle ${employeeName} — `
      + `missing ${missing.join(", ")}: record the settlement's declared inputs for this employee `
      + "(the employee facts and certificates the pack requires) and recalculate the run.",
    );
  }

  // Committed history plus the current stub's own monthly pass. The current
  // run's lines are attributed through the run's component rows (the same
  // country scoping the run itself resolves by); non-system lines carry no
  // key and stay out of the map, by definition rather than by default.
  const systemKeyByComponentId = new Map<string, string>();
  for (const component of components) {
    if (typeof component.id !== "string" || typeof component.system_key !== "string") continue;
    if (component.country != null && component.country !== country) continue;
    systemKeyByComponentId.set(component.id, component.system_key);
  }
  const currentByKey: Record<string, string> = {};
  for (const line of lines) {
    if (line.kind !== "deduction" && line.kind !== "credit") continue;
    const key = line.componentId == null
      ? undefined
      : systemKeyByComponentId.get(line.componentId);
    if (key == null) continue;
    currentByKey[key] = add(currentByKey[key] ?? "0", line.amount);
  }
  const historyByKey = await committedPriorWithheld(tx, {
    orgId, employeePartyId, country, taxYear,
  });
  const ytdWithheldBySystemKey: Record<string, string> = { ...historyByKey };
  for (const [key, amount] of Object.entries(currentByKey)) {
    ytdWithheldBySystemKey[key] = add(ytdWithheldBySystemKey[key] ?? "0", amount);
  }
  const priors: AnnualSettlementPriors = {
    ytdGross: add(
      await committedPriorGross(tx, { orgId, employeePartyId, country, taxYear }),
      add(income, nonPeriodic),
    ),
    ytdWithheldBySystemKey,
  };

  // The settlement pushes through the pack's declared components (the run's
  // own `need`, so a missing rail names its setup) with a push-local
  // earnings set — the monthly fixpoint's set is settled history by now —
  // wrapped in the contract's sign-refusing push: direction rides the kind.
  const pushSettlement = createSettlementPush(
    createPushStatutory({
      country, lines, emittedEarningsAssessed: new Set(), need,
    }),
  );
  return settlement.compute({
    tx, orgId, documentId, employeePartyId, employeeName, taxYear, country,
    region, run, emp, filingAccountId, periodsPerYear,
    storedCertificates, certificateFor, bool,
    assertRegionSupported: (supportedRegion) =>
      assertPayrollRegionSupported(country, supportedRegion),
    employerLevies,
    payDate,
    priors,
    pushSettlement,
  });
}

/** Merge collision refusal, mirroring the employer-aggregate factor merge. */
export function assertSettlementFactorsMergeable(
  employeeName: string,
  country: string,
  monthlyFactors: Record<string, string>,
  settlementFactors: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(settlementFactors)) {
    if (key in monthlyFactors && monthlyFactors[key] !== value) {
      throw new PayrollError(
        `annual-settlement factor "${key}" collides with the ${country} pack's statutory factors `
        + `for ${employeeName} — rename the settlement's factor key`,
      );
    }
  }
}
