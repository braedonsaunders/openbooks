import { sql } from "drizzle-orm";
import { db, withBypass, withOrg } from "../platform/db.ts";
import { addCalendarDays, businessToday } from "../platform/business-date.ts";
import { documentBalanceDueLateral } from "../records/balance-due.ts";
import { cmp } from "../money/money.ts";
import { enqueueFlowEmail } from "../scheduling/outbox.ts";

/**
 * Dunning — automated collections over the AR subledger. For each active policy
 * the runner finds open documents inside the ladder's reach — overdue ones and,
 * for negative-offset courtesy stages, documents approaching their due date —
 * computes each one's signed distance from its due date (negative before it),
 * and fires the single highest un-fired ladder stage whose offset the document
 * has crossed, on that stage's exact configured day. Firing opens a 'staged'
 * claim row in dunning_log and defers one reminder email through the durable
 * scheduler_outbox; both ride this org's single transaction, so the send is
 * atomic with the claim, and the unique (document, stage) index arbitrates
 * concurrent ticks onto the one row — re-running the scheduler never
 * double-sends. The send attempt then moves the claim to its outcome (sent,
 * failed, or suppressed when the customer has no billing email), and a later
 * tick re-arms failed and suppressed claims back to staged for retry once
 * the cause is fixed. 'sent' rows are terminal delivery evidence; the
 * storage guard (dunning_log_guard) refuses every other transition, so the
 * log reconciles exactly with what the customer was sent.
 *
 * Collections never touches the ledger — it is a communications layer, so it
 * lives outside the posting kernel entirely.
 */

/**
 * Document kinds a dunning policy may target. Dunning chases an open
 * receivable past its due date and mails the document's party, so only the
 * customer-facing open-item kind qualifies. `dunning_policies.applies_to_kind`
 * is bare text: the API refuses anything else on write, and the runner
 * re-checks here and skips (fails closed on) any policy that slipped through —
 * a policy aimed at a payable kind would otherwise mail the org's own vendors.
 */
export const DUNNABLE_DOCUMENT_KINDS: ReadonlySet<string> = new Set(["customer_invoice"]);

export function isDunnableDocumentKind(kind: string): boolean {
  return DUNNABLE_DOCUMENT_KINDS.has(kind);
}

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
 * Pick the one stage to fire for a document: the highest-sequence crossed
 * stage that has not already fired and is not superseded by a higher rung
 * that has. `daysOverdue` is signed — negative while the document is still
 * before its due date.
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
 * notice, never a burst of back-dated ones.
 *
 * Once a higher rung has fired, every lower rung is superseded and never
 * sent — otherwise an invoice discovered 40 days late would send stage 3,
 * then stage 2, then stage 1 on successive ticks: contradictory back-dated
 * collection notices after an escalation. `firedStageIds` carries only
 * SUCCESSFUL sends (dunning_log status 'sent'): a crossed stage whose send
 * failed leaves no sent row, so it stays eligible and retries — failed and
 * suppressed delivery rows must never enter this set. Pure — unit-tested
 * directly.
 */
