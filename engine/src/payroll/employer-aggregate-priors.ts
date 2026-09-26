import { sql } from "drizzle-orm";
import type { db } from "../platform/db.ts";
import { cmp, fromUnits, roundDiv, toUnits } from "../money/money.ts";
import { PayrollPackError, payrollPack, statutoryAssessment } from "./packs.ts";
import { PACK_OPENING_BALANCE_FIELDS } from "./opening-ytd-registry.ts";
import {
  assertAggregateLeviesValid,
  assessAggregateLevyStub,
  taxMonthsElapsed,
} from "./employer-aggregate.ts";
import { resolveStoredEmployerFact } from "./employer-fact-store.ts";
import { resolveStatutoryRates } from "./statutory-rates.ts";
import type { PayrollEmployerAggregateLevy } from "./packs.ts";
import type { PushStatutoryFn, StubLine } from "./statutory-context.ts";
import type { AggregateStubPriors } from "./employer-aggregate.ts";

/**
 * Employer-aggregate priors — the SQL half of the channel.
 *
 * The arithmetic lives in `employer-aggregate.ts` and knows nothing of the
 * database; this module resolves the three numbers it needs per levy:
 *
 * - the employer base in scope: the 0174 opening carry-in, plus committed
 *   stub factors, plus the already-calculated stubs of the run being
 *   calculated (the own-document arm, which sequences room across the
 *   run's own employees the way the EHT exemption does);
 * - the employee's base for a per-employee cap: committed and own-document
 *   stub factors, plus the pack's declared opening field for a mid-year
 *   adopter — resolved through the opening registry, so the generic layer
 *   never names a pack's column;
 * - for an accruing allowance: the levy already paid in scope (committed and
 *   own-document amount factors), the annual allocated share (the levy's
 *   subsidiary-scoped employer fact at the pay date — an undeclared share
 *   refuses through the fact's own required flag), and the tax months
 *   elapsed at the pay date;
 * - tenant values, resolved ONCE per run by the caller through
 *   `resolveStatutoryRates` and passed down (never a query per employee).
 *
 * Only committed history consumes room: a calculated run is a draft that
 * may be abandoned or recalculated, and counting it would let unpaid
 * figures burn the annual allowance. The commit-time employer fence plus
 * the staleness arm close the race this leaves between two overlapping
 * calculations on disjoint rosters.
 */

export interface AggregatePriorsInput {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  country: string;
  /** The run being calculated — its stubs count via the own-document arm. */
  documentId: string;
  employeePartyId: string;
  taxYear: number;
  /** The stub's employment region (scopes `region` levies). */
  region: string;
  levies: readonly PayrollEmployerAggregateLevy[];
  tenantValues: Record<string, Record<string, string>>;
  /** The paying legal employer (scopes accruing-allowance fact reads). */
  subsidiaryId?: string;
  /** ISO pay date (counts elapsed tax months for accruing allowances). */
  payDate?: string;
}

export interface ResolvedAggregateLevy {
  levy: PayrollEmployerAggregateLevy;
  priors: AggregateStubPriors;
}

/**
 * One stub's employer-aggregate assessments, pushed as statutory lines.
 *
 * Called from `calculateStub` in calculation order, right after the
 * per-employee levies: the priors resolve committed history plus the
 * already-calculated stubs of this run, so each stub consumes the room the
 * earlier stubs left. Returns the factor stamps, which the caller merges
 * into the statutory factors — the year-to-date reads them back.
 *
 * Two wiring guards live here rather than in the assessor, because only the
 * run knows the seeded components and the configured rates:
 *
 * - every levy's system key must be an earnings-assessed employer
 *   contribution. A levy pointed at a deduction-sensitive component would
 *   drift across the deduction-protection fixpoint passes;
 * - tenant-entered slots are read once per stub through the same resolution
 *   the per-employee levies use — never defaulted when unconfigured (the
 *   assessor refuses a missing rate by levy name).
 */
