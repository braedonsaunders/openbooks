import { sql } from "drizzle-orm";
import { db, withBypass, withOrg } from "./db.ts";
import { businessToday } from "./business-date.ts";
import { now } from "./clock.ts";
import { loadRequiredControlAccounts } from "./control-accounts.ts";
import { inventoryFeatureEnabled } from "./inventory.ts";
import { add, sum } from "./money.ts";
import { postDocument, type PostingDeps } from "./posting.ts";
import { submitAndReleaseIfUngated } from "./flows/submit.ts";
import { computeNextRunAt } from "./scripting.ts";

/**
 * Recurring document generator — the runner the `recurring_schedules` table was
 * always missing. Each active schedule points at a template document; when its
 * next_run_on comes due the runner CLONES that template into a fresh draft
 * (header + lines, dated today), optionally posts it through the kernel, and
 * advances next_run_on to the next occurrence. Cloning a document (not a
 * bespoke invoice table) means every recurring invoice, bill, or standing
 * journal flows through the exact same posting rule as its hand-entered twin.
 *
 * Claiming is done by the same advance-and-guard trick the script scheduler
 * uses: the UPDATE … WHERE next_run_on = $old means only one tick can win an
 * occurrence, so horizontal scaling can never double-bill. A failed attempt
 * rolls its claim back — guarded on the claimed value — so the occurrence is
 * retried on the next tick, never silently lost.
 *
 * Retrying safely requires the generation itself to be idempotent per
 * occurrence: each generated document is committed together with a
 * `recurring_occurrence_documents` guard row (unique per org/schedule/occurrence
 * date). A retried tick whose claim was rolled back — or a "run now" racing a
 * tick — finds the committed guard row and replays that exact document instead
 * of posting a second one. Success bookkeeping (run_count/last_document_id)
 * runs outside the claim-rollback scope: once a document exists for the
 * occurrence, a transient bookkeeping failure surfaces through last_error and
 * never restores next_run_on.
 */

export type Cadence =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "annually"
  | "custom_cron";

export class RecurringError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "RecurringError";
  }
}

const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

/**
 * Optional-module kinds the runner must not mint when the Features switch is
 * off. Mirrors web/lib/document-kinds.ts DOC_KIND_FEATURE + registry defaults.
 * Core invoices/bills/journals are not listed — recurring works without a gate.
 */
const OPTIONAL_KIND_FEATURE: Record<string, { key: string; defaultEnabled: boolean }> = {
  quote: { key: "orders", defaultEnabled: true },
  sales_order: { key: "orders", defaultEnabled: true },
  purchase_order: { key: "orders", defaultEnabled: true },
  expense_report: { key: "expenses", defaultEnabled: true },
  pay_run: { key: "payroll", defaultEnabled: false },
  project_charge: { key: "projects", defaultEnabled: true },
};

export async function isRecurringKindEnabled(orgId: string, kind: string): Promise<boolean> {
  const feature = OPTIONAL_KIND_FEATURE[kind];
  if (!feature) return true;
  const r = (await db.execute<{ enabled: boolean | null }>(sql`
    select (settings->'features'->>${feature.key})::boolean as enabled from orgs where id = ${orgId}
  `));
  const stored = r.rows[0]?.enabled;
  return typeof stored === "boolean" ? stored : feature.defaultEnabled;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toIso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Advance an ISO date by one cadence step. Month/quarter/year steps clamp to the
 * end of a shorter target month (Jan 31 + 1 month → Feb 28/29), the convention
 * every billing system uses so month-end anchors don't drift onto the 1st.
 * Pure and deterministic (custom_cron aside) so it is unit-tested directly.
 */
export function advanceCadence(
  isoDate: string,
  cadence: Cadence,
  cron?: string | null,
  now?: Date,
): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (cadence === "weekly" || cadence === "biweekly") {
    const base = new Date(Date.UTC(y!, m! - 1, d!));
    base.setUTCDate(base.getUTCDate() + (cadence === "weekly" ? 7 : 14));
    return toIso(base);
  }
  if (cadence === "custom_cron") {
    // Cron recurrence is clock-based; advance from the day AFTER the occurrence
    // (so a daily cron doesn't return the same day) using the shared
    // evaluator. A malformed cron falls back to a monthly step so a bad row can
    // never wedge the runner in a zero-length loop.
    const from = new Date(Date.UTC(y!, m! - 1, d! + 1));
    const next = computeNextRunAt(cron ?? "", now ?? from);
    if (!next) return advanceCadence(isoDate, "monthly");
    return toIso(next);
  }
  const monthStep = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
  const targetMonthIndex = m! - 1 + monthStep;
  const targetYear = y! + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  // Clamp the day to the last day of the target month.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d!, lastDay);
  return `${targetYear}-${pad(targetMonth + 1)}-${pad(day)}`;
}

