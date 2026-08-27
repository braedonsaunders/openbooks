import { sql } from "drizzle-orm";
import { db, withBypass, withOrg } from "./db.ts";
import { addCalendarDays, businessToday } from "./business-date.ts";
import { cmp } from "./money.ts";
import { enqueueFlowEmail } from "./scheduler-outbox.ts";

/**
 * Dunning — automated collections over the AR subledger. For each active policy
 * the runner finds open documents inside the ladder's reach — overdue ones and,
 * for negative-offset courtesy stages, documents approaching their due date —
 * computes each one's signed distance from its due date (negative before it),
 * and fires the single highest un-fired ladder stage whose offset the document
 * has crossed, on that stage's exact configured day. Firing defers one
 * reminder email through the durable scheduler_outbox and writes an
 * append-only dunning_log row; both inserts ride this org's single
 * transaction, so the send is atomic with the sent claim, and the unique
 * (document, stage) index on the log makes the whole thing idempotent —
 * re-running the scheduler never double-sends.
 *
 * Collections never touches the ledger — it is a communications layer, so it
 * lives outside the posting kernel entirely.
 */

export type DunningStage = {
  id: string;
  sequence: number;
  name: string;
  offsetDays: number;
  subjectTemplate: string;
  bodyTemplate: string;
  escalate: boolean;
};

/**
 * Pick the one stage to fire for a document: the highest-sequence stage whose
 * offset the document has crossed and that has not already fired.
 * `daysOverdue` is signed — negative while the document is still before its
 * due date.
 *
 * A stage becomes due on its exact configured day, `dueDate + offsetDays`.
 * Negative offsets are courtesy rungs anchored BEFORE the due date and come
 * due on that day regardless of the policy's grace period. Nonnegative rungs
 * wait for grace — the ladder starts `grace` days after the due date, so rung
 * `k` fires on day max(k, grace). Grace is nonnegative by definition: a
 * negative configured value is a misconfiguration and is clamped to 0, never
 * honored as "start dunning before the due date" — that is what negative
 * offsets are for. Returning a single stage (not every crossed threshold)
 * means a document that has been late for a while gets the most-recent
 * notice, never a burst of back-dated ones. Pure — unit-tested directly.
 */
export function selectDueStage(
  stages: DunningStage[],
  daysOverdue: number,
  firedStageIds: ReadonlySet<string>,
  gracePeriodDays: number,
): DunningStage | null {
  const grace = Math.max(0, gracePeriodDays);
  const candidates = stages
    .filter((s) =>
      s.offsetDays < 0
        ? daysOverdue >= s.offsetDays
        : daysOverdue >= Math.max(s.offsetDays, grace),
    )
    .filter((s) => !firedStageIds.has(s.id))
    .sort((a, b) => b.sequence - a.sequence);
  return candidates[0] ?? null;
}