export async function assessStubAggregateLevies(input: {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  documentId: string;
  employeePartyId: string;
  taxYear: number;
  country: string;
  region: string;
  gross: string;
  taxableGross: string;
  /** NIC-able earnings leg (prices `pensionable`-source bases). */
  pensionable?: string;
  /** Schedule periodicity (selects `pensionable`-source period floors). */
  periodsPerYear?: number;
  /** The paying legal employer (scopes accruing-allowance fact reads). */
  subsidiaryId?: string;
  lines: readonly StubLine[];
  pushStatutory: PushStatutoryFn;
  /** ISO pay date the tenant-rate resolution is as-of; absent reads current. */
  payDate?: string;
}): Promise<Record<string, string>> {
  const levies = payrollPack(input.country).employerAggregateLevies?.(input.taxYear) ?? [];
  if (levies.length === 0) return {};
  assertAggregateLeviesValid(levies);
  // Annual levies settle at year end against the full-year base and the
  // then-known spend: reading their slots per stub would refuse on slots
  // that only need to exist at settlement, so per-run work covers per-run
  // levies only. Validation above still applies to every declaration.
  const perRun = levies.filter((levy) => levy.timing === "per_run");
  if (perRun.length === 0) return {};
  const leviesToAssess = perRun;
  for (const levy of leviesToAssess) {
    const assessedOn = statutoryAssessment(input.country, levy.systemKey, "employer_contribution");
    if (assessedOn !== "earnings") {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" points at ${levy.systemKey}/employer_contribution, `
        + `which is assessed on ${assessedOn} — an aggregate levy must ride an earnings-assessed `
        + "component, or the deduction-protection fixpoint moves it",
      );
    }
  }
  const rates = await resolveStatutoryRates(
    input.orgId,
    payrollPack(input.country).statutoryRates,
    input.taxYear,
    input.payDate ?? null,
  );
  const wanted = new Set<string>();
  for (const levy of leviesToAssess) {
    if (levy.rate.kind === "tenant_slot") wanted.add(levy.rate.slotKey);
    if (levy.classSlotKey) wanted.add(levy.classSlotKey);
    if (levy.excludedBy) wanted.add(levy.excludedBy.slotKey);
    if (levy.offset) wanted.add(levy.offset.slotKey);
  }
  const tenantValues: Record<string, Record<string, string>> = {};
  for (const slotKey of wanted) {
    tenantValues[slotKey] = rates.values(slotKey, { region: input.region }) ?? {};
  }
  const resolved = await resolveAggregateLevyPriors({
    tx: input.tx,
    orgId: input.orgId,
    country: input.country,
    documentId: input.documentId,
    employeePartyId: input.employeePartyId,
    taxYear: input.taxYear,
    region: input.region,
    levies: leviesToAssess,
    tenantValues,
    subsidiaryId: input.subsidiaryId,
    payDate: input.payDate,
  });
  const factors: Record<string, string> = {};
  for (const { levy, priors } of resolved) {
    const stubBase = levy.base.source === "gross" ? input.gross
      : levy.base.source === "taxable" ? input.taxableGross
      : pensionableStubBase(levy, input.pensionable, input.periodsPerYear);
    const assessed = assessAggregateLevyStub(levy, stubBase, priors);
    if (cmp(assessed.amount, "0") !== 0) {
      input.pushStatutory(
        levy.systemKey, "employer_contribution", levy.description, assessed.amount, levy.sequence,
      );
    }
    Object.assign(factors, assessed.factors);
  }
  return factors;
}

export async function resolveAggregateLevyPriors(
  input: AggregatePriorsInput,
): Promise<ResolvedAggregateLevy[]> {
  const {
    tx, orgId, country, documentId, employeePartyId, taxYear, region,
    levies, tenantValues, subsidiaryId, payDate,
  } = input;
  // Sequential levies: the stub calculation runs on its transaction client,
  // which is one pg connection — resolving every levy at once queues
  // concurrent queries on it.
  const resolved: ResolvedAggregateLevy[] = [];
  for (const levy of levies) {
    resolved.push({
      levy,
      priors: {
        employerPriorBase: await employerPriorBase(tx, {
          orgId, country, documentId, taxYear, levy,
          region: levy.base.scope === "region" ? region : null,
        }),
        employeePriorBase: levy.allowance?.kind === "per_employee_cap"
          ? await employeePriorBase(tx, {
            orgId, country, documentId, employeePartyId, taxYear, levy,
          })
          : "0",
        tenantValues,
        accruing: levy.allowance?.kind === "accruing_allowance"
          ? await resolveAccruingInputs(tx, {
            orgId, country, subsidiaryId, payDate, documentId, taxYear, levy,
            region: levy.base.scope === "region" ? region : null,
          })
          : undefined,
      },
    });
  }
  return resolved;
}

