import { sql } from "drizzle-orm";
import { db, withBypass, withOrg } from "./db.ts";
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
 * occurrence, so horizontal scaling can never double-bill.
 */

export type Cadence =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "annually"
  | "custom_cron";

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

async function controlDeps(orgId: string): Promise<PostingDeps> {
  const r = (await db.execute<{ c: Record<string, string> | null }>(
    sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`,
  ));
  const c = r.rows[0]?.c ?? {};
  return {
    control: {
      ar: c.ar!,
      ap: c.ap!,
      bank: c.bank!,
      taxCollected: c.taxCollected,
      taxPaid: c.taxPaid,
      employeePayable: c.employeePayable,
    },
  };
}

export interface RecurringRunResult {
  generated: number;
  posted: number;
  failed: number;
  documents: { scheduleId: string; documentId: string; documentNumber: string; posted: boolean }[];
}

/**
 * Generate every recurring document that is due as of `asOf` (default: today).
 * Scans org-lessly under bypass, claims each occurrence, then does the clone +
 * optional post inside a per-org RLS transaction so posting sees the right
 * tenant scope. Safe to call every scheduler tick — self-throttling on
 * next_run_on.
 */
export async function runDueRecurringSchedules(asOf?: string): Promise<RecurringRunResult> {
  const today = asOf ?? toIso(new Date());
  const result: RecurringRunResult = { generated: 0, posted: 0, failed: 0, documents: [] };

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
       where rs.is_active and rs.next_run_on <= ${today}
       order by rs.next_run_on
    `));
  });

  for (const s of due.rows) {
    const occurrenceDate = s.nextRunOn;
    const advanced = advanceCadence(occurrenceDate, s.cadence, s.cron);
    // Deactivate once we pass ends_on rather than looping forever.
    const stillActive = !s.endsOn || advanced <= s.endsOn;

    // Claim the occurrence: only the tick that flips next_run_on off its current
    // value proceeds. Deactivate in the same statement if this was the last one.
    const claimed = await withBypass(async () => {
      return (await db.execute<{ id: string }>(sql`
        update recurring_schedules
           set next_run_on = ${advanced},
               is_active = ${stillActive},
               last_run_at = now()
         where id = ${s.id} and next_run_on = ${occurrenceDate}
        returning id
      `));
    });
    if (!claimed.rows.length) continue; // another tick won it

    try {
      const gen = await withOrg(s.orgId, () =>
        generateFromTemplate(s.orgId, s.templateId, today, s.autoPost),
      );
      result.generated += 1;
      if (gen.posted) result.posted += 1;
      result.documents.push({ scheduleId: s.id, ...gen });
      await withBypass(async () => {
        await db.execute(sql`
          update recurring_schedules
             set run_count = run_count + 1, last_document_id = ${gen.documentId}, last_error = null
           where id = ${s.id}
        `);
      });
    } catch (e) {
      result.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      await withBypass(async () => {
        await db.execute(sql`
          update recurring_schedules set last_error = ${message} where id = ${s.id}
        `);
      });
    }
  }
  return result;
}

/**
 * Force-generate one schedule immediately (the "run now" button), independent of
 * next_run_on. Does not advance the cadence — a manual run is out-of-band and
 * must not skip the next scheduled occurrence.
 */
export async function runScheduleNow(
  scheduleId: string,
  asOf?: string,
): Promise<{ documentId: string; documentNumber: string; posted: boolean }> {
  const today = asOf ?? toIso(new Date());
  const s = await withBypass(async () => {
    return (await db.execute<{ orgId: string; templateId: string; autoPost: boolean }>(sql`
      select org_id as "orgId", template_document_id as "templateId", auto_post as "autoPost"
        from recurring_schedules where id = ${scheduleId}
    `));
  });
  const row = s.rows[0];
  if (!row) throw new Error("recurring schedule not found");
  const gen = await withOrg(row.orgId, () =>
    generateFromTemplate(row.orgId, row.templateId, today, row.autoPost),
  );
  await withBypass(async () => {
    await db.execute(sql`
      update recurring_schedules
         set run_count = run_count + 1, last_document_id = ${gen.documentId}, last_error = null
       where id = ${scheduleId}
    `);
  });
  return gen;
}

async function generateFromTemplate(
  orgId: string,
  templateId: string,
  documentDate: string,
  autoPost: boolean,
): Promise<{ documentId: string; documentNumber: string; posted: boolean }> {
  const tplRes = (await db.execute<Record<string, any>>(sql`
    select * from documents where id = ${templateId} and org_id = ${orgId}
  `));
  const tpl = tplRes.rows[0];
  if (!tpl) throw new Error("recurring template document not found");

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

  const lineRes = (await db.execute<Record<string, any>>(sql`
    select * from document_lines where document_id = ${templateId} and org_id = ${orgId}
     order by line_number
  `));

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
  return { documentId: newId, documentNumber, posted };
}
