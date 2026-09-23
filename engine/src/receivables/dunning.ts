import { sql } from "drizzle-orm";
import { db, withBypass, withOrg } from "../platform/db.ts";
import { addCalendarDays, businessToday, calendarDaysBetween } from "../platform/business-date.ts";
import { documentBalanceDueLateral } from "../records/balance-due.ts";
import { cmp } from "../money/money.ts";
import { enqueueFlowEmail, SCHEDULER_OUTBOX_RETRY_HORIZON_MS } from "../scheduling/outbox.ts";

/**
 * Dunning — automated collections over the AR subledger. For each active policy
 * the runner finds open documents inside the ladder's reach — overdue ones and,
 * for negative-offset courtesy stages, documents approaching their due date —
 * computes each one's signed distance from its due date (negative before it),
 * and fires the single highest un-fired ladder stage whose offset the document
 * has crossed, on that stage's exact configured day. Firing opens a 'staged'
 * claim row in dunning_log and defers one reminder email through the durable
 * scheduler_outbox; both ride this org's single transaction, so the deferral
 * is atomic with the claim, and the unique (document, stage) index arbitrates
 * concurrent ticks onto the one row — re-running the scheduler never
 * double-sends. Queueing is not delivery: the claim stays 'staged' after a
 * successful deferral, and the email worker moves it to its outcome from the
 * provider's verdict (acceptance → sent, rejection → failed, uncertainty →
 * stays staged). A deferral that throws settles the claim to 'failed'
 * in-tick; an unsendable notice (no billing email) settles to 'suppressed'.
 * A later tick re-arms failed and suppressed claims back to staged for retry
 * once the cause is fixed, each round deferring under a FRESH occurrence key
 * so the retry never collapses onto a dead outbox row; a staged claim older
 * than the outbox retry horizon is abandoned and re-armed by name. Before
 * ANY re-arm, the tick reconciles the claim against the durable email
 * evidence for that claim — every delivery identity it ever used, since a
 * re-armed claim has earlier deliveries under older keys: an accepted
 * delivery settles the claim sent instead of re-firing it, an unresolved
 * acceptance keeps it staged under a named reconciliation hold, and only a
 * claim whose deliveries all definitively failed (or that was never
 * attempted at all) re-arms. 'sent' rows are terminal delivery evidence;
 * the storage guard (dunning_log_guard) refuses every other transition, so
 * the log reconciles exactly with what the customer was sent — never with
 * what was merely queued.
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

/**
 * Signed whole days from one ISO date to another. The single civil-date
 * definition lives in platform/business-date.ts: Date.UTC remaps years 0-99
 * onto 1900-1999, which made a cross-century overdue span hugely negative and
 * selected the wrong collection rung.
 */
export function daysBetween(fromIso: string, toIsoDate: string): number {
  return calendarDaysBetween(fromIso, toIsoDate);
}

export interface DunningRunResult {
  scanned: number;
  /**
   * Letters this tick accepted into the durable scheduler_outbox. Each one's
   * claim stays 'staged' until the email worker records the provider's
   * verdict — this counts queued letters, not delivered ones. Only the
   * dunning_log claim, settled asynchronously, says what the customer got.
   */
  sent: number;
  failed: number;
  notices: { documentId: string; stageId: string; toEmail: string | null; status: string }[];
}

/**
 * A staged claim is abandoned when no delivery outcome can still be in
 * flight: its age exceeds the outbox's worst-case drain horizon, so its
 * letter's outbox row is terminal or long dead and the worker will never
 * settle it. An unreadable timestamp fails closed (not abandoned) with a
 * warning rather than re-sending on no evidence.
 */
function isAbandonedStagedClaim(updatedAt: Date | string | null): boolean {
  if (!updatedAt) return false;
  const claimedAt = new Date(updatedAt).getTime();
  if (Number.isNaN(claimedAt)) {
    console.warn(`[dunning] staged claim carries an unreadable updated_at — leaving it staged`);
    return false;
  }
  return Date.now() - claimedAt > SCHEDULER_OUTBOX_RETRY_HORIZON_MS;
}