/**
 * This stub's share of a pensionable-source base: the NIC-able leg less the
 * year's period floor for the schedule periodicity, floored at zero (base
 * below the floor contributes nothing, exactly like sub-threshold earnings
 * attract no secondary charge).
 */
function pensionableStubBase(
  levy: PayrollEmployerAggregateLevy,
  pensionable: string | undefined,
  periodsPerYear: number | undefined,
): string {
  if (pensionable === undefined || periodsPerYear === undefined) {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" prices a pensionable base the run did not resolve — `
      + "engine defect",
    );
  }
  const floor = levy.base.periodFloor;
  if (!floor) {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" prices a pensionable base with no period floors — `
      + "engine defect",
    );
  }
  const threshold = periodsPerYear === 52 ? floor.weekly
    : periodsPerYear === 12 ? floor.monthly
    : periodsPerYear === 1 ? floor.annual
    : null;
  if (threshold === null) {
    if (!Number.isInteger(periodsPerYear) || periodsPerYear <= 0) {
      throw new PayrollPackError(
        `employer-aggregate levy "${levy.key}" needs a positive integer periods-per-year, `
        + `got ${periodsPerYear}`,
      );
    }
    // Unlisted periodicity prorates the annual floor to the penny, the way
    // the agency prints weekly and monthly thresholds.
    return pensionableLessFloor(
      levy.key,
      pensionable,
      fromUnits(roundDiv(toUnits(floor.annual), BigInt(periodsPerYear) * 100n) * 100n),
    );
  }
  return pensionableLessFloor(levy.key, pensionable, threshold);
}

function pensionableLessFloor(levyKey: string, pensionable: string, threshold: string): string {
  let base: bigint;
  try {
    base = toUnits(pensionable) - toUnits(threshold);
  } catch {
    throw new PayrollPackError(
      `employer-aggregate levy "${levyKey}" prices a pensionable base that is not decimal money — `
      + "engine defect",
    );
  }
  return base <= 0n ? "0" : fromUnits(base);
}

/** Accruing-allowance inputs: paid in scope, the allocated share, months elapsed. */
async function resolveAccruingInputs(
  tx: Pick<typeof db, "execute">,
  input: {
    orgId: string;
    country: string;
    subsidiaryId: string | undefined;
    payDate: string | undefined;
    documentId: string;
    taxYear: number;
    levy: PayrollEmployerAggregateLevy;
    region: string | null;
  },
): Promise<{ priorAmount: string; allowanceAnnual: string; monthsElapsed: number }> {
  const { orgId, country, subsidiaryId, payDate, documentId, taxYear, levy, region } = input;
  if (levy.allowance?.kind !== "accruing_allowance") {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" resolves accruing inputs for a non-accruing allowance — `
      + "engine defect",
    );
  }
  if (!subsidiaryId) {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" needs the paying legal employer to resolve its `
      + "allowance share — assign the payroll run to its legal employer",
    );
  }
  if (payDate === undefined || payDate === "") {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" accrues its allowance against the pay date, which the `
      + "run did not resolve — engine defect",
    );
  }
  const allowanceAnnual = await resolveStoredEmployerFact({
    tx, orgId, subsidiaryId, country,
    factKey: levy.allowance.factKey, asOf: payDate,
  });
  if (allowanceAnnual === null) {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" has no allowance share recorded for this legal employer `
      + `— record it in Payroll Setup → Employer facts (${levy.allowance.factKey})`,
    );
  }
  return {
    priorAmount: await employerPriorAmount(tx, { orgId, country, documentId, taxYear, levy, region }),
    allowanceAnnual,
    monthsElapsed: taxMonthsElapsed(payDate, levy.allowance.yearStartMonth, levy.allowance.yearStartDay),
  };
}

