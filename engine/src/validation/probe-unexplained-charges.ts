/**
 * Explain replay invoices whose only extra line is a commercial adjustment.
 *
 * This is deliberately read-only. It shows the labor basis by department and
 * the exact rate-card adjustment resolved for that work, so a missing legacy
 * charge is not mistaken for a pricing-engine defect without evidence.
 *
 * Usage:
 *   npx tsx --conditions=react-server src/validation/probe-unexplained-charges.ts INV0189 [INV0196 ...]
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { findLapsedRateCard, resolveRateAdjustments } from "../../../web/lib/rate-adjustments.ts";

const ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const named = process.argv.slice(2).filter((arg) => /^INV\d+$/i.test(arg));

async function retry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const chain: string[] = [];
      for (let cause: any = error; cause; cause = cause.cause) {
        chain.push(String(cause?.message ?? ""));
      }
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(chain.join(" "))) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
    }
  }
  throw last;
}

interface SourceInvoice {
  tranid: string;
  job: string;
}

(async () => {
  const invoices = JSON.parse(readFileSync("/tmp/ft-invoices.json", "utf8")) as SourceInvoice[];
  const report = readFileSync("/tmp/parity-report.tsv", "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t"))
    .filter((columns) => columns[6]?.includes("cause not identified"))
    .map((columns) => columns[0]!);
  const wanted = named.length ? named : report;

  for (const tranid of wanted) {
    const invoice = invoices.find((candidate) => candidate.tranid === tranid);
    if (!invoice) {
      console.log(`${tranid}: not in /tmp/ft-invoices.json`);
      continue;
    }

    const project = (await retry(() => db.execute(sql`
      select id from projects
       where org_id = ${ORG} and custom->>'nsId' = ${invoice.job}
       limit 1
    `))) as unknown as { rows: { id: string }[] };
    const projectId = project.rows[0]?.id;
    if (!projectId) {
      console.log(`${tranid}: project ${invoice.job} is not present`);
      continue;
    }

    const replay = (await retry(() => db.execute(sql`
      select id from documents
       where org_id = ${ORG} and memo = ${`Replay of ${tranid}`}
       order by created_at desc limit 1
    `))) as unknown as { rows: { id: string }[] };
    const replayId = replay.rows[0]?.id;
    if (!replayId) {
      console.log(`${tranid}: no replay document`);
      continue;
    }

    const labor = (await retry(() => db.execute(sql`
      select te.department_id as "departmentId", coalesce(dp.name, '(none)') as department,
             min(te.worked_on)::text as "firstWorkedOn", max(te.worked_on)::text as "lastWorkedOn",
             count(*)::int as lines, sum(dl.amount)::text as amount
        from document_lines dl
        join time_entries te on te.id = dl.time_entry_id
        left join departments dp on dp.id = te.department_id
       where dl.document_id = ${replayId}
       group by te.department_id, dp.name
       order by dp.name nulls first
    `))) as unknown as {
      rows: {
        departmentId: string | null;
        department: string;
        firstWorkedOn: string;
        lastWorkedOn: string;
        lines: number;
        amount: string;
      }[];
    };

    console.log(`\n${tranid} · source job ${invoice.job}`);
    for (const group of labor.rows) {
      const lapsed = await findLapsedRateCard({
        orgId: ORG,
        projectId,
        onDate: group.lastWorkedOn,
        departmentId: group.departmentId,
      });
      const adjustments = await resolveRateAdjustments({
        orgId: ORG,
        projectId,
        onDate: lapsed?.lastEffectiveTo ?? group.lastWorkedOn,
        departmentId: group.departmentId,
      });
      const separate = adjustments
        .filter((adjustment) => adjustment.presentation === "separate")
        .map((adjustment) =>
          `${adjustment.name} ${adjustment.value ?? "?"}${adjustment.calculation === "percent" ? "%" : ""}`,
        )
        .join(", ");
      console.log(
        `  ${group.department}:${group.departmentId ?? "none"}: ${group.lines} labor line(s), $${Number(group.amount).toFixed(2)}, ` +
        `${group.firstWorkedOn}..${group.lastWorkedOn}; ${separate || "no separate adjustment"}` +
        `${lapsed ? ` (carried from ${lapsed.lastEffectiveTo ?? "unknown"})` : ""}`,
      );
    }

    const cards = (await retry(() => db.execute(sql`
      select b.code, b.name, v.id as "versionId", v.effective_from::text as "effectiveFrom",
             v.effective_to::text as "effectiveTo",
             coalesce(string_agg(distinct coalesce(dp.name || ':' || vs.scope_value_id::text, vs.scope_type || ':' || vs.scope_value_id::text), ', '), '(unscoped)') as scopes,
             coalesce(string_agg(distinct a.name || '=' || a.value::text || ' (' || a.presentation || ')', ', '), '(none)') as adjustments
        from item_rate_book_assignments assignment
        join item_rate_books b on b.id = assignment.rate_book_id
        join item_rate_versions v on v.rate_book_id = b.id
        left join labor_rate_version_scopes vs on vs.version_id = v.id
        left join departments dp on vs.scope_type = 'department' and dp.id = vs.scope_value_id
        left join labor_rate_adjustments a on a.version_id = v.id and a.is_active
       where assignment.org_id = ${ORG} and assignment.project_id = ${projectId}
       group by b.code, b.name, v.id, v.effective_from, v.effective_to
       order by v.effective_from, b.code
    `))) as unknown as {
      rows: {
        code: string;
        name: string;
        versionId: string;
        effectiveFrom: string;
        effectiveTo: string | null;
        scopes: string;
        adjustments: string;
      }[];
    };
    for (const card of cards.rows) {
      console.log(
        `  card ${card.code} · ${card.effectiveFrom}..${card.effectiveTo ?? "open"} · ` +
        `${card.scopes} · ${card.adjustments}`,
      );
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
