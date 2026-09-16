import { sql } from "drizzle-orm";
import { addCalendarDays, businessToday } from "../business-date.ts";
import { db } from "../db.ts";
import {
  effectiveDetectorMateriality,
  type ContinuousCloseDetectorPolicy,
} from "../continuous-close-config.ts";
import { classifyForensicItem, moneyAbs } from "./measure.ts";
import type { AgentFinding } from "./types.ts";

/**
 * Forensics pack — the scheduled sentinel dashboard
 * (`web/lib/analytics/sentinel-data.ts`) diffed against the last run. The
 * spend population (seven non-voided spend kinds), the threshold-trap
 * predicate, and the duplicate candidate set are transcribed from that
 * dashboard so the pack can never watch a different population. Each item
 * carries a stable per-document (or per-pair) fingerprint, so the run upsert
 * surfaces only genuinely NEW items and auto-resolves cleared ones — the
 * diff needs no second state store. Proposes sentinel review; never writes.
 */
export const FORENSICS_DETECTOR_KEYS = [
  "forensic_weekend_postings",
  "forensic_round_dollar",
  "forensic_threshold_trap",
  "forensic_duplicate_bills",
] as const;

type SpendDoc = {
  id: string;
  document_number: string | null;
  kind: string;
  date: string;
  total: string;
  party_id: string | null;
  party_name: string;
};

function itemFinding(
  findingType: string,
  fingerprint: string,
  row: SpendDoc,
  materiality: string,
  threshold: string,
  criticalMaterialityMultiple: number | undefined,
  extra: Record<string, unknown>,
): AgentFinding {
  return {
    agentKey: "forensics",
    findingType,
    fingerprint,
    severity: classifyForensicItem({ materiality, threshold, criticalMaterialityMultiple }),
    confidence: "1.0000",
    materiality,
    subjectType: "document",
    subjectId: row.id,
    summary: {
      documentNumber: row.document_number,
      kind: row.kind,
      date: row.date,
      total: row.total,
      party: row.party_name || null,
      href: "/analytics/sentinel",
      ...extra,
    },
    evidence: [
      {
        kind: "document",
        sourceType: "document",
        sourceId: row.id,
        data: {
          documentNumber: row.document_number,
          kind: row.kind,
          date: row.date,
          total: row.total,
          party: row.party_name || null,
          ...extra,
        },
      },
    ],
  };
}