export function selectDueStage(
  stages: DunningStage[],
  daysOverdue: number,
  firedStageIds: ReadonlySet<string>,
  gracePeriodDays: number,
): DunningStage | null {
  const grace = Math.max(0, gracePeriodDays);
  const firedSequences = stages
    .filter((s) => firedStageIds.has(s.id))
    .map((s) => s.sequence);
  const supersededBelow = firedSequences.length > 0 ? Math.max(...firedSequences) : -Infinity;
  const candidates = stages
    .filter((s) => s.sequence > supersededBelow)
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

/**
 * Escape rendered template output for the HTML part. Vars are free-text rows
 * (party names, document numbers) an insider — or a tainted import —
 * controls; embedding them raw ships arbitrary markup to the customer's
 * inbox from the org's own authenticated mail domain. The text part carries
 * the same body unescaped.
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
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

/**
 * Run dunning for every production organization. This is the scheduler entry
 * point and intentionally performs an org-spanning discovery under bypass.
 * Callers that already know their tenant (for example the SaaS simulator)
 * must use `runDunningForOrg` so a shared database can never turn one tenant's
 * simulation tick into a production-wide collections run.
 */
export async function runDunning(asOf?: string): Promise<DunningRunResult> {
  const orgRows = (
    await withBypass(async () => {
      return (await db.execute<{ orgId: string }>(sql`
        select distinct policy.org_id as "orgId"
          from dunning_policies policy
          join orgs organization on organization.id = policy.org_id
         where policy.is_active and organization.env_kind = 'production'
      `));
    })
  ).rows;
  return runDunningInternal(asOf, orgRows);
}

/**
 * Run dunning for exactly one organization. The work is still pinned inside
 * `withOrg`, so all reads, outbox deferrals, and sent claims share one tenant
 * transaction. No cross-organization discovery or bypass is performed.
 */
export async function runDunningForOrg(orgId: string, asOf?: string): Promise<DunningRunResult> {
  if (!orgId.trim()) throw new Error("orgId is required for an org-scoped dunning run");
  return runDunningInternal(asOf, [{ orgId }]);
}

async function runDunningInternal(
  asOf: string | undefined,
  orgRows: ReadonlyArray<{ orgId: string }>,
): Promise<DunningRunResult> {
  const result: DunningRunResult = { scanned: 0, sent: 0, failed: 0, notices: [] };

  for (const { orgId } of orgRows) {
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
        if (!isDunnableDocumentKind(policy.appliesToKind)) {
          console.warn(
            `[dunning] policy ${policy.id} applies to ${JSON.stringify(policy.appliesToKind)}, which is not a dunnable receivable kind — skipped`,
          );
          continue;
        }
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
        // the live balance due from the shared reader
        // (../records/balance-due.ts) — the same applied sum the drawer and the
        // customer PDF use, so dunning can never act on a different figure.
        // A stage comes due once `today >= dueDate + offsetDays`, so the
        // loosest rung bounds the window: `dueDate <= today - minOffset` (an
        // exact, inclusive bound — a rung configured for day k fires on day
        // k, never k±1).
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
            ${documentBalanceDueLateral("d", { base: true })}
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

          // Serialize concurrent ticks over THIS ladder rung before claiming
          // it. The claim lives IN the log now: the runner opens one 'staged'
          // row per (document, stage) and the unique index arbitrates rivals
          // onto it, so the log reconciles exactly with what ran — including
          // attempts, not just successes. The advisory lock stays as the
          // second arbiter: it serializes the claim-then-defer sequence so a
          // loser reads the winner's settled row instead of racing its
          // in-flight one. It is held until this org's transaction commits.
          //
          // These locks accumulate across the org's whole tick, so the document
          // scan above is ORDERED BY d.id: two ticks that took them in whatever
          // order the planner happened to return would acquire the same set in
          // different sequences and deadlock. A total order makes that
          // impossible — one tick simply waits.
          await db.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`dunning:${doc.id}:${stage.id}`}, 0))`,
          );

          // Claim the rung. A conflict means a rival tick already owns this
          // slot — the insert is skipped (not an error) and the winner's row
          // below decides what this tick does: this is the expected
          // concurrent-tick shape, which is why `do nothing` is correct here
          // rather than a failure.
          const claimed = await db.execute<{ id: string }>(sql`
            insert into dunning_log (org_id, document_id, policy_id, stage_id, party_id, to_email,
                                     amount_due, currency_code, channel, status, detail)
            values (${orgId}, ${doc.id}, ${policy.id}, ${stage.id}, ${doc.partyId}, ${to},
                    ${doc.balanceDue}, ${doc.currency}, 'email', 'staged', null)
            on conflict (document_id, stage_id) do nothing
            returning id
          `);
          let claimId = claimed.rows[0]?.id;
          if (!claimId) {
            const existing = (await db.execute<{ id: string; status: string }>(sql`
              select id, status from dunning_log
               where org_id = ${orgId} and document_id = ${doc.id} and stage_id = ${stage.id}
            `)).rows[0];
            if (!existing) {
              // Unreachable under the advisory lock held above: a conflict
              // proves a rival row exists, and no rival can delete one (the
              // guard refuses DELETE). Fail closed rather than send unclaimed.
              throw new Error(
                `[dunning] ${doc.documentNumber} stage ${stage.id} claim vanished under its lock — refusing to send unclaimed`,
              );
            }
            if (existing.status === "sent" || existing.status === "skipped") {
              // Terminal delivery evidence (or settled history): never re-fire.
              continue;
            }
            if (existing.status === "staged") {
              // A rival tick owns this rung right now: its transaction will
              // settle the claim (commit or roll back together with its
              // deferral). Leave it alone; this tick contributes nothing.
              console.warn(
                `[dunning] ${doc.documentNumber} stage ${stage.id} is claimed by an in-flight tick — skipping`,
              );
              continue;
            }
            // A failed or suppressed claim from an earlier tick: re-arm it for
            // this attempt, refreshing the evidence to the retry's inputs
            // (the customer may have gained a billing email since). The guard
            // admits exactly this transition and refuses every other one.
            const rearmed = await db.execute<{ id: string }>(sql`
              update dunning_log
                 set status = 'staged', detail = null, party_id = ${doc.partyId}, to_email = ${to},
                     amount_due = ${doc.balanceDue}, currency_code = ${doc.currency}
               where id = ${existing.id} and org_id = ${orgId}
               returning id
            `);
            claimId = rearmed.rows[0]?.id;
            if (!claimId) {
              throw new Error(
                `[dunning] ${doc.documentNumber} stage ${stage.id} re-arm matched zero rows — refusing to send unclaimed`,
              );
            }
          }

          // Move the claim to its outcome. Every path below settles the row
          // it opened: a committed 'staged' row is never left behind, so a
          // later tick always finds either terminal evidence or a claim worth
          // re-arming. The update names its row back — a write matching zero
          // rows is a failure, never a reported send.
          const settleClaim = async (
            status: "sent" | "failed" | "suppressed",
            detail: string | null,
          ): Promise<void> => {
            const moved = await db.execute<{ id: string }>(sql`
              update dunning_log set status = ${status}, detail = ${detail}
               where id = ${claimId} and org_id = ${orgId}
               returning id
            `);
            if (!moved.rows[0]) {
              throw new Error(
                `[dunning] ${doc.documentNumber} stage ${stage.id} outcome ${status} matched zero rows — refusing to report an unrecorded outcome`,
              );
            }
          };

          if (!to) {
            // Unsendable, but no longer invisible: the suppressed claim is the
            // durable evidence of the attempt, and the re-arm above retries it
            // once the customer gains a billing email.
            await settleClaim("suppressed", "no billing email on the customer record");
            result.notices.push({ documentId: doc.id, stageId: stage.id, toEmail: to, status: "suppressed" });
            continue;
          }
          try {
            // Defer through the durable outbox instead of handing the letter
            // straight to Redis. The deferral insert rides THIS org's pinned
            // transaction, so it commits — or rolls back — together with the
            // claim's outcome above. A direct BullMQ enqueue commits outside
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
                html: `<p>${escapeHtml(body).replace(/\n/g, "<br/>")}</p>`,
                text: body,
                meta: { category: "dunning" },
                // The policy's configured reply-to; absent means the org's
                // default transport reply-to. An empty string is not an
                // address — it must not reach the payload.
                ...(policy.replyTo ? { replyTo: policy.replyTo } : {}),
              },
            });
            if (!deferred) {
              // A prior deferral owns this rung's delivery (the deterministic
              // occurrence key collided): the pair is complete without us, so
              // the claim settles sent and this tick counts nothing twice.
              await settleClaim("sent", null);
              continue;
            }
          } catch (e) {
            // A transient queue or validation failure is evidence, not an
            // empty slot: the failed claim stays queryable, stays out of the
            // fired set (only 'sent' fires), and re-arms on a later tick.
            await settleClaim("failed", e instanceof Error ? e.message : String(e));
            result.failed += 1;
            result.notices.push({ documentId: doc.id, stageId: stage.id, toEmail: to, status: "failed" });
            continue;
          }

          await settleClaim("sent", null);
          result.sent += 1;
          result.notices.push({ documentId: doc.id, stageId: stage.id, toEmail: to, status: "sent" });
        }
      }
    });
  }
  return result;
}
