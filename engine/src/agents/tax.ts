import { sql } from "drizzle-orm";
import { addCalendarDays, businessToday } from "../business-date.ts";
import {
  effectiveDetectorMateriality,
  type ContinuousCloseDetectorPolicy,
} from "../continuous-close-config.ts";
import { db } from "../db.ts";
import { computeTaxReturn, TaxReturnError } from "../tax-return.ts";
import { absoluteUnits, classifyForensicItem, moneyAbs } from "./measure.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Tax-readiness pack: the filing posture per configured return form —
 * documents missing tax codes (the same population the
 * documents_missing_tax_code review list watches), return boxes computed by
 * the SAME engine the filing screen uses (computeTaxReturn), missing
 * registrations, and unset period locks. Findings link the /tax filing
 * cockpit for lock/filing review; a computable return emits nothing. Proposes
 * nothing executable yet (no pack proposal flow exists in the control plane);
 * never writes.
 */
export const TAX_DETECTOR_KEYS = [
  "tax_missing_codes",
  "tax_missing_registration",
  "tax_return_blocked",
  "tax_unlocked_period",
] as const;

export async function taxFindings(
  orgId: string,
  agentThreshold: string,
  detectors: ContinuousCloseDetectorPolicy[],
): Promise<AgentFinding[]> {
  const today = await businessToday(orgId);
  const findings: AgentFinding[] = [];
  const byKey = new Map(detectors.map((detector) => [detector.detectorKey, detector]));

  const activeForms = (await db.execute<{ code: string; name: string }>(sql`
    select code, name from tax_return_forms where org_id = ${orgId} and is_active order by code
  `)).rows;

  const formRegistration = async (formCode: string): Promise<string | null> => {
    const reg = (await db.execute<{ id: string }>(sql`
      select id from tax_registrations
       where org_id = ${orgId} and is_active and return_form_code = ${formCode}
       limit 1
    `));
    return reg.rows[0]?.id ?? null;
  };

  const codesPolicy = byKey.get("tax_missing_codes");
  if (codesPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(codesPolicy, agentThreshold);
    const from = addCalendarDays(today, -codesPolicy.parameters.lookbackDays!);
    for (const kind of ["customer_invoice", "customer_credit", "vendor_bill", "vendor_credit", "expense_report", "card_charge"]) {
      const agg = (await db.execute<{ documents: number; untaxed_amount: string }>(sql`
        select count(distinct d.id)::int as documents, coalesce(sum(dl.amount), 0)::text as untaxed_amount
          from documents d
          join document_lines dl on dl.document_id = d.id and dl.org_id = d.org_id
         where d.org_id = ${orgId} and d.kind = ${kind} and d.status = 'posted'
           and d.document_date between ${from} and ${today}
           and dl.tax_code_id is null and dl.amount <> 0
      `));
      const row = agg.rows[0];
      if (!row || Number(row.documents) === 0) continue;
      const materiality = moneyAbs(row.untaxed_amount);
      if (absoluteUnits(materiality) < absoluteUnits(threshold)) continue;
      const docs = (await db.execute<{
          id: string;
          document_number: string | null;
          document_date: string;
          untaxed_lines: number;
          untaxed_amount: string;
          party: string;
        }>(sql`
        select d.id, d.document_number, d.document_date::text as document_date,
               count(dl.id)::int as untaxed_lines, sum(dl.amount)::text as untaxed_amount,
               coalesce(p.display_name, '') as party
          from documents d
          join document_lines dl on dl.document_id = d.id and dl.org_id = d.org_id
          left join parties p on p.id = d.party_id and p.org_id = d.org_id
         where d.org_id = ${orgId} and d.kind = ${kind} and d.status = 'posted'
           and d.document_date between ${from} and ${today}
           and dl.tax_code_id is null and dl.amount <> 0
         group by d.id, d.document_number, d.document_date, p.display_name
         order by sum(abs(dl.amount)) desc limit 5
      `));
      findings.push({
        agentKey: "tax",
        findingType: "tax_missing_codes",
        fingerprint: `tax-missing-codes:${kind}`,
        severity: classifyForensicItem({ materiality, threshold, criticalMaterialityMultiple: codesPolicy.parameters.criticalMaterialityMultiple }),
        confidence: "1.0000",
        materiality,
        subjectType: "documents",
        summary: {
          kind,
          documents: Number(row.documents),
          untaxedAmount: row.untaxed_amount,
          from,
          to: today,
          href: "/tax",
        },
        evidence: docs.rows.map((doc) => ({
          kind: "document",
          sourceType: "document",
          sourceId: doc.id,
          data: {
            documentNumber: doc.document_number,
            documentDate: doc.document_date,
            party: doc.party || null,
            untaxedLines: Number(doc.untaxed_lines),
            untaxedAmount: doc.untaxed_amount,
          },
        })),
      });
    }
  }

  const registrationPolicy = byKey.get("tax_missing_registration");
  if (registrationPolicy?.enabled) {
    for (const form of activeForms) {
      if (await formRegistration(form.code)) continue;
      findings.push({
        agentKey: "tax",
        findingType: "tax_missing_registration",
        fingerprint: `tax-missing-registration:${form.code}`,
        severity: "warning",
        confidence: "1.0000",
        materiality: "0.0000",
        subjectType: "tax_return_form",
        subjectId: form.code,
        summary: {
          formCode: form.code,
          formName: form.name,
          href: "/tax",
        },
        evidence: [
          {
            kind: "tax_return_form",
            sourceType: "tax_return_form",
            sourceId: form.code,
            data: { formCode: form.code, formName: form.name },
          },
        ],
      });
    }
  }

  const blockedPolicy = byKey.get("tax_return_blocked");
  if (blockedPolicy?.enabled) {
    const from = addCalendarDays(today, -blockedPolicy.parameters.lookbackDays!);
    for (const form of activeForms) {
      // An unregistered form is a tax_missing_registration finding, never a
      // broken computation: only a form with a filing identity must compute.
      if (!(await formRegistration(form.code))) continue;
      try {
        await computeTaxReturn(orgId, form.code, from, today);
      } catch (error) {
        if (!(error instanceof TaxReturnError)) throw error;
        findings.push({
          agentKey: "tax",
          findingType: "tax_return_blocked",
          fingerprint: `tax-return-blocked:${form.code}`,
          severity: "critical",
          confidence: "1.0000",
          materiality: "0.0000",
          subjectType: "tax_return_form",
          subjectId: form.code,
          summary: {
            formCode: form.code,
            formName: form.name,
            from,
            to: today,
            error: error.message,
            href: "/tax",
          },
          evidence: [
            {
              kind: "tax_return",
              sourceType: "tax_return_form",
              sourceId: form.code,
              data: { formCode: form.code, from, to: today, error: error.message },
            },
          ],
        });
      }
    }
  }

  const unlockPolicy = byKey.get("tax_unlocked_period");
  if (unlockPolicy?.enabled && activeForms.length > 0) {
    const periods = (await db.execute<{ id: string; name: string; starts_on: string; ends_on: string }>(sql`
      select p.id, p.name, p.starts_on, p.ends_on
        from accounting_periods p
        join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
       where p.org_id = ${orgId} and fc.is_default and fc.is_active
         and not p.is_adjustment and p.ends_on < ${today}
       order by p.ends_on desc limit 1
    `));
    const period = periods.rows[0];
    if (period) {
      const book = (await db.execute<{ id: string }>(sql`
        select id from accounting_books where org_id = ${orgId} and is_primary limit 1
      `));
      const bookId = book.rows[0]?.id ?? null;
      const locked = bookId
        ? (await db.execute<{ id: string }>(sql`
            select id from period_locks
             where org_id = ${orgId} and period_id = ${period.id}
               and book_id = ${bookId} and module = 'tax' and state = 'closed'
             limit 1
          `))
        : { rows: [] as { id: string }[] };
      if (locked.rows.length === 0) {
        findings.push({
          agentKey: "tax",
          findingType: "tax_unlocked_period",
          fingerprint: `tax-unlocked-period:${period.id}`,
          severity: "warning",
          confidence: "1.0000",
          materiality: "0.0000",
          subjectType: "accounting_period",
          subjectId: period.id,
          summary: {
            periodName: period.name,
            from: period.starts_on,
            to: period.ends_on,
            href: "/tax",
          },
          evidence: [
            {
              kind: "accounting_period",
              sourceType: "accounting_period",
              sourceId: period.id,
              data: { periodName: period.name, from: period.starts_on, to: period.ends_on },
            },
          ],
        });
      }
    }
  }

  return findings;
}