export interface ScheduleClaimRollback {
  /** Apply the restore only while the row still holds this (claimed) value. */
  expectedNextRunOn: string;
  nextRunOn: string;
  /** The due scan only claims active schedules, so a rollback reactivates. */
  isActive: boolean;
  lastRunAt: Date | null;
}

/**
 * Rollback payload for a generation attempt that failed AFTER its occurrence
 * was claimed: the pre-claim schedule fields, so the next tick retries instead
 * of the occurrence being silently lost. The caller must apply it with
 * `where next_run_on = expectedNextRunOn` — if a concurrent writer has already
 * moved the schedule on, the guarded update matches nothing and that writer
 * wins. When the live value is known, pass it to skip building a rollback that
 * could no longer apply. Pure — unit-tested.
 */
export function scheduleClaimRollback(
  prior: { nextRunOn: string; lastRunAt: Date | null },
  claimedNextRunOn: string,
): ScheduleClaimRollback;
export function scheduleClaimRollback(
  prior: { nextRunOn: string; lastRunAt: Date | null },
  claimedNextRunOn: string,
  currentNextRunOn: string,
): ScheduleClaimRollback | null;
export function scheduleClaimRollback(
  prior: { nextRunOn: string; lastRunAt: Date | null },
  claimedNextRunOn: string,
  currentNextRunOn?: string,
): ScheduleClaimRollback | null {
  if (currentNextRunOn !== undefined && currentNextRunOn !== claimedNextRunOn) return null;
  return {
    expectedNextRunOn: claimedNextRunOn,
    nextRunOn: prior.nextRunOn,
    isActive: true,
    lastRunAt: prior.lastRunAt,
  };
}

/** Whole-day difference b − a (both ISO), used to carry the payment term. */
function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const t0 = Date.UTC(ay!, am! - 1, ad!);
  const t1 = Date.UTC(by!, bm! - 1, bd!);
  return Math.round((t1 - t0) / 86_400_000);
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  base.setUTCDate(base.getUTCDate() + days);
  return toIso(base);
}

