import { sql } from "drizzle-orm";
import { db, withBypass, withOrg } from "./db.ts";
import { cmp } from "./money.ts";

/**
 * Dunning — automated collections over the AR subledger. For each active policy
 * the runner finds overdue open invoices, works out how many days past due each
 * is, and fires the single highest un-fired ladder stage whose offset that
 * invoice has crossed. Firing enqueues a reminder email and writes an
 * append-only dunning_log row; the unique (document, stage) index makes the
 * whole thing idempotent, so re-running the scheduler never double-sends.
 *
 * Collections never touches the ledger — it is a communications layer, so it
 * lives outside the posting kernel entirely.
 */

export interface DunningStage {
  id: string;
  sequence: number;
  name: string;
  offsetDays: number;
  subjectTemplate: string;
  bodyTemplate: string;
  escalate: boolean;
}

/**
 * Pick the one stage to fire for an invoice: the highest-sequence stage whose
 * offset the invoice has crossed and that has not already fired. Returning a
 * single stage (not every crossed threshold) means an invoice that has been
 * overdue for a while gets the most-recent notice, never a burst of back-dated
 * ones. Pure — unit-tested directly.
 */
export function selectDueStage(
  stages: DunningStage[],
  daysOverdue: number,
  firedStageIds: ReadonlySet<string>,
): DunningStage | null {
  const candidates = stages
    .filter((s) => daysOverdue >= s.offsetDays && !firedStageIds.has(s.id))
    .sort((a, b) => b.sequence - a.sequence);
  return candidates[0] ?? null;
}

/** Minimal, dependency-free {{token}} substitution for reminder templates. */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) =>
    key in vars ? String(vars[key]) : "",
  );
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIsoDate: string): number {
  const [ay, am, ad] = fromIso.split("-").map(Number);
  const [by, bm, bd] = toIsoDate.split("-").map(Number);
  return Math.round(
    (Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000,
  );
}

export interface DunningRunResult {
  scanned: number;
  sent: number;
  failed: number;
  notices: { documentId: string; stageId: string; toEmail: string | null; status: string }[];
}

export async function runDunning(asOf?: string): Promise<DunningRunResult> {
  const today = asOf ?? toIso(new Date());
  const result: DunningRunResult = { scanned: 0, sent: 0, failed: 0, notices: [] };

  const orgs = await withBypass(async () => {
    return (await db.execute(sql`
      select distinct org_id as "orgId" from dunning_policies where is_active
    `)) as unknown as { rows: { orgId: string }[] };
  });

  for (const { orgId } of orgs.rows) {
    await withOrg(orgId, async () => {
      const org = (await db.execute(
        sql`select name, base_currency as "baseCurrency" from orgs where id = ${orgId}`,
      )) as unknown as { rows: { name: string; baseCurrency: string }[] };
      const orgName = org.rows[0]?.name ?? "";

      const policies = (await db.execute(sql`
        select id, applies_to_kind as "appliesToKind", grace_period_days as "gracePeriodDays",
               min_balance as "minBalance", reply_to as "replyTo"
          from dunning_policies where org_id = ${orgId} and is_active
      `)) as unknown as {
        rows: {
          id: string;
          appliesToKind: string;
          gracePeriodDays: number;
          minBalance: string;
          replyTo: string | null;
        }[];
      };

      for (const policy of policies.rows) {
        const stageRows = (await db.execute(sql`
          select id, sequence, name, offset_days as "offsetDays",
                 subject_template as "subjectTemplate", body_template as "bodyTemplate", escalate
            from dunning_stages where policy_id = ${policy.id} and org_id = ${orgId}
           order by sequence
        `)) as unknown as { rows: DunningStage[] };
        if (!stageRows.rows.length) continue;

        // Overdue open documents of the policy's kind, with the live balance due
        // reconstructed from un-reversed applications against the open-item leg.
        const docs = (await db.execute(sql`
          select d.id, d.document_number as "documentNumber", d.due_date as "dueDate",
                 d.currency, d.total, p.id as "partyId", p.display_name as "partyName",
                 p.email as "partyEmail",
                 (d.total - coalesce(ap.applied, 0)) as "balanceDue"
            from documents d
            left join parties p on p.id = d.party_id and p.org_id = d.org_id
            left join lateral (
              select coalesce(sum(a.amount), 0) as applied
                from journal_lines jl
                join applications a on a.org_id = jl.org_id and a.to_line_id = jl.id and a.unapplied_at is null
               where jl.org_id = d.org_id and jl.entry_id = d.posted_entry_id and jl.is_open_item
            ) ap on true
           where d.org_id = ${orgId} and d.kind = ${policy.appliesToKind}
             and d.status = 'posted' and d.due_date is not null and d.due_date < ${today}
        `)) as unknown as {
          rows: {
            id: string;
            documentNumber: string;
            dueDate: string;
            currency: string | null;
            total: string;
            partyId: string | null;
            partyName: string | null;
            partyEmail: string | null;
            balanceDue: string;
          }[];
        };

        for (const doc of docs.rows) {
          result.scanned += 1;
          if (cmp(doc.balanceDue, policy.minBalance) <= 0) continue;
          const daysOverdue = daysBetween(doc.dueDate, today);
          if (daysOverdue < policy.gracePeriodDays) continue;

          const fired = (await db.execute(sql`
            select stage_id as "stageId" from dunning_log where document_id = ${doc.id} and org_id = ${orgId}
          `)) as unknown as { rows: { stageId: string }[] };
          const firedIds = new Set(fired.rows.map((r) => r.stageId));

          const stage = selectDueStage(stageRows.rows, daysOverdue, firedIds);
          if (!stage) continue;

          const vars = {
            party: doc.partyName ?? "",
            invoice: doc.documentNumber,
            amount: `${doc.currency ?? ""} ${doc.balanceDue}`.trim(),
            dueDate: doc.dueDate,
            daysOverdue,
            orgName,
          };
          const subject = renderTemplate(stage.subjectTemplate, vars);
          const body = renderTemplate(stage.bodyTemplate, vars);
          const to = doc.partyEmail;

          let status: "sent" | "failed" | "skipped" = "sent";
          let detail: string | null = null;
          if (!to) {
            status = "skipped";
            detail = "no billing email on the customer record";
          } else {
            try {
              const { enqueueEmail } = await import("@openbooks/jobs");
              await enqueueEmail({
                orgId,
                to,
                subject,
                html: `<p>${body.replace(/\n/g, "<br/>")}</p>`,
                text: body,
                meta: { category: "dunning" },
              });
            } catch (e) {
              status = "failed";
              detail = e instanceof Error ? e.message : String(e);
            }
          }

          // The unique (document, stage) index is the idempotency guard: if a
          // concurrent tick already logged this stage, the insert no-ops.
          await db.execute(sql`
            insert into dunning_log (org_id, document_id, policy_id, stage_id, party_id, to_email,
                                     amount_due, currency_code, channel, status, detail)
            values (${orgId}, ${doc.id}, ${policy.id}, ${stage.id}, ${doc.partyId}, ${to},
                    ${doc.balanceDue}, ${doc.currency}, 'email', ${status}, ${detail})
            on conflict (document_id, stage_id) do nothing
          `);

          if (status === "sent") result.sent += 1;
          else if (status === "failed") result.failed += 1;
          result.notices.push({ documentId: doc.id, stageId: stage.id, toEmail: to, status });
        }
      }
    });
  }
  return result;
}
