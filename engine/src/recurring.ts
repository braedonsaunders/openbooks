import { sql, type SQL } from "drizzle-orm";
import { db, withBypass, withOrg } from "./db.ts";
import { allocateDocumentNumber } from "./document-numbering.ts";
import { actorHasPermission } from "./actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "./actor-subsidiaries.ts";
import { addCalendarDays, parseIsoDate, businessToday } from "./business-date.ts";
import { now } from "./clock.ts";
import { loadRequiredControlAccounts } from "./control-accounts.ts";
import { inventoryFeatureEnabled } from "./inventory.ts";
import { add, cmp, neg, sum } from "./money.ts";
import { postDocument, type PostingDeps } from "./posting.ts";
import { submitAndReleaseIfUngated } from "./flows/submit.ts";
import { computeLineTaxes, type TaxComponentConfig } from "./tax.ts";
import { loadTaxProfileConfig, persistLineTaxComponents } from "./tax-persist.ts";
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
 * Claiming is the same advance-and-guard trick the script scheduler uses — the
 * UPDATE … WHERE next_run_on = $old lets only one tick win an occurrence — but
 * it runs INSIDE the generation transaction: the claim and the generated
 * document commit atomically. An earlier design claimed first in its own
 * transaction and rolled back on failure, which a hard process kill between
 * the two commits could not do — the claim stayed advanced with nothing
 * generated, permanently skipping the occurrence. Sharing one transaction
 * closes that window: a crash rolls both back, the schedule stays due, and the
 * next tick retries. Never silently lost.
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

/** Execution authority covers the header and every explicit line entity.
 * A standing intercompany journal must not act in a hidden entity merely
 * because its header is visible. Template parent locks fence line edits. */
