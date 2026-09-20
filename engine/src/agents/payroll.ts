import { sql } from "drizzle-orm";
import { add, cmp, neg, sum } from "../money/money.ts";
import { addCalendarDays, businessToday } from "../platform/business-date.ts";
import {
  effectiveDetectorMateriality,
  type ContinuousCloseDetectorPolicy,
} from "./continuous-close-config.ts";
import { db } from "../platform/db.ts";
import { PayrollError } from "../payroll/error.ts";
import {
  installedPayrollCountries,
  payrollStatutoryRateGaps,
} from "../payroll/readiness.ts";
import {
  payrollRemittanceSummary,
  remittanceDueDateExplained,
  remittanceGroupUsesQuebecCalendar,
} from "../payroll/remittance.ts";
import { packWarnsOnMissingIdentifier, payrollTaxYearForDate } from "../payroll/packs.ts";
import { classifyForensicItem, moneyAbs } from "./measure.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Payroll-compliance pack: remittance due dates from the SAME summary the
 * remittance cockpit bills from, the exact unknown-account refusal predicates
 * the filing and remittance reports fail closed on, missing statutory
 * (TD1/W-4) elections on active profiles, and year-end filing gaps (SINs the
 * slips cannot file without, plus the rates surface's own unconfigured-rate
 * computation). Findings link the payroll remittance cockpit and the employee
 * record for review. A summary blocked by unknown accounts is the same
 * condition the unknown-accounts detector reports, never a second finding.
 * Proposes nothing executable yet; never writes.
 */
export const PAYROLL_DETECTOR_KEYS = [
  "payroll_remittance_due",
  "payroll_unknown_accounts",
  "payroll_missing_elections",
  "payroll_yearend_gaps",
] as const;

const REMITTANCE_HREF = "/payroll/remittances";
const EMPLOYEES_HREF = "/entities/employees";