/** Minimal, dependency-free {{token}} substitution for reminder templates. */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) =>
    key in vars ? String(vars[key]) : "",
  );
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
  const result: DunningRunResult = { scanned: 0, sent: 0, failed: 0, notices: [] };

  const orgs = await withBypass(async () => {
    return (await db.execute<{ orgId: string }>(sql`
      select distinct policy.org_id as "orgId"
        from dunning_policies policy
        join orgs organization on organization.id = policy.org_id
       where policy.is_active and organization.env_kind = 'production'
    `));
  });

  for (const { orgId } of orgs.rows) {
    await withOrg(orgId, async () => {
      // Overdue math compares calendar days, so "today" is the org's business
      // day — the scheduler itself runs on the server's UTC day.
      const today = asOf ?? (await businessToday(orgId));
      const org = (await db.execute<{ name: string; baseCurrency: string }>(
        sql`select name, base_currency as "baseCurrency" from orgs where id = ${orgId}`,
      ));
      const orgName = org.rows[0]?.name ?? "";

      const policies = (await db.execute<{
          id: string;
          appliesToKind: string;
          gracePeriodDays: number;
          minBalance: string;
          replyTo: string | null;
        }>(sql`
        select id, applies_to_kind as "appliesToKind", grace_period_days as "gracePeriodDays",
               min_balance as "minBalance", reply_to as "replyTo"
          from dunning_policies where org_id = ${orgId} and is_active
      `));

      for (const policy of policies.rows) {
        const stageRows = (await db.execute<DunningStage>(sql`
          select id, sequence, name, offset_days as "offsetDays",
                 subject_template as "subjectTemplate", body_template as "bodyTemplate", escalate
            from dunning_stages where policy_id = ${policy.id} and org_id = ${orgId}
           order by sequence
        `));
        const stages = stageRows.rows;
        if (!stages.length) continue;

        // The earliest day any rung can reach, in signed days from the due
        // date: a negative courtesy offset pulls the scan window BEFORE the
        // due date, so documents that are not yet late must be scanned too.
        const minOffset = Math.min(...stages.map((s) => s.offsetDays));
        if (policy.gracePeriodDays < 0) {
          console.warn(
            `[dunning] policy ${policy.id} configures grace_period_days ${policy.gracePeriodDays} — grace is nonnegative and is honored as 0`,
          );
        }

        // Open documents of the policy's kind inside the ladder's reach, with
        // the live balance due reconstructed from un-reversed applications
        // against the open-item leg. A stage comes due once
        // `today >= dueDate + offsetDays`, so the loosest rung bounds the
        // window: `dueDate <= today - minOffset` (an exact, inclusive bound —
        // a rung configured for day k fires on day k, never k±1).
        //
        // `target_transaction_amount`, NOT `amount`: `documents.total` is in the
        // document's TRANSACTION currency while `applications.amount` is the
        // base-currency carrying amount. Subtracting one from the other produced
        // a meaningless number for every FX invoice — suppressing genuinely
        // overdue invoices, chasing fully-paid ones, and mailing the customer a
        // balance that matched neither currency. The transaction leg is the one
        // denominated in the same currency as the total.
        const docs = (await db.execute<{
            id: string;
            documentNumber: string;
            dueDate: string;
            currency: string | null;
            total: string;
            partyId: string | null;
            partyName: string | null;
            partyEmail: string | null;
            balanceDue: string;
            balanceDueBase: string;
          }>(sql`
          select d.id, d.document_number as "documentNumber", d.due_date as "dueDate",
                 d.currency, d.total, p.id as "partyId", p.display_name as "partyName",
                 p.email as "partyEmail",
                 (d.total - coalesce(ap.applied, 0)) as "balanceDue",
                 -- The policy's minimum is a bare numeric with no currency of
                 -- its own, so it can only mean the org's base currency. The
                 -- customer-facing balance stays in the document's currency;
                 -- the THRESHOLD is compared against the base-carrying amount,
                 -- or a €50 policy would silently mean ¥50 on a yen invoice.
                 (round(d.total * d.fx_rate, 4) - coalesce(ap.applied_base, 0)) as "balanceDueBase"
            from documents d
            left join parties p on p.id = d.party_id and p.org_id = d.org_id
            left join lateral (
              select coalesce(sum(a.target_transaction_amount), 0) as applied,
                     coalesce(sum(a.amount), 0) as applied_base
                from journal_lines jl
                join applications a on a.org_id = jl.org_id and a.to_line_id = jl.id and a.unapplied_at is null
               where jl.org_id = d.org_id and jl.entry_id = d.posted_entry_id and jl.is_open_item
            ) ap on true
           where d.org_id = ${orgId} and d.kind = ${policy.appliesToKind}
             and d.status = 'posted' and d.due_date is not null
             and d.due_date <= ${addCalendarDays(today, -minOffset)}
           order by d.id
         `));

        for (const doc of docs.rows) {
          result.scanned += 1;
          if (cmp(doc.balanceDueBase, policy.minBalance) <= 0) continue;
          // Signed days from the due date — negative while the document is
          // still before it, which is exactly how courtesy rungs are reached.
          // The grace gate lives inside selectDueStage, where it delays the
          // post-due rungs without ever holding back a pre-due one.
          const daysOverdue = daysBetween(doc.dueDate, today);

          const fired = (await db.execute<{ stageId: string }>(sql`
            select stage_id as "stageId" from dunning_log
             where document_id = ${doc.id} and org_id = ${orgId} and status = 'sent'
          `));
          const firedIds = new Set(fired.rows.map((r) => r.stageId));

          const stage = selectDueStage(stages, daysOverdue, firedIds, policy.gracePeriodDays);
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

          // Serialize concurrent ticks over THIS ladder rung before doing
          // anything observable. `dunning_log` is append-only (dunning_log_guard)
          // and its status CHECK admits no in-flight state, so the log itself
          // cannot serve as a claim; the advisory lock does, and it costs no
          // schema change. It is held until this org's transaction commits, at
          // which point the loser's re-read below sees the winner's row.
          //
          // These locks accumulate across the org's whole tick, so the document
          // scan above is ORDERED BY d.id: two ticks that took them in whatever
          // order the planner happened to return would acquire the same set in
          // different sequences and deadlock. A total order makes that
          // impossible — one tick simply waits.
          await db.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`dunning:${doc.id}:${stage.id}`}, 0))`,
          );
          const alreadyLogged = (await db.execute(sql`
            select 1 from dunning_log
             where org_id = ${orgId} and document_id = ${doc.id} and stage_id = ${stage.id}
               and status = 'sent'
             limit 1
          `));
          if (alreadyLogged.rows.length > 0) continue;

          let status: "sent" | "failed" | "skipped" = "sent";
          let detail: string | null = null;
          if (!to) {
            status = "skipped";
            detail = "no billing email on the customer record";
          } else {
            try {
              // Defer through the durable outbox instead of handing the letter
              // straight to Redis. The deferral insert rides THIS org's pinned
              // transaction, so it commits — or rolls back — together with the
              // dunning_log row below. A direct BullMQ enqueue commits outside
              // Postgres: a crash or a later statement error in this tick left
              // mail queued against a claim that no longer existed, and the
              // next tick fired the same rung again — the customer got the
              // letter twice. subject_id carries the document id for operator
              // traceability; the deterministic occurrence key is this rung's
              // identity, so a replayed tick collapses onto one row.
              const deferred = await enqueueFlowEmail({
                orgId,
                runId: doc.id,
                occurrenceKey: `dunning:${doc.id}:${stage.id}`,
                payload: {
                  to: [to],
                  subject,
                  html: `<p>${body.replace(/\n/g, "<br/>")}</p>`,
                  text: body,
                  meta: { category: "dunning" },
                },
              });
              if (!deferred) {
                // Unreachable through this path — a committed attempt always
                // pairs the outbox row with its log row, which the re-check
                // above would have caught — but if storage ever says otherwise
                // the safe move is to let the existing deferral own delivery
                // rather than double-claiming the rung.
                continue;
              }
            } catch (e) {
              status = "failed";
              detail = e instanceof Error ? e.message : String(e);
            }
          }

          // Record the notice ONLY when its delivery is durably staged. The log
          // is the record of what the customer was sent, and it doubles as the
          // "this rung has fired" marker via its unique (document, stage) index.
          //
          // Writing a 'failed' or 'skipped' row into that same slot would retire
          // the rung permanently: one transient queue error, or one customer who
          // happened to have no billing email on file the first time the stage
          // came due, and that step of the collections ladder never ran again —
          // silently, for the life of the invoice. Leaving the slot empty lets a
          // later tick retry once the cause is fixed.
          if (status === "sent") {
            await db.execute(sql`
              insert into dunning_log (org_id, document_id, policy_id, stage_id, party_id, to_email,
                                       amount_due, currency_code, channel, status, detail)
              values (${orgId}, ${doc.id}, ${policy.id}, ${stage.id}, ${doc.partyId}, ${to},
                      ${doc.balanceDue}, ${doc.currency}, 'email', 'sent', null)
              on conflict (document_id, stage_id) do nothing
            `);
          } else {
            console.warn(
              `[dunning] ${doc.documentNumber} stage ${stage.id} not sent (${status}): ${detail ?? "unknown"} — will retry on a later tick`,
            );
          }

          if (status === "sent") result.sent += 1;
          else if (status === "failed") result.failed += 1;
          result.notices.push({ documentId: doc.id, stageId: stage.id, toEmail: to, status });
        }
      }
    });
  }
  return result;
}