/**
 * The durable email evidence for one dunning claim: every email_log row
 * carrying this claim's id in its meta, across EVERY occurrence key the
 * claim has ever deferred under (the rung's base key and each re-arm's
 * rotated key). Reading by claim id — never by delivery key — is what lets
 * an acceptance under an older key settle the claim instead of re-firing it.
 *
 * - "accepted": some delivery was accepted by the provider (a sent row, or a
 *   sent record in its attempt lineage). The customer got the letter.
 * - "uncertain": no acceptance anywhere, but some delivery's acceptance
 *   state is unresolved (an uncertain row or lineage record — including a
 *   dangling "started" event whose worker never reported back and may have
 *   transmitted before it died). The letter may have gone out.
 * - "rejected-or-absent": every recorded delivery definitively failed, or no
 *   delivery evidence exists at all (the outbox row died before the worker
 *   ran, or the letter was suppressed before any attempt).
 */
type DunningDeliveryVerdict = "accepted" | "uncertain" | "rejected-or-absent";

async function readDunningDeliveryVerdict(
  orgId: string,
  claimId: string,
): Promise<DunningDeliveryVerdict> {
  const rows = (await db.execute<{ status: string; attempts: unknown }>(sql`
    select status, meta -> 'attempts' as attempts
      from email_log
     where org_id = ${orgId} and meta ->> 'dunningLogId' = ${claimId}
  `)).rows;
  let sawUncertain = false;
  for (const row of rows) {
    if (row.status === "sent") return "accepted";
    // Decided outcomes by attempt number; annotation events ("blocked",
    // "suppressed", "started") carry no verdict and are dropped — except a
    // dangling "started", handled below.
    const decided = new Map<number, string>();
    const attempts = Array.isArray(row.attempts) ? row.attempts : [];
    for (const entry of attempts) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as { outcome?: unknown; attempt?: unknown };
      if (
        (record.outcome === "sent" || record.outcome === "notSent" || record.outcome === "uncertain") &&
        typeof record.attempt === "number"
      ) {
        decided.set(record.attempt, record.outcome);
      }
    }
    if ([...decided.values()].includes("sent")) return "accepted";
    let uncertain = [...decided.values()].includes("uncertain") || row.status === "uncertain";
    if (!uncertain) {
      // A "started" event with no outcome for the same attempt number means
      // the worker was lost mid-flight — the transmission may already have
      // been accepted. That synthesizes to uncertain, never to a clean
      // slate, or the re-arm would re-send a possibly-delivered letter.
      for (const entry of attempts) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as { outcome?: unknown; attempt?: unknown };
        if (record.outcome === "started" && typeof record.attempt === "number" && !decided.has(record.attempt)) {
          uncertain = true;
          break;
        }
      }
    }
    if (uncertain) sawUncertain = true;
  }
  return sawUncertain ? "uncertain" : "rejected-or-absent";
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
          // Fresh claims defer under the rung's base identity; every re-arm
          // rotates the key with its own re-arm time, so a retry never
          // collapses onto a dead outbox row from an earlier round and
          // reports delivery without sending anything.
          let occurrenceKey = `dunning:${doc.id}:${stage.id}`;
          if (!claimId) {
            const existing = (await db.execute<{ id: string; status: string; updatedAt: Date | string }>(sql`
              select id, status, updated_at as "updatedAt" from dunning_log
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
            if (existing.status === "staged" && !isAbandonedStagedClaim(existing.updatedAt)) {
              // A rival tick owns this rung right now: its deferred letter is
              // still awaiting the email worker's verdict. Leave it alone;
              // this tick contributes nothing.
              console.warn(
                `[dunning] ${doc.documentNumber} stage ${stage.id} is claimed by an in-flight tick — skipping`,
              );
              continue;
            }
            // Delivery-evidence gate: a re-arm defers under a FRESH delivery
            // identity, so re-arming a claim whose letter was (or may have
            // been) accepted sends the customer a duplicate collections
            // letter. The horizon above only proves no outcome is still IN
            // FLIGHT; what already happened is read here, by claim id
            // across every occurrence key the claim ever used. Only a claim
            // whose deliveries all definitively failed, or that was never
            // attempted at all, falls through to the re-arm below.
            const verdict = await readDunningDeliveryVerdict(orgId, existing.id);
            if (verdict === "accepted") {
              // The customer got the letter under some earlier delivery
              // identity: settle the claim instead of re-firing it. From
              // staged that is the legal staged→sent transition; a claim
              // the worker already moved out of staged carries the same
              // verdict either way, so a lost race is logged, never
              // re-fired and never crashed into the rest of the tick.
              if (existing.status === "staged") {
                const settled = await db.execute<{ id: string }>(sql`
                  update dunning_log set status = 'sent', sent_at = now(), updated_at = now()
                   where id = ${existing.id} and org_id = ${orgId} and status = 'staged'
                  returning id
                `);
                if (!settled.rows[0]) {
                  const current = (await db.execute<{ status: string }>(sql`
                    select status from dunning_log where id = ${existing.id} and org_id = ${orgId}
                  `)).rows[0]?.status;
                  console.error(
                    `[dunning] ${doc.documentNumber} stage ${stage.id} has accepted delivery evidence but the claim is now ${current ?? "missing"} — not re-firing`,
                  );
                }
                continue;
              }
              console.error(
                `[dunning] ${doc.documentNumber} stage ${stage.id} is ${existing.status} but has accepted delivery evidence — not re-arming a delivered letter`,
              );
              continue;
            }
            if (verdict === "uncertain") {
              // Acceptance unresolved: the first letter may already have
              // been accepted, so re-arming risks a duplicate collections
              // letter — worse than a delayed one. Keep the claim staged
              // and record by name that it needs reconciliation. Staged
              // rows are never updated in place (the guard refuses
              // staged→staged), so the note hops through failed and back;
              // the refreshed timestamp also keeps the next tick from
              // re-examining it until another horizon passes. A claim the
              // worker already moved out of staged is left exactly as the
              // worker left it — still never re-armed.
              if (existing.status === "staged") {
                const blockedNote =
                  `dunning letter acceptance unresolved in email delivery evidence for this claim — ` +
                  `needs reconciliation; re-arm refused so the customer is never sent a duplicate letter`;
                const parked = await db.execute<{ id: string }>(sql`
                  update dunning_log set status = 'failed', detail = ${blockedNote}, updated_at = now()
                   where id = ${existing.id} and org_id = ${orgId} and status = 'staged'
                  returning id
                `);
                if (!parked.rows[0]) {
                  console.error(
                    `[dunning] ${doc.documentNumber} stage ${stage.id} has uncertain delivery evidence but the claim left staged under this tick — not re-firing`,
                  );
                  continue;
                }
                const restaged = await db.execute<{ id: string }>(sql`
                  update dunning_log
                     set status = 'staged', detail = ${blockedNote}, updated_at = now()
                   where id = ${existing.id} and org_id = ${orgId} and status = 'failed'
                  returning id
                `);
                if (!restaged.rows[0]) {
                  throw new Error(
                    `[dunning] ${doc.documentNumber} stage ${stage.id} reconciliation hold matched zero rows — refusing to send unclaimed`,
                  );
                }
                continue;
              }
              console.error(
                `[dunning] ${doc.documentNumber} stage ${stage.id} is ${existing.status} but has unresolved delivery evidence — not re-arming until it is reconciled`,
              );
              continue;
            }
            // Re-arm this attempt: a failed or suppressed claim from an
            // earlier tick, or a staged claim abandoned past the outbox retry
            // horizon (its letter's outbox row is terminal or long dead, so
            // no outcome is still in flight — and the gate above proved none
            // already happened). Either way the evidence is
            // refreshed to the retry's inputs (the customer may have gained
            // a billing email since); the abandonment names itself on the
            // re-armed row as the audit trail. The guard admits exactly
            // these transitions and refuses every other one.
            const rearmNote =
              existing.status === "staged"
                ? `staged claim abandoned: no email-worker delivery outcome within the outbox retry horizon; re-armed for retry`
                : null;
            if (existing.status === "staged") {
              // Hop through failed so the guard sees only legal transitions —
              // staged rows are never updated in place.
              const abandoned = await db.execute<{ id: string }>(sql`
                update dunning_log set status = 'failed', detail = ${rearmNote}, updated_at = now()
                 where id = ${existing.id} and org_id = ${orgId} and status = 'staged'
                 returning id
              `);
              if (!abandoned.rows[0]) {
                throw new Error(
                  `[dunning] ${doc.documentNumber} stage ${stage.id} abandonment matched zero rows — refusing to send unclaimed`,
                );
              }
            }
            const rearmed = await db.execute<{ id: string; updatedAt: Date | string }>(sql`
              update dunning_log
                 set status = 'staged', detail = ${rearmNote}, party_id = ${doc.partyId}, to_email = ${to},
                     amount_due = ${doc.balanceDue}, currency_code = ${doc.currency}, updated_at = now()
               where id = ${existing.id} and org_id = ${orgId} and status in ('failed', 'suppressed')
               returning id, updated_at as "updatedAt"
            `);
            claimId = rearmed.rows[0]?.id;
            if (!claimId) {
              throw new Error(
                `[dunning] ${doc.documentNumber} stage ${stage.id} re-arm matched zero rows — refusing to send unclaimed`,
              );
            }
            occurrenceKey = `dunning:${doc.id}:${stage.id}:${new Date(rearmed.rows[0]!.updatedAt).getTime()}`;
          }

          // In-tick outcomes for claims that never reach the worker: only a
          // deferral that throws ('failed') and an unsendable notice
          // ('suppressed'). A successfully deferred letter stays 'staged' —
          // the email worker alone moves it to its outcome from the
          // provider's verdict. The update names its row back — a write
          // matching zero rows is a failure, never a reported outcome.
          const settleClaim = async (
            status: "failed" | "suppressed",
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
            // staged claim above. A direct BullMQ enqueue commits outside
            // Postgres: a crash or a later statement error in this tick left
            // mail queued against a claim that no longer existed, and the
            // next tick fired the same rung again — the customer got the
            // letter twice. subject_id carries the document id for operator
            // traceability; the occurrence key is this round's identity, so a
            // replayed tick collapses onto one row, and meta carries the
            // claim id the email worker settles from the provider verdict.
            const deferred = await enqueueFlowEmail({
              orgId,
              runId: doc.id,
              occurrenceKey,
              payload: {
                to: [to],
                subject,
                html: `<p>${escapeHtml(body).replace(/\n/g, "<br/>")}</p>`,
                text: body,
                meta: { category: "dunning", dunningLogId: claimId },
                // The policy's configured reply-to; absent means the org's
                // default transport reply-to. An empty string is not an
                // address — it must not reach the payload.
                ...(policy.replyTo ? { replyTo: policy.replyTo } : {}),
              },
            });
            if (!deferred) {
              // A rival deferral owns this round's delivery under our key:
              // the letter is already durable, so the claim stays staged for
              // the worker's verdict and this tick counts nothing twice.
              console.warn(
                `[dunning] ${doc.documentNumber} stage ${stage.id} deferral already owned — leaving staged`,
              );
              continue;
            }
          } catch (e) {
            // A transient queue or validation failure is evidence, not an
            // empty slot: the failed claim stays queryable, stays out of the
            // fired set (only 'sent' fires), and re-arms on a later tick
            // under a fresh occurrence key.
            await settleClaim("failed", e instanceof Error ? e.message : String(e));
            result.failed += 1;
            result.notices.push({ documentId: doc.id, stageId: stage.id, toEmail: to, status: "failed" });
            continue;
          }

          // Deferred, not delivered: the claim stays staged for the email
          // worker's verdict, and this tick counts the queued letter.
          result.sent += 1;
          result.notices.push({ documentId: doc.id, stageId: stage.id, toEmail: to, status: "staged" });
        }
      }
    });
  }
  return result;
}