export async function forensicsFindings(
  orgId: string,
  agentThreshold: string,
  detectors: ContinuousCloseDetectorPolicy[],
): Promise<AgentFinding[]> {
  const today = await businessToday(orgId);
  const findings: AgentFinding[] = [];
  const byKey = new Map(detectors.map((detector) => [detector.detectorKey, detector]));
  const spendKinds = sql`'vendor_bill','vendor_credit','vendor_payment','check','expense_report','journal','customer_credit'`;

  const weekendPolicy = byKey.get("forensic_weekend_postings");
  if (weekendPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(weekendPolicy, agentThreshold);
    const from = addCalendarDays(today, -weekendPolicy.parameters.lookbackDays!);
    const rows = (await db.execute<SpendDoc & { day_of_week: number }>(sql`
      select d.id, d.document_number, d.kind, coalesce(d.document_date, d.posting_date)::text as date,
             d.total::text as total, d.party_id, coalesce(p.display_name, '') as party_name,
             extract(dow from coalesce(d.document_date, d.posting_date))::int as day_of_week
        from documents d
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
       where d.org_id = ${orgId} and d.voided_at is null
         and d.kind in (${spendKinds})
         and coalesce(d.document_date, d.posting_date) >= ${from}
         and coalesce(d.document_date, d.posting_date) <= ${today}
         and extract(dow from coalesce(d.document_date, d.posting_date)) in (0, 6)
         and abs(coalesce(d.total, 0)) >= ${threshold}::numeric
       order by abs(d.total) desc limit 25
    `));
    for (const row of rows.rows) {
      const materiality = moneyAbs(row.total);
      findings.push(itemFinding("forensic_weekend_postings", `forensic-weekend:${row.id}`, row, materiality, threshold, weekendPolicy.parameters.criticalMaterialityMultiple, {
        dayOfWeek: row.day_of_week === 0 ? "sunday" : "saturday",
      }));
    }
  }

  const roundPolicy = byKey.get("forensic_round_dollar");
  if (roundPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(roundPolicy, agentThreshold);
    const from = addCalendarDays(today, -roundPolicy.parameters.lookbackDays!);
    const rows = (await db.execute<SpendDoc>(sql`
      select d.id, d.document_number, d.kind, coalesce(d.document_date, d.posting_date)::text as date,
             d.total::text as total, d.party_id, coalesce(p.display_name, '') as party_name
        from documents d
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
       where d.org_id = ${orgId} and d.voided_at is null
         and d.kind in (${spendKinds})
         and coalesce(d.document_date, d.posting_date) >= ${from}
         and coalesce(d.document_date, d.posting_date) <= ${today}
         and abs(coalesce(d.total, 0)) >= 1000
         and abs(coalesce(d.total, 0)) = trunc(abs(coalesce(d.total, 0)))
         and trunc(abs(coalesce(d.total, 0)))::bigint % 1000 = 0
         and abs(coalesce(d.total, 0)) >= ${threshold}::numeric
       order by abs(d.total) desc limit 25
    `));
    for (const row of rows.rows) {
      const materiality = moneyAbs(row.total);
      findings.push(itemFinding("forensic_round_dollar", `forensic-round-dollar:${row.id}`, row, materiality, threshold, roundPolicy.parameters.criticalMaterialityMultiple, {}));
    }
  }

  const trapPolicy = byKey.get("forensic_threshold_trap");
  if (trapPolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(trapPolicy, agentThreshold);
    const from = addCalendarDays(today, -trapPolicy.parameters.lookbackDays!);
    const rows = (await db.execute<SpendDoc & { trap: string }>(sql`
      select d.id, d.document_number, d.kind, coalesce(d.document_date, d.posting_date)::text as date,
             d.total::text as total, d.party_id, coalesce(p.display_name, '') as party_name,
             case when trunc(abs(coalesce(d.total, 0)))::bigint % 10000 = 9999 then '9999'
                  when trunc(abs(coalesce(d.total, 0)))::bigint % 1000 = 999 then '999'
                  else '99' end as trap
        from documents d
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
       where d.org_id = ${orgId} and d.voided_at is null
         and d.kind in (${spendKinds})
         and coalesce(d.document_date, d.posting_date) >= ${from}
         and coalesce(d.document_date, d.posting_date) <= ${today}
         and trunc(abs(coalesce(d.total, 0)))::bigint % 100 = 99
         and round((abs(coalesce(d.total, 0)) - trunc(abs(coalesce(d.total, 0)))) * 100) in (0, 99)
         and abs(coalesce(d.total, 0)) >= ${threshold}::numeric
       order by abs(d.total) desc limit 25
    `));
    for (const row of rows.rows) {
      const materiality = moneyAbs(row.total);
      findings.push(itemFinding("forensic_threshold_trap", `forensic-threshold-trap:${row.id}`, row, materiality, threshold, trapPolicy.parameters.criticalMaterialityMultiple, {
        trap: row.trap,
      }));
    }
  }

  const duplicatePolicy = byKey.get("forensic_duplicate_bills");
  if (duplicatePolicy?.enabled) {
    const threshold = effectiveDetectorMateriality(duplicatePolicy, agentThreshold);
    const from = addCalendarDays(today, -duplicatePolicy.parameters.lookbackDays!);
    const pairs = (await db.execute<{
        id1: string;
        num1: string | null;
        date1: string;
        id2: string;
        num2: string | null;
        date2: string;
        kind: string;
        amount: string;
        party_id: string;
        party_name: string;
        days_between: number;
        same_memo: boolean;
      }>(sql`
      with cand as materialized (
        select d.id, d.document_number, d.kind, d.party_id, d.memo, abs(d.total) as amt,
               coalesce(d.document_date, d.posting_date) as ddate
          from documents d
         where d.org_id = ${orgId} and d.voided_at is null
           and d.kind in ('vendor_bill', 'check', 'expense_report', 'vendor_payment')
           and d.party_id is not null
           and abs(coalesce(d.total, 0)) >= ${threshold}::numeric
           and coalesce(d.document_date, d.posting_date) >= ${from}
           and coalesce(d.document_date, d.posting_date) <= ${today}
      )
      select d1.id as id1, d1.document_number as num1, d1.ddate::text as date1,
             d2.id as id2, d2.document_number as num2, d2.ddate::text as date2,
             d1.kind, d1.amt::text as amount, d1.party_id,
             coalesce(p.display_name, '') as party_name,
             abs(d2.ddate - d1.ddate) as days_between,
             (d1.memo is not null and d1.memo = d2.memo) as same_memo
        from cand d1
        join cand d2 on d2.kind = d1.kind and d2.party_id = d1.party_id
          and d2.amt = d1.amt and d2.id > d1.id
        left join parties p on p.id = d1.party_id and p.org_id = ${orgId}
       where abs(d2.ddate - d1.ddate) <= ${duplicatePolicy.parameters.duplicateDays!}
       order by d1.amt desc limit 25
    `));
    for (const pair of pairs.rows) {
      const materiality = moneyAbs(pair.amount);
      findings.push({
        agentKey: "forensics",
        findingType: "forensic_duplicate_bills",
        fingerprint: `forensic-duplicate:${pair.id1}:${pair.id2}`,
        severity: classifyForensicItem({ materiality, threshold, criticalMaterialityMultiple: duplicatePolicy.parameters.criticalMaterialityMultiple }),
        confidence: "1.0000",
        materiality,
        subjectType: "document",
        subjectId: pair.id1,
        summary: {
          kind: pair.kind,
          amount: pair.amount,
          party: pair.party_name || null,
          documentNumber: pair.num1,
          duplicateDocumentNumber: pair.num2,
          date: pair.date1,
          duplicateDate: pair.date2,
          daysBetween: Number(pair.days_between),
          sameMemo: pair.same_memo,
          href: "/analytics/sentinel",
        },
        evidence: [
          {
            kind: "document",
            sourceType: "document",
            sourceId: pair.id1,
            data: { documentNumber: pair.num1, kind: pair.kind, date: pair.date1, amount: pair.amount },
          },
          {
            kind: "document",
            sourceType: "document",
            sourceId: pair.id2,
            data: { documentNumber: pair.num2, kind: pair.kind, date: pair.date2, amount: pair.amount },
          },
        ],
      });
    }
  }

  return findings;
}
