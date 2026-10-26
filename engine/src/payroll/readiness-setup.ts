import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { PayrollError } from "./error.ts";
import { payrollPaymentMethodSettings } from "./payment-method.ts";
import { payrollSettings } from "./run-setup.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { packRemittanceSchedules, packRemittanceVendorSettingsKeys, packSlotState, remittanceFrequencyBand } from "./packs.ts";
import { scheduledFrequencyAdvisory, scheduledRemittanceFrequency } from "./remittance.ts";
import { payrollBankProfiles } from "./bank-file.ts";
import { findDocumentNumberSeriesCollisions } from "../records/numbering.ts";
import type { PayrollFilingAccount } from "./filing.ts";
import { PayrollJurisdictionError, payrollTaxYearForDate, payrollTaxYearOperatorMessage } from "./packs.ts";
import { laborCostingSettings } from "../projects/labor-costing.ts";
import { CONTROL_ACCOUNTS_HREF, regionsByCountry, installedPayrollCountries, currentTaxYear, activePayrollPopulation, type ReadinessSeverity } from "./readiness-context.ts";
import { unconfiguredRatesForRun } from "./readiness-statutory-gaps.ts";

/** Organization-level payroll setup state: the configuration checks a pay run depends on. */

/**
 * One org-level configuration check the payroll setup wizard walks. Codes
 * reuse the pay-run readiness vocabulary (`setup.wageExpense`, `setup.slot`,
 * …) where the same fact is checked there, so the wizard and the run
 * pre-flight localize and resolve identically.
 */
export interface PayrollSetupCheck {
  code: string;
  severity: ReadinessSeverity;
  ok: boolean;
  /** Substitution for the message (pack country, slot key, vendor key). */
  detail?: string;
  /** Where the operator resolves it. */
  href?: string;
}

export interface PayrollSetupState {
  installedCountries: string[];
  checks: PayrollSetupCheck[];
  /** Failing blocker-severity checks — a pay run cannot commit past these. */
  blockers: number;
  /** Failing advisory checks. */
  warnings: number;
}

/**
 * Org-level payroll configuration state — the SETUP subset of what
 * `payRunReadiness` verifies before a run, computed without a run in hand
 * (no population, no period, no per-employee facts). The setup wizard's step
 * list and the "Set up payroll" call-to-action derive from these checks, and
 * every source consulted here (payrollSettings, packSlotState,
 * installedPayrollCountries, the pack vendor declarations) is the same one
 * the run pre-flight reads, so the two surfaces cannot disagree.
 */
/**
 * One installed pack's statutory-table setup check: the CHECK the setup
 * surface reads (code, verdict, detail, href as one object), so tests can
 * assert on what the operator sees rather than on the composer's fields.
 * Pure in (country, today) — no database — which is what makes that
 * assertion possible outside the DB partition.
 */
export function setupTaxYearCheck(
  country: string,
  today: string,
  setupHref: string,
): PayrollSetupCheck {
  // Operator text: the packs tab shows each pack's published coverage but
  // offers no action that loads an unpublished year, so the detail must
  // not prescribe the developer's scaffold script. The developer remedy
  // stays on `problem.message` for engine throws and logs.
  try {
    const { taxYear, problem } = payrollTaxYearForDate(country, today);
    return {
      severity: "blocker", code: "setup.taxYear", ok: problem === null,
      detail: problem ? problem.operatorMessage : `${country} · ${taxYear}`,
      href: `${setupHref}?tab=packs`,
    };
  } catch (error) {
    // No pack ⇒ the year lookup throws out of the pack registry before the
    // composer (and its undeclared branch) is reached. That throw is a
    // jurisdiction error, not the refusal the setup surface must show:
    // return the undeclared blocker instead, in the year-free form (no pack
    // ⇒ no year arithmetic). Anything else rethrows — only the unknown-pack
    // case converts. A crash becomes a refusal; nothing payable widens.
    if (!(error instanceof PayrollJurisdictionError)) throw error;
    return {
      severity: "blocker", code: "setup.taxYear", ok: false,
      detail: payrollTaxYearOperatorMessage(country, country, null, "undeclared", []),
      href: `${setupHref}?tab=packs`,
    };
  }
}