async function nextNumber(orgId: string, kind: string, subsidiaryId: string | null): Promise<string> {
  const prefix = defaultPrefix(kind);
  const configured = subsidiaryId
    ? ((await db.execute(sql`
        select 1 from number_sequences where org_id = ${orgId} and document_kind = ${kind}
          and subsidiary_id = ${subsidiaryId} limit 1
      `))).rows.length > 0
    : false;
  const seqSub = configured ? subsidiaryId : null;
  const r = (await db.execute<{ prefix: string; next_number: number; padding: number }>(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, ${kind}, ${seqSub}, ${prefix})
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    where number_sequences.org_id = ${orgId}
    returning prefix, next_number, padding
  `));
  const s = r.rows[0]!;
  return `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;
}

function defaultPrefix(kind: string): string {
  switch (kind) {
    case "customer_invoice":
      return "INV-";
    case "vendor_bill":
      return "BILL-";
    case "journal":
      return "JE-";
    case "sales_order":
      return "SO-";
    default:
      return `${kind.slice(0, 3).toUpperCase()}-`;
  }
}

/**
 * Posting deps with ar/ap/bank fail-closed: an org missing control accounts
 * refuses to post (ControlAccountsIncompleteError) instead of letting undefined
 * account ids reach the kernel. The error surfaces through the runner's
 * existing failure path — claim rollback + last_error for scheduler runs, and a
 * 422-class refusal for "run now" — so the occurrence retries once configured.
 */
async function controlDeps(orgId: string): Promise<PostingDeps> {
  return { control: await loadRequiredControlAccounts(orgId) };
}

export interface RecurringRunResult {
  generated: number;
  posted: number;
  failed: number;
  documents: { scheduleId: string; documentId: string; documentNumber: string; posted: boolean }[];
}

/**
 * The occurrence a generation is for: one schedule, one due date. When passed,
 * the generated document is committed with a matching
 * `recurring_occurrence_documents` guard row and any later attempt for the same
 * key replays that document instead of generating a second one.
 */
export interface OccurrenceKey {
  scheduleId: string;
  occurrenceOn: string;
}

/**
 * The document an earlier attempt committed for this occurrence, if any.
 * Replaying it — rather than generating again — is what makes a retried tick
 * financially inert: the claim rollback can resurrect an occurrence only into
 * a replay, never into a second posting.
 */
async function findOccurrenceDocument(
  orgId: string,
  scheduleId: string,
  occurrenceOn: string,
): Promise<{ documentId: string; documentNumber: string; posted: boolean } | null> {
  const prior = (await db.execute<{ id: string; documentNumber: string; status: string }>(sql`
    select d.id, d.document_number as "documentNumber", d.status
      from recurring_occurrence_documents g
      join documents d on d.id = g.document_id and d.org_id = g.org_id
     where g.org_id = ${orgId} and g.schedule_id = ${scheduleId} and g.occurrence_on = ${occurrenceOn}
     limit 1
  `));
  const row = prior.rows[0];
  if (!row) return null;
  return { documentId: row.id, documentNumber: row.documentNumber, posted: row.status === "posted" };
}

/**
 * Generate every recurring document that is due as of `asOf` (default: today).
 * Scans org-lessly under bypass, claims each occurrence, then does the clone +
 * optional post inside a per-org RLS transaction so posting sees the right
 * tenant scope. Safe to call every scheduler tick — self-throttling on
 * next_run_on.
 */
export async function runDueRecurringSchedules(asOf?: string): Promise<RecurringRunResult> {
  // The org-spanning query is only a bounded candidate scan. UTC+14 can already
  // be on tomorrow's calendar date, so include that horizon; the authoritative
  // due gate below uses each candidate's org business day before claiming it.
  const scanCutoff = asOf ?? addDays(toIso(now()), 1);
  const result: RecurringRunResult = { generated: 0, posted: 0, failed: 0, documents: [] };
  const orgBusinessDates = new Map<string, string>();

  const due = await withBypass(async () => {
    return (await db.execute<{
        id: string;
        orgId: string;
        templateId: string;
        cadence: Cadence;
        cron: string | null;
        nextRunOn: string;
        endsOn: string | null;
        autoPost: boolean;
        lastRunAt: Date | null;
      }>(sql`
      select rs.id, rs.org_id as "orgId", rs.template_document_id as "templateId",
             rs.cadence, rs.cron, rs.next_run_on as "nextRunOn", rs.ends_on as "endsOn",
             rs.auto_post as "autoPost", rs.last_run_at as "lastRunAt"
        from recurring_schedules rs
        join orgs o on o.id = rs.org_id and o.env_kind = 'production'
        join documents d on d.id = rs.template_document_id and d.org_id = rs.org_id
       where rs.is_active and rs.next_run_on <= ${scanCutoff}
         and case d.kind
           when 'quote' then coalesce((o.settings->'features'->>'orders')::boolean, true)
           when 'sales_order' then coalesce((o.settings->'features'->>'orders')::boolean, true)
           when 'purchase_order' then coalesce((o.settings->'features'->>'orders')::boolean, true)
           when 'expense_report' then coalesce((o.settings->'features'->>'expenses')::boolean, true)
           when 'pay_run' then coalesce((o.settings->'features'->>'payroll')::boolean, false)
           when 'project_charge' then coalesce((o.settings->'features'->>'projects')::boolean, true)
           else true
         end
       order by rs.next_run_on
    `));
  });

  for (const s of due.rows) {
    let today = asOf ?? orgBusinessDates.get(s.orgId);
    if (!today) {
      today = await withOrg(s.orgId, () => businessToday(s.orgId));
      orgBusinessDates.set(s.orgId, today);
    }
    if (s.nextRunOn > today) continue;

    const occurrenceDate = s.nextRunOn;
    const advanced = advanceCadence(occurrenceDate, s.cadence, s.cron);
    // Deactivate once we pass ends_on rather than looping forever.
    const stillActive = !s.endsOn || advanced <= s.endsOn;

    // Claim the occurrence: only the tick that flips next_run_on off its current
    // value proceeds. Deactivate in the same statement if this was the last one.
    // If generation then fails, the catch rolls this claim back: a persistently
    // failing schedule stays due and retries every tick, surfacing through
    // last_error (the operator's signal — there is no failure counter in the
    // schema). That is preferable to silently losing the occurrence, which is
    // what leaving the claim advanced would do.
    const claimed = await withBypass(async () => {
      return (await db.execute<{ id: string }>(sql`
        update recurring_schedules
           set next_run_on = ${advanced},
               is_active = ${stillActive},
               last_run_at = now()
         where id = ${s.id} and org_id = ${s.orgId} and next_run_on = ${occurrenceDate}
        returning id
      `));
    });
    if (!claimed.rows.length) continue; // another tick won it

    let gen: { documentId: string; documentNumber: string; posted: boolean };
    try {
      gen = await withOrg(s.orgId, async () =>
        generateFromTemplate(s.orgId, s.templateId, today, s.autoPost, {
          scheduleId: s.id,
          occurrenceOn: occurrenceDate,
        }),
      );
      result.generated += 1;
      if (gen.posted) result.posted += 1;
      result.documents.push({ scheduleId: s.id, ...gen });
    } catch (e) {
      result.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      await withBypass(async () => {
        // Roll the claim back so the next tick retries the occurrence. The
        // restore is guarded on the advanced value: a concurrent writer that
        // has legitimately moved the schedule wins over our rollback.
        const rollback = scheduleClaimRollback(s, advanced);
        await db.execute(sql`
          update recurring_schedules
             set next_run_on = ${rollback.nextRunOn}, is_active = ${rollback.isActive},
                 last_run_at = ${rollback.lastRunAt}
            where id = ${s.id} and org_id = ${s.orgId} and next_run_on = ${rollback.expectedNextRunOn}
        `);
        await db.execute(sql`
          update recurring_schedules set last_error = ${message} where id = ${s.id} and org_id = ${s.orgId}
        `);
      });
      continue;
    }
    // Success bookkeeping deliberately lives OUTSIDE the catch above. By this
    // point the occurrence durably produced exactly one document (the
    // generation transaction committed it together with its occurrence-guard
    // row), so a transient bookkeeping failure must NOT roll the claim back:
    // restoring next_run_on after a posted document is precisely how a tick
    // used to double-post. Surface through last_error instead; the claim stays
    // advanced so the schedule moves on to its next occurrence.
    try {
      await withBypass(async () => {
        await db.execute(sql`
          update recurring_schedules
             set run_count = run_count + 1, last_document_id = ${gen.documentId}, last_error = null
           where id = ${s.id} and org_id = ${s.orgId}
        `);
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[recurring] success bookkeeping failed for schedule ${s.id}:`, message);
      await withBypass(async () => {
        await db.execute(sql`
          update recurring_schedules
             set last_error = ${`generated ${gen.documentNumber} but bookkeeping failed: ${message}`}
           where id = ${s.id} and org_id = ${s.orgId}
        `);
      });
    }
  }
  return result;
}

/**
 * Force-generate one schedule immediately (the "run now" button), independent of
 * next_run_on. Does not advance the cadence — a manual run is out-of-band and
 * must not skip the next scheduled occurrence. The manual document is still
 * guarded per occurrence date, so a double-click — or a "run now" racing a tick
 * due the same day — replays the first document instead of posting a duplicate.
 */
export async function runScheduleNow(
  scheduleId: string,
  asOf?: string,
): Promise<{ documentId: string; documentNumber: string; posted: boolean }> {
  const s = await withBypass(async () => {
    return (await db.execute<{ orgId: string; templateId: string; autoPost: boolean }>(sql`
      select org_id as "orgId", template_document_id as "templateId", auto_post as "autoPost"
        from recurring_schedules where id = ${scheduleId}
    `));
  });
  const row = s.rows[0];
  if (!row) throw new Error("recurring schedule not found");
  const today = asOf ?? (await businessToday(row.orgId));
  const gen = await withOrg(row.orgId, () =>
    generateFromTemplate(row.orgId, row.templateId, today, row.autoPost, {
      scheduleId,
      occurrenceOn: today,
    }),
  );
  await withBypass(async () => {
    await db.execute(sql`
      update recurring_schedules
         set run_count = run_count + 1, last_document_id = ${gen.documentId}, last_error = null
       where id = ${scheduleId} and org_id = ${row.orgId}
    `);
  });
  return gen;
}

async function generateFromTemplate(
  orgId: string,
  templateId: string,
  documentDate: string,
  autoPost: boolean,
  occurrence?: OccurrenceKey,
): Promise<{ documentId: string; documentNumber: string; posted: boolean }> {
  // Per-occurrence dedupe (see recurring_occurrence_documents). The caller's
  // withOrg transaction pins one connection, so the lock, the replay check, the
  // clone, and the guard insert below are one atomic unit.
  if (occurrence) {
    // Serialize concurrent generations for one schedule (a tick vs a "run now")
    // exactly like billOne serializes invoice attempts on its subscription row:
    // the loser waits here, then its replay check sees the winner's committed
    // guard row instead of racing it to a duplicate document.
    await db.execute(sql`
      select id from recurring_schedules
       where id = ${occurrence.scheduleId} and org_id = ${orgId}
       for update
    `);
    const prior = await findOccurrenceDocument(orgId, occurrence.scheduleId, occurrence.occurrenceOn);
    if (prior) return prior;
  }

  const tplRes = (await db.execute<Record<string, any>>(sql`
    select * from documents where id = ${templateId} and org_id = ${orgId}
  `));
  const tpl = tplRes.rows[0];
  if (!tpl) throw new Error("recurring template document not found");
  if (!(await isRecurringKindEnabled(orgId, String(tpl.kind)))) {
    throw new Error("template document kind is disabled");
  }

  const lineRes = (await db.execute<Record<string, any>>(sql`
    select * from document_lines where document_id = ${templateId} and org_id = ${orgId}
     order by line_number
  `));
  // Stored templates and existing generated documents stay. Turning Inventory
  // off must refuse a generate that would persist inventory / assembly / kit.
  if (!(await inventoryFeatureEnabled(db, orgId))) {
    const itemIds = [...new Set(
      lineRes.rows.map((line) => line.item_id).filter((itemId): itemId is string => Boolean(itemId)),
    )];
    for (const itemId of itemIds) {
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${itemId} and org_id = ${orgId}`));
      if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
        throw new RecurringError("Inventory is disabled", 404);
      }
    }
  }
  // Stored templates and existing generated documents stay. Turning Equipment
  // off must refuse a generate that would persist equipment_charge.
  const equipmentOn = (await db.execute<{ enabled: boolean }>(sql`
    select coalesce((settings->'features'->>'equipment')::boolean, true) as enabled
      from orgs where id = ${orgId}
  `)).rows[0]?.enabled === true;
  if (!equipmentOn) {
    const itemIds = [...new Set(
      lineRes.rows.map((line) => line.item_id).filter((itemId): itemId is string => Boolean(itemId)),
    )];
    for (const itemId of itemIds) {
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${itemId} and org_id = ${orgId}`));
      if (item.rows[0] && item.rows[0].kind === "equipment_charge") {
        throw new RecurringError("Equipment is disabled", 404);
      }
    }
  }

  const termDays =
    tpl.document_date && tpl.due_date ? dayDiff(tpl.document_date, tpl.due_date) : null;
  const dueDate = termDays != null ? addDays(documentDate, termDays) : null;

  const documentNumber = await nextNumber(orgId, tpl.kind, tpl.subsidiary_id ?? null);
  const created = (await db.execute<{ id: string }>(sql`
    insert into documents (org_id, kind, document_number, party_id, subsidiary_id, document_date,
                           due_date, currency, status, project_id, department_id, location_id, class_id,
                           billing_method, reference_number, memo, subtotal, tax_total, total, created_by)
    values (${orgId}, ${tpl.kind}, ${documentNumber}, ${tpl.party_id}, ${tpl.subsidiary_id},
            ${documentDate}, ${dueDate}, ${tpl.currency}, 'draft', ${tpl.project_id},
            ${tpl.department_id}, ${tpl.location_id}, ${tpl.class_id}, ${tpl.billing_method},
            ${tpl.reference_number}, ${tpl.memo}, '0', '0', '0', ${tpl.created_by})
    returning id
  `));
  const newId = created.rows[0]!.id;

  const amounts: string[] = [];
  const taxes: string[] = [];
  for (const l of lineRes.rows) {
    await db.execute(sql`
      insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
            quantity, unit, unit_price, amount, tax_code_id, tax_amount, department_id, project_id,
            location_id, class_id, party_id, is_billable, custom, created_by)
      values (${orgId}, ${newId}, ${l.line_number}, ${l.item_id}, ${l.account_id}, ${l.description},
            ${l.quantity}, ${l.unit}, ${l.unit_price}, ${l.amount}, ${l.tax_code_id},
            ${l.tax_amount ?? "0"}, ${l.department_id}, ${l.project_id}, ${l.location_id}, ${l.class_id},
            ${l.party_id}, ${l.is_billable ?? false}, ${JSON.stringify(l.custom ?? {})}::jsonb, ${l.created_by})
    `);
    amounts.push(String(l.amount ?? "0"));
    taxes.push(String(l.tax_amount ?? "0"));
  }

  const subtotal = amounts.length ? sum(amounts) : "0";
  const taxTotal = taxes.length ? sum(taxes) : "0";
  await db.execute(sql`
    update documents set subtotal = ${subtotal}, tax_total = ${taxTotal}, total = ${add(subtotal, taxTotal)}
     where id = ${newId} and org_id = ${orgId}
  `);

  let posted = false;
  if (autoPost) {
    if (!tpl.created_by) {
      throw new Error("recurring template has no attributable creator");
    }
    const actorId = String(tpl.created_by);
    const submission = await submitAndReleaseIfUngated(tpl.kind, newId, actorId);
    if (submission.flowError) {
      throw new Error(`approval could not be routed: ${submission.flowError}`);
    }
    if (!submission.gated) {
      const deps = await controlDeps(orgId);
      await postDocument(newId, deps);
      posted = true;
    }
  }
  // Name the finished document for this occurrence in the same transaction that
  // created it. If anything above threw, the guard row rolls back with the
  // draft — a failed generation never consumes the occurrence. If it commits,
  // every future attempt for this key replays the document below instead of
  // re-posting it; the unique index backstops the invariant even under
  // unexpected concurrency.
  if (occurrence) {
    await db.execute(sql`
      insert into recurring_occurrence_documents
        (org_id, schedule_id, occurrence_on, document_id, created_by)
      values (${orgId}, ${occurrence.scheduleId}, ${occurrence.occurrenceOn}, ${newId}, ${tpl.created_by})
    `);
  }
  return { documentId: newId, documentNumber, posted };
}
