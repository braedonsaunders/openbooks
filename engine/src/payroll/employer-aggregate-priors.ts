import { sql } from "drizzle-orm";
import type { db } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import { PayrollPackError, payrollPack, statutoryAssessment } from "./packs.ts";
import { PACK_OPENING_BALANCE_FIELDS } from "./opening-ytd-registry.ts";
import { assertAggregateLeviesValid, assessAggregateLevyStub } from "./employer-aggregate.ts";
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
  });
  const factors: Record<string, string> = {};
  for (const { levy, priors } of resolved) {
    const stubBase = levy.base.source === "gross" ? input.gross : input.taxableGross;
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
  const { tx, orgId, country, documentId, employeePartyId, taxYear, region, levies, tenantValues } = input;
  return Promise.all(levies.map(async (levy) => ({
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
    },
  })));
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
