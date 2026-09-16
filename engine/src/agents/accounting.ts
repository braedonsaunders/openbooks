import { sql } from "drizzle-orm";
import { reconciliationTotals, SYSTEM_ACTOR_ID } from "../banking.ts";
import { addCalendarDays, businessToday, parseIsoDate } from "../business-date.ts";
import { db } from "../db.ts";
import { toUnits } from "../money.ts";
import {
  effectiveDetectorMateriality,
  type ContinuousCloseDetectorPolicy,
} from "../continuous-close-config.ts";
import { absoluteUnits, classifyUnmatchedBankActivity, moneyAbs } from "./measure.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Accounting pack — close-readiness controls. Byte-identical behaviour to the
 * original control-plane implementation; only the location changed so every
 * agent pack shares the registry in registry.ts.
 */
export async function accountingFindings(
  orgId: string,
  agentThreshold: string,
  detectors: ContinuousCloseDetectorPolicy[],
): Promise<AgentFinding[]> {
  const today = await businessToday(orgId);
  const findings: AgentFinding[] = [];
  const byKey = new Map(detectors.map((detector) => [detector.detectorKey, detector]));
  const unmatchedPolicy = byKey.get("unmatched_bank_activity");
  if (unmatchedPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(unmatchedPolicy, agentThreshold);
    const unmatched = (await db.execute<{
        account_id: string;
        number: string | null;
        name: string;
        line_count: number;
        oldest_date: string;
        materiality: string;
      }>(sql`
      select a.id as account_id, a.number, a.name, count(*)::int as line_count,
             min(l.posted_on) as oldest_date, sum(abs(l.amount))::text as materiality
      from bank_statement_lines l
      join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
        join accounts a on a.id = s.account_id and a.org_id = s.org_id
       where l.org_id = ${orgId} and l.match_status = 'unmatched' and l.posted_on <= ${today}
       group by a.id, a.number, a.name
    `));

    for (const row of unmatched.rows) {
      const top = (await db.execute<Record<string, unknown>>(sql`
      select l.id, l.posted_on, l.amount::text, l.description, l.counterparty_ref
        from bank_statement_lines l
        join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
       where l.org_id = ${orgId} and s.account_id = ${row.account_id}
         and l.match_status = 'unmatched' and l.posted_on <= ${today}
       order by abs(l.amount) desc, l.posted_on
       limit 10
    `));
    const materiality = moneyAbs(row.materiality);
    findings.push({
        agentKey: "accounting",
        findingType: "unmatched_bank_activity",
        fingerprint: `unmatched-bank:${row.account_id}`,
        severity: classifyUnmatchedBankActivity({
          materiality,
          threshold,
          oldestDate: row.oldest_date,
          count: Number(row.line_count),
          now: parseIsoDate(today),
          criticalAgeDays: unmatchedPolicy.parameters.criticalAgeDays,
          criticalItemCount: unmatchedPolicy.parameters.criticalItemCount,
          criticalMaterialityMultiple: unmatchedPolicy.parameters.criticalMaterialityMultiple,
        }),
        confidence: "1.0000",
        materiality,
        subjectType: "account",
      subjectId: row.account_id,
      summary: {
        accountNumber: row.number,
        accountName: row.name,
        count: Number(row.line_count),
        oldestDate: row.oldest_date,
        href: `/banking/${row.account_id}`,
      },
      evidence: top.rows.map((item) => ({
        kind: "bank_transaction",
        sourceType: "bank_statement_line",
        sourceId: String(item.id),
        data: {
          postedOn: item.posted_on,
          amount: item.amount,
          description: item.description,
          counterpartyRef: item.counterparty_ref,
        },
        })),
      });
    }
  }

  const reconciliationPolicy = byKey.get("reconciliation_difference");
  if (reconciliationPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(reconciliationPolicy, agentThreshold);
    const reconciliations = (await db.execute<{
        id: string;
        account_id: string;
        through_date: string;
        statement_balance: string;
        number: string | null;
        name: string;
      }>(sql`
      select r.id, r.account_id, r.through_date, r.statement_balance::text,
             a.number, a.name
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.org_id = ${orgId} and r.status = 'in_progress'
    `));

    for (const record of reconciliations.rows) {
      const { difference } = await reconciliationTotals(record.id, { orgId, userId: SYSTEM_ACTOR_ID });
      const row = { ...record, difference };
      if (toUnits(row.difference) === 0n) continue;
    const materiality = moneyAbs(row.difference);
    findings.push({
      agentKey: "accounting",
      findingType: "reconciliation_difference",
      fingerprint: `reconciliation-difference:${row.id}`,
      severity: absoluteUnits(materiality) >= absoluteUnits(threshold) ? "critical" : "warning",
      confidence: "1.0000",
      materiality,
      subjectType: "reconciliation",
      subjectId: row.id,
      summary: {
        accountNumber: row.number,
        accountName: row.name,
        throughDate: row.through_date,
        statementBalance: row.statement_balance,
          difference: row.difference,
          href: `/banking/${row.account_id}/reconcile/${row.id}`,
        },
        evidence: [
          {
            kind: "reconciliation",
            sourceType: "reconciliation",
            sourceId: row.id,
            data: {
              statementBalance: row.statement_balance,
              difference: row.difference,
              throughDate: row.through_date,
            },
          },
        ],
      });
    }
  }

  const stalePolicy = byKey.get("stale_accounting_documents");
  if (stalePolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(stalePolicy, agentThreshold);
    const staleAfterDays = stalePolicy.parameters.staleAfterDays!;
    const staleOnOrBefore = addCalendarDays(today, -staleAfterDays);
    const stale = (await db.execute<{
        document_count: number;
        oldest_date: string | null;
        materiality: string;
      }>(sql`
      select count(*)::int as document_count, min(document_date) as oldest_date,
             coalesce(sum(abs(total)), 0)::text as materiality
        from documents
       where org_id = ${orgId} and status in ('draft','pending_approval')
         and document_date <= ${staleOnOrBefore}
         and kind in ('vendor_bill','vendor_credit','customer_invoice','customer_credit','expense_report','journal')
    `));
    const staleRow = stale.rows[0];
    if (staleRow && Number(staleRow.document_count) > 0) {
      const documents = (await db.execute<Record<string, unknown>>(sql`
        select id, kind, document_number, document_date, status, total::text
          from documents
         where org_id = ${orgId} and status in ('draft','pending_approval')
           and document_date <= ${staleOnOrBefore}
           and kind in ('vendor_bill','vendor_credit','customer_invoice','customer_credit','expense_report','journal')
         order by document_date, abs(total) desc limit 10
      `));
    const materiality = moneyAbs(staleRow.materiality);
    findings.push({
        agentKey: "accounting",
        findingType: "stale_accounting_documents",
        fingerprint: "stale-accounting-documents",
        severity: Number(staleRow.document_count) >= stalePolicy.parameters.criticalItemCount! || absoluteUnits(materiality) >= absoluteUnits(threshold) * BigInt(stalePolicy.parameters.criticalMaterialityMultiple!) ? "critical" : "warning",
        confidence: "1.0000",
        materiality,
        subjectType: "documents",
        summary: {
          count: Number(staleRow.document_count),
          oldestDate: staleRow.oldest_date,
          href: "/close",
        },
        evidence: documents.rows.map((item) => ({
          kind: "document",
          sourceType: "document",
        sourceId: String(item.id),
        data: {
          kind: item.kind,
          documentNumber: item.document_number,
          documentDate: item.document_date,
          status: item.status,
          total: item.total,
        },
        })),
      });
    }
  }

  return findings;
}