/** Levy already paid in scope: opening carry-in plus committed and own-document amount factors. */
async function employerPriorAmount(
  tx: Pick<typeof db, "execute">,
  input: {
    orgId: string;
    country: string;
    documentId: string;
    taxYear: number;
    levy: PayrollEmployerAggregateLevy;
    region: string | null;
  },
): Promise<string> {
  // No country filter: the stub-factor half of the match reads org-wide like
  // every aggregate levy (see employerPriorBase below); only the opening
  // carry-in subquery there is country-scoped, and no paid carry-in column
  // exists, so `input.country` is intentionally unread here.
  const { orgId, documentId, taxYear, levy, region } = input;
  const amountKey = levy.factorKey;
  const rows = (await tx.execute<{ prior: string }>(sql`
    select coalesce(sum((s.factors->>${amountKey})::numeric), 0) as prior
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where s.org_id = ${orgId} and s.tax_year = ${taxYear}
       and (${region}::text is null or s.province = ${region})
       and (s.pay_run_document_id = ${documentId} or r.run_status = 'committed')
       and d.status <> 'voided'
  `));
  return rows.rows[0]!.prior;
}

/** Employer base in scope: opening carry-in plus committed and own-document factors. */
async function employerPriorBase(
  tx: Pick<typeof db, "execute">,
  input: {
    orgId: string;
    country: string;
    documentId: string;
    taxYear: number;
    levy: PayrollEmployerAggregateLevy;
    region: string | null;
  },
): Promise<string> {
  const { orgId, country, documentId, taxYear, levy, region } = input;
  const earnKey = `${levy.factorKey}_EARN`;
  const rows = (await tx.execute<{ prior: string }>(sql`
    select coalesce((
             select base_ytd from payroll_employer_levy_opening
              where org_id = ${orgId} and tax_year = ${taxYear}
                and country = ${country} and levy_key = ${levy.key}
                and region is not distinct from ${region}
           ), 0)
           + coalesce(sum((s.factors->>${earnKey})::numeric), 0) as prior
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where s.org_id = ${orgId} and s.tax_year = ${taxYear}
       and (${region}::text is null or s.province = ${region})
       and (s.pay_run_document_id = ${documentId} or r.run_status = 'committed')
       and d.status <> 'voided'
  `));
  return rows.rows[0]!.prior;
}

/** This employee's base for a personal cap: factors plus the declared opening field. */
async function employeePriorBase(
  tx: Pick<typeof db, "execute">,
  input: {
    orgId: string;
    country: string;
    documentId: string;
    employeePartyId: string;
    taxYear: number;
    levy: PayrollEmployerAggregateLevy;
  },
): Promise<string> {
  const { orgId, documentId, employeePartyId, taxYear, levy } = input;
  const earnKey = `${levy.factorKey}_EARN`;
  const openingColumn = levy.employeeOpeningFieldKey
    ? employeeOpeningColumn(input.country, levy)
    : null;
  const rows = (await tx.execute<{ prior: string }>(sql`
    select ${openingColumn
      ? sql`coalesce((select ${sql.raw(openingColumn)} from payroll_opening_balances
                        where org_id = ${orgId} and employee_party_id = ${employeePartyId}
                          and tax_year = ${taxYear}), 0)`
      : sql`0`}
           + coalesce(sum((s.factors->>${earnKey})::numeric), 0) as prior
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
       and s.tax_year = ${taxYear}
       and (s.pay_run_document_id = ${documentId} or r.run_status = 'committed')
       and d.status <> 'voided'
  `));
  return rows.rows[0]!.prior;
}

/**
 * The declared opening key through the pack's own registry — the generic
 * layer resolves a KEY to a column and never interpolates declaration text
 * into SQL, so a pack typo is a refusal naming the key, not a query against
 * a column that does not exist.
 */
function employeeOpeningColumn(country: string, levy: PayrollEmployerAggregateLevy): string {
  const key = levy.employeeOpeningFieldKey!;
  const field = PACK_OPENING_BALANCE_FIELDS.find(
    (declared) => declared.key === key && declared.packs.some((pack) => pack === country),
  );
  if (!field) {
    throw new PayrollPackError(
      `employer-aggregate levy "${levy.key}" reads opening field "${key}" — `
      + `the ${country} pack declares no such year-to-date field`,
    );
  }
  return field.column;
}