export function recurringTemplateScopeFilter(
  orgId: string, documentId: SQL, subsidiaryId: SQL, allowed: ReadonlySet<string> | null,
): SQL {
  if (allowed === null) return sql``;
  if (!allowed.size) return sql` and false`;
  const ids = `{${[...allowed].join(",")}}`;
  return sql` and ${subsidiaryId} = any(${ids}::uuid[])
    and not exists (
      select 1 from document_lines recurring_scope_line
       where recurring_scope_line.org_id = ${orgId} and recurring_scope_line.document_id = ${documentId}
         and recurring_scope_line.subsidiary_id is not null
         and not (recurring_scope_line.subsidiary_id = any(${ids}::uuid[]))
    )`;
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

function toIso(d: Date): string {
  const value = d.toISOString().slice(0, 10);
  parseIsoDate(value);
  return value;
}

/** Advance one occurrence, clamping month-end anchors and rejecting invalid
 * configuration rather than silently substituting a different billing rule. */
export function advanceCadence(
  isoDate: string, cadence: Cadence, cron?: string | null, from?: Date,
): string {
  try {
    const base = parseIsoDate(isoDate);
    if (cadence === "weekly" || cadence === "biweekly") {
      return addCalendarDays(isoDate, cadence === "weekly" ? 7 : 14);
    }
    if (cadence === "custom_cron") {
      // Start just before the next calendar day so midnight crons do not skip
      // tomorrow. Every occurrence must advance strictly beyond this date.
      const nextDay = parseIsoDate(addCalendarDays(isoDate, 1));
      const next = computeNextRunAt(cron ?? "", from ?? new Date(nextDay.getTime() - 1));
      if (!next || toIso(next) <= isoDate) throw new RecurringError("invalid recurring cron or non-advancing occurrence");
      return toIso(next);
    }
    if (!["monthly", "quarterly", "annually"].includes(cadence)) {
      throw new RecurringError("invalid recurring cadence");
    }
    const day = base.getUTCDate();
    base.setUTCDate(1);
    base.setUTCMonth(base.getUTCMonth() + (cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12));
    const last = new Date(base);
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    base.setUTCDate(Math.min(day, last.getUTCDate()));
    return toIso(base);
  } catch (error) {
    if (error instanceof RecurringError) throw error;
    throw new RecurringError("invalid recurring calendar date or cadence outside the supported date range");
  }
}

/** Whole-day difference b − a (both ISO), used to carry the payment term. */
function dayDiff(a: string, b: string): number {
  return (parseIsoDate(b).getTime() - parseIsoDate(a).getTime()) / 86_400_000;
}

const addDays = addCalendarDays;

async function nextNumber(orgId: string, kind: string): Promise<string> {
  return allocateDocumentNumber(db, orgId, kind, defaultPrefix(kind));
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

type RecurringRunSource = "scheduler" | "run_now";

/**
 * Generation attribution is explicit at the private write boundary. Scheduled
 * ticks have no human actor; authenticated Run Now calls carry the gate user.
 * The immutable occurrence row retains the schedule/date source, while the
 * document custom payload makes the invocation kind directly inspectable.
 */
interface GenerationContext extends OccurrenceKey {
  actorId: string | null;
  runSource: RecurringRunSource;
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
      }>(sql`
      select rs.id, rs.org_id as "orgId", rs.template_document_id as "templateId",
             rs.cadence, rs.cron, rs.next_run_on as "nextRunOn", rs.ends_on as "endsOn",
             rs.auto_post as "autoPost"
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

    // Claim the occurrence INSIDE the generation transaction: the tick that
    // flips next_run_on off its current value and the cloned document commit
    // atomically, so no crash window can strand an advanced next_run_on with
    // nothing generated — a killed process rolls back to "still due" and the
    // next tick retries. Only one tick can win the compare-and-swap: a
    // concurrent tick blocks on this row lock and, when the winner commits,
    // re-evaluates the WHERE against the advanced value and claims zero rows.
    // Deactivating a final occurrence shares the same fate — it lands only if
    // the document did.
    let gen: { documentId: string; documentNumber: string; posted: boolean } | null = null;
    try {
      gen = await withOrg(s.orgId, async () => {
        const current = (await db.execute<{
          templateId: string; autoPost: boolean; isActive: boolean; nextRunOn: string;
          cadence: Cadence; cron: string | null; endsOn: string | null;
        }>(sql`
          select template_document_id as "templateId", auto_post as "autoPost", is_active as "isActive",
                 next_run_on::text as "nextRunOn", cadence, cron, ends_on::text as "endsOn"
            from recurring_schedules where id = ${s.id} and org_id = ${s.orgId} for update
        `)).rows[0];
        if (!current?.isActive || current.nextRunOn !== occurrenceDate) return null;
        if (current.endsOn && occurrenceDate > current.endsOn) {
          throw new RecurringError("recurring occurrence is after the schedule end date");
        }
        const advanced = advanceCadence(occurrenceDate, current.cadence, current.cron);
        const stillActive = !current.endsOn || advanced <= current.endsOn;
        const claimed = (await db.execute<{ id: string }>(sql`
          update recurring_schedules
             set next_run_on = ${advanced},
                 is_active = ${stillActive},
                 last_run_at = now()
           where id = ${s.id} and org_id = ${s.orgId} and next_run_on = ${occurrenceDate}
          returning id
        `));
        if (!claimed.rows.length) return null; // another tick won it
        return generateFromTemplate(s.orgId, current.templateId, today, current.autoPost, {
          scheduleId: s.id,
          occurrenceOn: occurrenceDate,
          actorId: null,
          runSource: "scheduler",
        });
      });
    } catch (e) {
      // Generation threw — withOrg already rolled the whole unit back, claim
      // included, so there is nothing to restore. A persistently failing
      // schedule stays due and retries every tick, surfacing through
      // last_error (the operator's signal — there is no failure counter in
      // the schema). That is preferable to silently losing the occurrence.
      result.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      await withBypass(async () => {
        await db.execute(sql`
          update recurring_schedules set last_error = ${message} where id = ${s.id} and org_id = ${s.orgId}
        `);
      });
      continue;
    }
    if (!gen) continue; // another tick won it
    result.generated += 1;
    if (gen.posted) result.posted += 1;
    result.documents.push({ scheduleId: s.id, ...gen });
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
  actorId: string,
  asOf?: string,
  authority?: { orgId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; canPost: boolean },
): Promise<{ documentId: string; documentNumber: string; posted: boolean }> {
  const s = await withBypass(async () => {
    return (await db.execute<{ orgId: string; templateId: string; autoPost: boolean }>(sql`
      select org_id as "orgId", template_document_id as "templateId", auto_post as "autoPost"
        from recurring_schedules where id = ${scheduleId}
    `));
  });
  const row = s.rows[0];
  if (!row || (authority && authority.orgId !== row.orgId)) throw new RecurringError("recurring schedule not found", 404);
  const today = asOf ?? (await businessToday(row.orgId));
  const gen = await withOrg(row.orgId, async () => {
    const current = (await db.execute<{ templateId: string; autoPost: boolean }>(sql`
      select template_document_id as "templateId", auto_post as "autoPost"
        from recurring_schedules where id = ${scheduleId} and org_id = ${row.orgId} for update
    `)).rows[0];
    if (!current) throw new RecurringError("recurring schedule not found", 404);
    if (!(await actorHasPermission(db, row.orgId, actorId, "documents.manage"))) {
      throw new RecurringError("missing permission: documents.manage", 403);
    }
    const scope = await actorAllowedSubsidiaryIds(db, row.orgId, actorId);
    await db.execute(sql`select id from documents
      where id = ${current.templateId} and org_id = ${row.orgId} for share`);
    const template = (await db.execute<{ kind: string }>(sql`
      select d.kind from documents d
       where d.id = ${current.templateId} and d.org_id = ${row.orgId}
         ${recurringTemplateScopeFilter(row.orgId, sql`d.id`, sql`d.subsidiary_id`, scope)}
         ${authority ? recurringTemplateScopeFilter(row.orgId, sql`d.id`, sql`d.subsidiary_id`, authority.allowedSubsidiaryIds) : sql``}
       for share of d
    `)).rows[0];
    if (!template) throw new RecurringError("recurring schedule not found", 404);
    if (!(await isRecurringKindEnabled(row.orgId, template.kind))) {
      throw new RecurringError("template document kind is disabled", 404);
    }
    if (current.autoPost && ((authority && !authority.canPost)
        || !(await actorHasPermission(db, row.orgId, actorId, "gl.post")))) {
      throw new RecurringError("missing permission: gl.post", 403);
    }
    return generateFromTemplate(row.orgId, current.templateId, today, current.autoPost, {
      scheduleId, occurrenceOn: today, actorId, runSource: "run_now",
    });
  });
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
  context: GenerationContext,
): Promise<{ documentId: string; documentNumber: string; posted: boolean }> {
  // Per-occurrence dedupe (see recurring_occurrence_documents). The caller's
  // withOrg transaction pins one connection, so the lock, the replay check, the
  // clone, and the guard insert below are one atomic unit.
  // Serialize concurrent generations for one schedule (a tick vs a "run now")
  // exactly like billOne serializes invoice attempts on its subscription row:
  // the loser waits here, then its replay check sees the winner's committed
  // guard row instead of racing it to a duplicate document.
  await db.execute(sql`
    select id from recurring_schedules
     where id = ${context.scheduleId} and org_id = ${orgId}
     for update
  `);
  const prior = await findOccurrenceDocument(orgId, context.scheduleId, context.occurrenceOn);
  if (prior) return prior;

  const tplRes = (await db.execute<Record<string, any>>(sql`
    select * from documents where id = ${templateId} and org_id = ${orgId} for share
  `));
  const tpl = tplRes.rows[0];
  if (!tpl) throw new Error("recurring template document not found");
  if (!(await isRecurringKindEnabled(orgId, String(tpl.kind)))) {
    throw new Error("template document kind is disabled");
  }

  const lineRes = (await db.execute<Record<string, unknown>>(sql`
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

  const documentNumber = await nextNumber(orgId, tpl.kind);
  const provenance = {
    recurringScheduleId: context.scheduleId,
    recurringOccurrenceOn: context.occurrenceOn,
    recurringRunSource: context.runSource,
    ...(context.actorId === null
      ? { actorKind: "system", actorReason: "recurring schedule" }
      : {}),
  };
  const created = (await db.execute<{ id: string }>(sql`
    insert into documents (org_id, kind, document_number, party_id, subsidiary_id, document_date,
                           due_date, currency, status, project_id, department_id, location_id, class_id,
                           billing_method, reference_number, memo, subtotal, tax_total, total, extra_dims, custom, created_by)
    values (${orgId}, ${tpl.kind}, ${documentNumber}, ${tpl.party_id}, ${tpl.subsidiary_id},
            ${documentDate}, ${dueDate}, ${tpl.currency}, 'draft', ${tpl.project_id},
            ${tpl.department_id}, ${tpl.location_id}, ${tpl.class_id}, ${tpl.billing_method},
            ${tpl.reference_number}, ${tpl.memo}, '0', '0', '0',
            ${JSON.stringify(tpl.extra_dims ?? {})}::jsonb, ${JSON.stringify(provenance)}::jsonb, ${context.actorId})
    returning id
  `));
  const newId = created.rows[0]!.id;

  const amounts: string[] = [];
  const taxes: string[] = [];
  const taxProfiles = new Map<string, TaxComponentConfig[]>();
  for (const l of lineRes.rows) {
    const profileKey = `${l.tax_code_id ?? ""}:${l.tax_group_id ?? ""}`;
    let configs = taxProfiles.get(profileKey);
    if (!configs) {
      configs = await loadTaxProfileConfig(orgId, {
        taxCodeId: l.tax_code_id ? String(l.tax_code_id) : null,
        taxGroupId: l.tax_group_id ? String(l.tax_group_id) : null,
      }, documentDate);
      taxProfiles.set(profileKey, configs);
    }
    if (configs.some(config => config.priceIncludesTax) && l.tax_input_amount == null) {
      throw new RecurringError(`template line ${l.line_number} is missing its tax-inclusive input amount`);
    }
    const tax = configs.length ? computeLineTaxes(String(l.tax_input_amount ?? l.amount), configs, {
      overridden: l.tax_overridden === true, taxAmount: String(l.tax_amount ?? "0"),
    }) : null;
    const amount = tax?.netAmount ?? String(l.amount);
    const taxAmount = tax?.taxTotal ?? String(l.tax_amount ?? "0");
    const inserted = await db.execute<{ id: string }>(sql`
      insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
            quantity, unit, unit_price, amount, tax_code_id, tax_group_id, tax_input_amount, tax_overridden, tax_amount, department_id, project_id,
            location_id, class_id, subsidiary_id, extra_dims, party_id, is_billable, custom, created_by)
      values (${orgId}, ${newId}, ${l.line_number}, ${l.item_id}, ${l.account_id}, ${l.description},
            ${l.quantity}, ${l.unit}, ${l.unit_price}, ${amount}, ${l.tax_code_id}, ${l.tax_group_id}, ${tax?.inputAmount ?? l.tax_input_amount}, ${tax?.overridden ?? l.tax_overridden},
            ${taxAmount}, ${l.department_id}, ${l.project_id}, ${l.location_id}, ${l.class_id},
            ${l.subsidiary_id}, ${JSON.stringify(l.extra_dims ?? {})}::jsonb, ${l.party_id}, ${l.is_billable ?? false}, ${JSON.stringify(l.custom ?? {})}::jsonb, ${context.actorId})
      returning id
    `);
    if (tax) await persistLineTaxComponents(orgId, inserted.rows[0]!.id, tax.components, context.actorId);
    amounts.push(amount);
    taxes.push(taxAmount);
  }

  // Header totals must tie to the cloned lines under the storage invariant
  // (0017_document_total_line_invariant): commercial kinds carry
  // subtotal = Σ amount and total = subtotal + tax, while a standing journal's
  // lines are signed legs that balance to zero, so its header is the debit-side
  // view — total = Σ positive amounts — the same shape the journals writer and
  // payroll commits produce.
  const taxTotal = taxes.length ? sum(taxes) : "0";
  const journalShaped = tpl.kind === "journal" || tpl.kind === "pay_run";
  const debitSum = journalShaped
    ? sum(amounts.filter((amount) => cmp(amount, "0") > 0))
    : "";
  const subtotal = amounts.length
    ? (journalShaped ? add(debitSum, neg(taxTotal)) : sum(amounts))
    : "0";
  const total = amounts.length
    ? (journalShaped ? debitSum : add(subtotal, taxTotal))
    : "0";
  await db.execute(sql`
    update documents set subtotal = ${subtotal}, tax_total = ${taxTotal}, total = ${total}
     where id = ${newId} and org_id = ${orgId}
  `);

  let posted = false;
  if (autoPost) {
    const submission = await submitAndReleaseIfUngated(tpl.kind, newId, context.actorId);
    if (submission.flowError) {
      throw new Error(`approval could not be routed: ${submission.flowError}`);
    }
    if (!submission.gated) {
      const deps = await controlDeps(orgId);
      await postDocument(newId, deps, {
        audit: {
          actorId: context.actorId,
          source: context.runSource === "scheduler" ? "recurring_schedule" : "recurring_run_now",
        },
      });
      posted = true;
    }
  }
  // Name the finished document for this occurrence in the same transaction that
  // created it. If anything above threw, the guard row rolls back with the
  // draft — a failed generation never consumes the occurrence. If it commits,
  // every future attempt for this key replays the document below instead of
  // re-posting it; the unique index backstops the invariant even under
  // unexpected concurrency.
  await db.execute(sql`
    insert into recurring_occurrence_documents
      (org_id, schedule_id, occurrence_on, document_id, created_by)
    values (${orgId}, ${context.scheduleId}, ${context.occurrenceOn}, ${newId}, ${context.actorId})
  `);
  return { documentId: newId, documentNumber, posted };
}