/** First day of the month after the given first-of-month ISO date. */
function nextMonthStart(first: string): string {
  const year = Number(first.slice(0, 4));
  const month = Number(first.slice(5, 7));
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

/** Last calendar day of the given first-of-month ISO date. */
function monthEndOf(first: string): string {
  return addCalendarDays(nextMonthStart(first), -1);
}

export async function payrollFindings(
  orgId: string,
  agentThreshold: string,
  detectors: ContinuousCloseDetectorPolicy[],
): Promise<AgentFinding[]> {
  const today = await businessToday(orgId);
  const findings: AgentFinding[] = [];
  const byKey = new Map(detectors.map((detector) => [detector.detectorKey, detector]));

  const duePolicy = byKey.get("payroll_remittance_due");
  if (duePolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(duePolicy, agentThreshold);
    const from = addCalendarDays(today, -duePolicy.parameters.lookbackDays!);
    const horizon = addCalendarDays(today, duePolicy.parameters.dueWithinDays!);
    // The cockpit bills per pay period and both dating rules key off the
    // range end — one trailing window would date July withholding off
    // September. Scan calendar month by calendar month instead, then merge
    // slices that share a due date (a quarterly remitter's three monthly
    // slices collapse into the one quarterly bill it will actually raise).
    const months: { from: string; to: string }[] = [];
    for (let cursor = `${from.slice(0, 7)}-01`; cursor <= today; cursor = nextMonthStart(cursor)) {
      const end = monthEndOf(cursor);
      months.push({ from: cursor < from ? from : cursor, to: end > today ? today : end });
    }
    const merged = new Map<
      string,
      {
        fingerprint: string;
        dueDate: string;
        party: string | null;
        authority: string | null;
        frequency: string;
        rule: string;
        provinces: string[];
        total: string;
        billed: string;
        bills: { documentNumber: string; status: string; total: string }[];
      }
    >();
    for (const month of months) {
      let groups: Awaited<ReturnType<typeof payrollRemittanceSummary>>;
      try {
        groups = await payrollRemittanceSummary(orgId, { from: month.from, to: month.to });
      } catch (error) {
        // Unknown filing or liability accounts fail the summary closed for
        // the month that holds them — the unknown-accounts detector below
        // reports that root cause; other months still scan.
        if (!(error instanceof PayrollError)) throw error;
        continue;
      }
      for (const group of groups) {
        // The bill's own dating rule (createRemittanceBill): a pack-declared
        // destination schedule when one governs, otherwise the filing
        // account's CRA remitter-type rule. Never a third copy of either.
        const scheduled = group.schedule;
        const cra = scheduled
          ? null
          : remittanceDueDateExplained(month.to, group.filingAccount.remitterType, {
              quebec: remittanceGroupUsesQuebecCalendar(group.provinces),
            });
        const dueDate = scheduled?.dueDate ?? cra!.dueDate;
        if (dueDate > horizon) continue;
        const fingerprint = `payroll-remittance-due:${group.partyId ?? "unassigned"}:${group.filingAccount.id ?? "none"}:${dueDate}`;
        const billed = sum(
          group.existingBills.filter((bill) => bill.status !== "voided").map((bill) => bill.total),
        );
        const slot = merged.get(fingerprint);
        if (slot) {
          slot.total = add(slot.total, group.total);
          slot.billed = add(slot.billed, billed);
          for (const bill of group.existingBills) {
            if (!slot.bills.some((seen) => seen.documentNumber === bill.documentNumber)) {
              slot.bills.push({ documentNumber: bill.documentNumber, status: bill.status, total: bill.total });
            }
          }
          for (const province of group.provinces) {
            if (!slot.provinces.includes(province)) slot.provinces.push(province);
          }
        } else {
          merged.set(fingerprint, {
            fingerprint,
            dueDate,
            party: group.partyName,
            authority: scheduled?.authority ?? null,
            frequency: scheduled?.frequency ?? group.filingAccount.remitterType ?? "regular",
            rule: scheduled?.rule ?? cra!.rule,
            provinces: [...group.provinces],
            total: group.total,
            billed,
            bills: group.existingBills.map((bill) => ({
              documentNumber: bill.documentNumber,
              status: bill.status,
              total: bill.total,
            })),
          });
        }
      }
    }
    for (const slot of merged.values()) {
      const uncovered = add(slot.total, neg(slot.billed));
      if (cmp(uncovered, threshold) < 0) continue;
      const materiality = moneyAbs(uncovered);
      const overdue = slot.dueDate < today;
      findings.push({
        agentKey: "payroll",
        findingType: "payroll_remittance_due",
        fingerprint: slot.fingerprint,
        severity: overdue
          ? "critical"
          : classifyForensicItem({ materiality, threshold, criticalMaterialityMultiple: duePolicy.parameters.criticalMaterialityMultiple }),
        confidence: "1.0000",
        materiality,
        subjectType: "remittance_group",
        summary: {
          party: slot.party,
          authority: slot.authority,
          frequency: slot.frequency,
          rule: slot.rule,
          dueDate: slot.dueDate,
          overdue,
          total: slot.total,
          billed: slot.billed,
          uncovered,
          provinces: slot.provinces,
          href: REMITTANCE_HREF,
        },
        evidence: [
          {
            kind: "remittance_group",
            sourceType: "remittance_group",
            sourceId: slot.fingerprint.replace("payroll-remittance-due:", ""),
            data: {
              party: slot.party,
              authority: slot.authority,
              frequency: slot.frequency,
              rule: slot.rule,
              dueDate: slot.dueDate,
              total: slot.total,
              billed: slot.billed,
              uncovered,
              existingBills: slot.bills,
            },
          },
        ],
      });
    }
  }

  const unknownPolicy = byKey.get("payroll_unknown_accounts");
  if (unknownPolicy?.enabled) {
    const runs = (await db.execute<{
        run_id: string;
        document_number: string | null;
        unknown_filing_stubs: number;
        unknown_liability_amount: string;
      }>(sql`
      select r.document_id as run_id, min(d.document_number) as document_number,
             count(distinct s.id) filter (where s.filing_account_source = 'unknown')::int as unknown_filing_stubs,
             coalesce(sum(l.amount) filter (
               where l.liability_account_id is null
                 and l.kind in ('deduction', 'employer_contribution', 'credit')
                 and l.amount <> 0), 0)::text as unknown_liability_amount
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
        join pay_stubs s on s.pay_run_document_id = r.document_id and s.org_id = r.org_id
        left join pay_stub_lines l on l.stub_id = s.id and l.org_id = s.org_id
       where r.org_id = ${orgId} and r.run_status = 'committed'
       group by r.document_id
      having count(distinct s.id) filter (where s.filing_account_source = 'unknown') > 0
          or coalesce(sum(l.amount) filter (
               where l.liability_account_id is null
                 and l.kind in ('deduction', 'employer_contribution', 'credit')
                 and l.amount <> 0), 0) <> 0
       order by min(s.pay_date) desc limit 25
    `));
    for (const run of runs.rows) {
      findings.push({
        agentKey: "payroll",
        findingType: "payroll_unknown_accounts",
        fingerprint: `payroll-unknown-accounts:${run.run_id}`,
        severity: "warning",
        confidence: "1.0000",
        materiality: "0.0000",
        subjectType: "pay_run",
        subjectId: run.run_id,
        summary: {
          documentNumber: run.document_number,
          unknownFilingStubs: Number(run.unknown_filing_stubs),
          unknownLiabilityAmount: run.unknown_liability_amount,
          href: REMITTANCE_HREF,
        },
        evidence: [
          {
            kind: "pay_run",
            sourceType: "pay_run",
            sourceId: run.run_id,
            data: {
              documentNumber: run.document_number,
              unknownFilingStubs: Number(run.unknown_filing_stubs),
              unknownLiabilityAmount: run.unknown_liability_amount,
            },
          },
        ],
      });
    }
  }

  const electionsPolicy = byKey.get("payroll_missing_elections");
  if (electionsPolicy?.enabled) {
    const countries = (await db.execute<{ country: string; employees: number }>(sql`
      select prof.country, count(*)::int as employees
        from employee_payroll_profiles prof
       where prof.org_id = ${orgId} and prof.is_active
         and ((prof.country = 'CA' and (prof.federal_claim_code is null or prof.provincial_claim_code is null))
           or (prof.country = 'US' and prof.filing_status is null))
       group by prof.country
    `));
    for (const row of countries.rows) {
      const people = (await db.execute<{ id: string; name: string }>(sql`
        select p.id, p.display_name as name
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
         where prof.org_id = ${orgId} and prof.is_active and prof.country = ${row.country}
           and ((prof.country = 'CA' and (prof.federal_claim_code is null or prof.provincial_claim_code is null))
             or (prof.country = 'US' and prof.filing_status is null))
         order by p.display_name limit 10
      `));
      findings.push({
        agentKey: "payroll",
        findingType: "payroll_missing_elections",
        fingerprint: `payroll-missing-elections:${row.country}`,
        severity: "warning",
        confidence: "1.0000",
        materiality: "0.0000",
        subjectType: "employees",
        summary: {
          country: row.country,
          employees: Number(row.employees),
          href: EMPLOYEES_HREF,
        },
        evidence: people.rows.map((person) => ({
          kind: "employee",
          sourceType: "employee",
          sourceId: person.id,
          data: { name: person.name, country: row.country },
        })),
      });
    }
  }

  const yearendPolicy = byKey.get("payroll_yearend_gaps");
  if (yearendPolicy?.enabled) {
    const blob = (await db.execute<{ p: Record<string, unknown> | null }>(sql`
      select settings->'payroll' as p from orgs where id = ${orgId}
    `));
    const installed = await installedPayrollCountries(orgId, blob.rows[0]?.p ?? {});
    for (const country of installed) {
      const { taxYear } = payrollTaxYearForDate(country, today);
      for (const gap of await payrollStatutoryRateGaps(orgId, country, taxYear)) {
        findings.push({
          agentKey: "payroll",
          findingType: "payroll_yearend_gaps",
          fingerprint: `payroll-yearend-rate-gap:${country}:${taxYear}:${gap.slotKey}:${gap.region ?? ""}`,
          severity: "warning",
          confidence: "1.0000",
          materiality: "0.0000",
          subjectType: "statutory_rate",
          summary: {
            country,
            taxYear,
            slot: gap.slotKey,
            label: gap.label,
            message: gap.message,
            employees: gap.employees.length,
            href: "/admin/setup/payroll?tab=rates",
          },
          evidence: gap.employees.slice(0, 10).map((employee) => ({
            kind: "employee",
            sourceType: "employee",
            sourceId: employee.partyId,
            data: { name: employee.name, country },
          })),
        });
      }
      // The gate is pack-declared, never a country list: this loop already
      // runs once per INSTALLED pack, and gating on two countries would
      // silently exempt every other pack's employees from the year-end
      // identifier check. The pack's own declaration answers instead — the
      // warning fires only when the pack requires the identifier AND names
      // a filing that needs it, so a pack with no filing to feed warns
      // about nothing while one that names one still warns.
      if (!packWarnsOnMissingIdentifier(country)) continue;
      const noSin = (await db.execute<{ employees: number }>(sql`
        select count(*)::int as employees
          from employee_payroll_profiles prof
         where prof.org_id = ${orgId} and prof.is_active and prof.country = ${country}
           and prof.sin_encrypted is null
      `));
      if (Number(noSin.rows[0]?.employees ?? 0) > 0) {
        const people = (await db.execute<{ id: string; name: string }>(sql`
          select p.id, p.display_name as name
            from employee_payroll_profiles prof
            join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
           where prof.org_id = ${orgId} and prof.is_active and prof.country = ${country}
             and prof.sin_encrypted is null
           order by p.display_name limit 10
        `));
        findings.push({
          agentKey: "payroll",
          findingType: "payroll_yearend_gaps",
          fingerprint: `payroll-yearend-no-sin:${country}`,
          severity: "warning",
          confidence: "1.0000",
          materiality: "0.0000",
          subjectType: "employees",
          summary: {
            country,
            employees: Number(noSin.rows[0]?.employees ?? 0),
            reason: "year_end_slips_require_sin",
            href: EMPLOYEES_HREF,
          },
          evidence: people.rows.map((person) => ({
            kind: "employee",
            sourceType: "employee",
            sourceId: person.id,
            data: { name: person.name, country },
          })),
        });
      }
    }
  }

  return findings;
}