export async function payrollSetupState(
  orgId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<PayrollSetupState> {
  const setupHref = "/admin/setup/payroll";
  const checks: PayrollSetupCheck[] = [];

  const blobRes = (await db.execute<{ p: Record<string, unknown> | null }>(sql`
    select settings->'payroll' as p from orgs where id = ${orgId}
  `, "objects"));
  const blob = blobRes[0]?.p ?? {};
  const installed = await installedPayrollCountries(orgId, blob, allowedSubsidiaryIds);
  const settings = await payrollSettings(orgId, allowedSubsidiaryIds);

  checks.push({
    severity: "blocker", code: "setup.pack",
    ok: installed.length > 0, href: `${setupHref}?tab=packs`,
  });
  checks.push({
    severity: "blocker", code: "setup.wageExpense",
    ok: Boolean(settings.wageExpenseAccountId), href: `${setupHref}?tab=accounts`,
  });
  checks.push({
    severity: "blocker", code: "setup.netPay",
    ok: Boolean(settings.netPayAccountId), href: `${setupHref}?tab=accounts`,
  });
  if (settings.wagesTo === "labor_clearing") {
    // The labour clearing control account the commit debits and labour
    // costing credits — one mapping, read the way both of them read it.
    const clearing = (await db.execute<{ id: string | null }>(sql`
      select settings->'controlAccounts'->>'laborClearing' as id from orgs where id = ${orgId}
    `, "objects"));
    checks.push({
      severity: "blocker", code: "setup.laborClearing",
      ok: Boolean(clearing[0]?.id), href: CONTROL_ACCOUNTS_HREF,
    });
  }
  // Labour costing posts standard labour to WIP against Labor clearing at
  // approval; only wages posted to Labor clearing wash it. Expensing wages
  // while costing posts leaves WIP and clearing grossed up every run.
  if (settings.wagesTo !== "labor_clearing" && (await laborCostingSettings(orgId)).mode === "post") {
    checks.push({
      severity: "warning", code: "setup.laborWashMode",
      ok: false, href: `${setupHref}?tab=accounts`,
    });
  }

  // Every statutory slot of every installed pack must resolve to a liability
  // account — the same packSlotState walk the run pre-flight performs, minus
  // its runs-population filter (setup has no run to scope by). Slots that do
  // not apply where the org's ACTIVE payroll population works are absent, not
  // demanded: an Ontario-only employer is never told to map Québec accounts.
  // No population at all (a new org) demands everything — today's behaviour.
  // One roster for the whole setup state: the slot walk above scopes it to
  // regions, and the rate gaps reuse the same rows below.
  const setupPopulation = await activePayrollPopulation(orgId, allowedSubsidiaryIds);
  for (const pack of await packSlotState(orgId, installed, regionsByCountry(setupPopulation))) {
    const missing = pack.slots.filter((slot) => !slot.accountId);
    if (missing.length === 0) {
      checks.push({ severity: "blocker", code: "setup.slot", ok: true, detail: pack.country });
    }
    for (const slot of missing) {
      checks.push({
        severity: "blocker", code: "setup.slot", ok: false,
        detail: `${pack.country} · ${slot.key}`,
        href: `${setupHref}?tab=${pack.country.toLowerCase()}`,
      });
    }
  }

  // A run needs a pay calendar to exist at all — one the caller can use.
  // Schedules are subsidiary-scoped like the population, slots and rates on
  // this surface, so the existence read carries the same scope predicate: a
  // caller restricted to A with the only active schedule under B has no
  // usable schedule, and a null subsidiary belongs to no restricted caller.
  const schedules = (await db.execute<{ ok: boolean }>(sql`
    select exists (
      select 1 from pay_schedules where org_id = ${orgId} and is_active
        ${payrollSubsidiaryScopeFilter(sql`subsidiary_id`, allowedSubsidiaryIds)}) as ok
  `, "objects"));
  checks.push({
    severity: "blocker", code: "setup.schedule",
    ok: Boolean(schedules[0]?.ok), href: `${setupHref}?tab=schedules`,
  });

  // Statutory remittance vendors — exactly the settings keys the installed
  // packs declare (pack-level plus regional overrides), never a literal list.
  // Advisory: a run calculates without them; the remittance summary surfaces
  // unassigned withholdings until they are set.
  for (const country of installed) {
    for (const key of packRemittanceVendorSettingsKeys(country)) {
      const value = (blob as Record<string, unknown>)[key];
      checks.push({
        severity: "warning", code: "setup.remittanceVendor",
        ok: typeof value === "string" && value.length > 0,
        detail: `${country} · ${key}`, href: `${setupHref}?tab=accounts`,
      });
    }
  }

  // Two document kinds on one numbering series (a vendor payment and a pay
  // run both issuing PAY-00001 from independent counters): posted history
  // keeps its numbers — nothing is renumbered — so an existing collision
  // warns here, naming both kinds, with the future-documents remedy (change
  // one kind's prefix in Setup → Number sequences). New collisions are
  // refused at configuration time. Payroll setup owns the pay_run end, so it
  // reports the pairs a pay run is in; other pairs belong to their own
  // module's setup. Advisory: numbering stays unique in storage (per kind),
  // but one string naming two documents misleads every search for either.
  for (const collision of await findDocumentNumberSeriesCollisions(db, orgId)) {
    if (!collision.kinds.includes("pay_run")) continue;
    const other = collision.kinds.find((kind) => kind !== "pay_run")!;
    checks.push({
      severity: "warning", code: "setup.documentNumberSeries", ok: false,
      detail: `"pay_run" and "${other}" both issue ${collision.prefix || "(no prefix)"}${"0".repeat(Math.min(collision.padding, 12))}… — `
        + "change one kind's prefix in Setup → Number sequences for future documents; posted history keeps its numbers",
      href: "/admin/setup/number-sequences",
    });
  }

  // Are this year's statutory tables loaded for every installed pack? Asked
  // against TODAY's date through each pack's own tax-year definition, so the
  // answer is right for a jurisdiction whose year does not open in January. A
  // blocker: no run in the current year can calculate until the edition lands,
  // and January is exactly when nobody wants to discover that mid-payroll.
  const today = await businessToday(orgId);
  for (const country of installed) {
    checks.push(setupTaxYearCheck(country, today, setupHref));
  }

  // Destination remittance schedules: account-sourced frequencies are read
  // from each filing account, while organization-sourced schedules use the
  // pack's declared payroll setting. Last year's measured average remains an
  // advisory against the frequency the bill will actually use.
  for (const country of installed) {
    for (const schedule of packRemittanceSchedules(country)) {
      const vendor = (blob as Record<string, unknown>)[schedule.vendorSettingsKey];
      if (typeof vendor !== "string" || !vendor) continue;
      if (schedule.frequencySource === "filing_account") {
        const accounts = await db.execute<{
          id: string;
          accountNumber: string;
          name: string;
          remitterType: PayrollFilingAccount["remitterType"];
        }>(sql`
          select id::text as id, account_number as "accountNumber", name,
                 remitter_type as "remitterType"
            from payroll_filing_accounts
           where org_id = ${orgId} and country = ${country} and is_active
           order by is_default desc, account_number
        `, "objects");
        if (accounts.length === 0) {
          checks.push({
            severity: "warning", code: "setup.remittanceFrequency", ok: false,
            detail: `${schedule.authority} remittance needs a filing account with its remitter type set in Payroll Setup → Filing accounts`,
            href: `${setupHref}?tab=accounts`,
          });
          continue;
        }
        for (const account of accounts) {
          const filingAccount = {
            id: account.id, accountNumber: account.accountNumber,
            name: account.name, remitterType: account.remitterType,
          };
          const { frequency } = scheduledRemittanceFrequency(
            schedule, blob as Record<string, unknown>, filingAccount,
          );
          checks.push({
            severity: "warning", code: "setup.remittanceFrequency", ok: true,
            detail: `${schedule.authority} · ${account.accountNumber} · ${frequency.replaceAll("_", " ")}`,
          });
          const advisory = await scheduledFrequencyAdvisory(
            orgId, schedule, vendor, blob as Record<string, unknown>,
            Number(today.slice(0, 4)) - 1, filingAccount,
          );
          if (advisory) {
            checks.push({
              severity: "warning", code: "setup.remittanceFrequency",
              ok: false, detail: `${account.accountNumber}: ${advisory}`,
              href: `${setupHref}?tab=accounts`,
            });
          }
        }
        continue;
      }
      const frequencyKey = schedule.frequencySettingsKey;
      if (!frequencyKey) {
        throw new PayrollError(`${schedule.authority} organization-frequency schedule has no settings key`);
      }
      const stored = (blob as Record<string, unknown>)[frequencyKey];
      const declared = typeof stored === "string" && remittanceFrequencyBand(schedule, stored);
      if (!declared) {
        checks.push({
          severity: "warning", code: "setup.remittanceFrequency",
          ok: false,
          detail: typeof stored === "string" && stored
            ? `${schedule.authority} frequency "${stored}" is not declared — ` +
              `the ${schedule.defaultFrequency.replaceAll("_", " ")} frequency applies until it is set in Setup → Payroll`
            : `${schedule.authority} remittance frequency is not set — ` +
              `the ${schedule.defaultFrequency.replaceAll("_", " ")} frequency applies; ` +
              `confirm it against your ${schedule.authority} notice in Setup → Payroll`,
          href: `${setupHref}?tab=accounts`,
        });
      } else {
        const { frequency } = scheduledRemittanceFrequency(
          schedule, blob as Record<string, unknown>,
        );
        checks.push({
          severity: "warning", code: "setup.remittanceFrequency",
          ok: true, detail: `${schedule.authority} · ${frequency}`,
        });
      }
      const advisory = await scheduledFrequencyAdvisory(
        orgId, schedule, vendor, blob as Record<string, unknown>,
        Number(today.slice(0, 4)) - 1,
      );
      if (advisory) {
        checks.push({
          severity: "warning", code: "setup.remittanceFrequency",
          ok: false, detail: advisory, href: `${setupHref}?tab=accounts`,
        });
      }
    }
  }

  // Statutory rates the employer must supply, at the scope the pack declares
  // each one varies by — checked against the regions and filing accounts the
  // org's ACTIVE payroll population actually occupies, so an employer with no
  // Ontario payroll is never nagged about Ontario's health tax. Advisory for
  // the same reason as in the run pre-flight. (Same query as the slot walk
  // above — one population for the whole setup state.)
  for (const country of installed) {
    const missing = await unconfiguredRatesForRun(
      orgId, country, await currentTaxYear(orgId, country), setupPopulation, today,
    );
    if (missing.length === 0) {
      checks.push({
        severity: "warning", code: "setup.statutoryRate", ok: true, detail: country,
      });
      continue;
    }
    for (const item of missing) {
      checks.push({
        severity: "warning", code: "setup.statutoryRate", ok: false,
        detail: item.message, href: `${setupHref}?tab=rates`,
      });
    }
  }

  // A way to pay people: a configured payroll-capable EFT originator profile,
  // or the cheque fallback left on (paper is a legitimate rail, so this is
  // advisory, not a blocker).
  const [paymentMethods, bankProfiles] = await Promise.all([
    payrollPaymentMethodSettings(orgId),
    payrollBankProfiles(orgId),
  ]);
  checks.push({
    severity: "warning", code: "setup.paymentRail",
    ok: paymentMethods.eftFallbackToCheque || bankProfiles.some((profile) => profile.configured),
    href: `${setupHref}?tab=payday`,
  });

  return {
    installedCountries: installed,
    checks,
    blockers: checks.filter((c) => !c.ok && c.severity === "blocker").length,
    warnings: checks.filter((c) => !c.ok && c.severity === "warning").length,
  };
}
