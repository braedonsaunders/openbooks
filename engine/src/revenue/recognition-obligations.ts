/** Invoice-to-obligation creation. Split from revenue/recognition.ts (ARCH-FILE-SPLIT; pure moves only). */
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { cmp, sum } from "../money/money.ts";
import { allocateByRelativeSSP, fairValueRangeFlag } from "./recognition-apportionment.ts";
import { RevenueRecognitionError, revenueRecognitionFeatureEnabled } from "./recognition-transaction-price.ts";
import { buildAllRecognitionSchedulesOn } from "./recognition-schedule-build.ts";

// ---------------------------------------------------------------------------
// createObligationsFromInvoice — turn a posted invoice into obligations
// ---------------------------------------------------------------------------

export interface CreateObligationsResult {
  created: number;
  contractId: string | null;
  obligationIds: string[];
}

export function revenueContractPostingEffectKey(documentId: string): string {
  return `posting-effect:revenue-contract:document:${documentId}`;
}

export function revenueObligationPostingEffectKey(documentLineId: string): string {
  return `posting-effect:revenue-obligation:document-line:${documentLineId}`;
}

/**
 * After a customer invoice posts, create one performance obligation per rev-rec
 * line (item carries a recognition rule), allocate the deferred transaction
 * price across them by relative SSP, and build their recognition schedules on
 * every GL-posting book. Runs inside the invoice post flow, and it is ATOMIC:
 * each obligation commits together with its complete schedules, so a crash or
 * a schedule-build failure can never leave committed money obligations with no
 * recognition plan. Idempotent: lines that already have an obligation are
 * never duplicated, and replay repairs obligations an earlier interrupted or
 * legacy attempt left without full per-book coverage instead of skipping them.
 *
 * SSP source per line: item.standalone_selling_price → dated fair_value_prices
 * → the booked line amount. Deferred/recognized accounts resolve item → rule.
 */
export async function createObligationsFromInvoice(
  documentId: string,
  orgId: string,
  actorId: string | null,
): Promise<CreateObligationsResult> {
  if (!(await revenueRecognitionFeatureEnabled(db, orgId))) {
    return { created: 0, contractId: null, obligationIds: [] };
  }
  const docRes = (await db.execute<{ id: string; document_number: string; party_id: string | null; currency: string | null; document_date: string; subsidiary_id: string | null }>(sql`
    select id, document_number, party_id, currency, document_date, subsidiary_id
      from documents where id = ${documentId} and org_id = ${orgId} and kind = 'customer_invoice'`));
  const doc = docRes.rows[0];
  if (!doc || !doc.party_id) return { created: 0, contractId: null, obligationIds: [] };

  // Fair-value range policy: 'warn' (default) flags out-of-range allocations
  // for review; 'off' disables the check. Configured in Company & Accounting.
  const policyRes = (await db.execute<{ policy: string }>(sql`
    select coalesce(settings->'revenue'->>'fairValueRangePolicy', 'warn') as policy
      from orgs where id = ${orgId}`));
  const rangePolicy = policyRes.rows[0]?.policy === "off" ? "off" : "warn";

  const currency = doc.currency ?? "";
  const lineRes = (await db.execute<{
      line_id: string; description: string | null; amount: string; quantity: string | null; item_id: string;
      line_custom: Record<string, unknown> | null; income_account_id: string | null; item_deferred: string | null;
      item_ssp: string | null; revenue_allocation: string; rule_id: string; rule_deferred: string | null;
      rule_recognized: string | null; end_date_source: string; fair_value: string | null;
      fair_value_low: string | null; fair_value_high: string | null;
    }>(sql`
    select dl.id as line_id, dl.description, dl.amount, dl.quantity, dl.item_id, dl.custom as line_custom,
           it.income_account_id, it.deferred_account_id as item_deferred, it.standalone_selling_price as item_ssp,
           it.revenue_allocation,
           r.id as rule_id, r.deferred_account_id as rule_deferred, r.recognized_account_id as rule_recognized,
           r.end_date_source,
           fv.unit_price as fair_value, fv.low_value as fair_value_low, fv.high_value as fair_value_high
      from document_lines dl
      join items it on it.id = dl.item_id and it.org_id = dl.org_id and it.recognition_rule_id is not null
      join recognition_rules r on r.id = it.recognition_rule_id and r.org_id = it.org_id
      left join lateral (
        select unit_price, low_value, high_value from fair_value_prices f
         where f.org_id = ${orgId} and f.item_id = dl.item_id and f.is_active
           and (f.currency = ${currency} or ${currency} = '')
           and (f.effective_from is null or f.effective_from <= ${doc.document_date})
           and (f.effective_to is null or f.effective_to >= ${doc.document_date})
         order by f.effective_from desc nulls last limit 1
      ) fv on true
     where dl.document_id = ${documentId} and dl.org_id = ${orgId}
     order by dl.line_number`));
  if (lineRes.rows.length === 0) return { created: 0, contractId: null, obligationIds: [] };

  // Lines that already produced an obligation (idempotent replay).
  const existing = (await db.execute<{ id: string; document_line_id: string; allocated_price: string }>(sql`
    select id, document_line_id, allocated_price from performance_obligations
     where org_id = ${orgId} and document_line_id = any(${`{${lineRes.rows.map((l) => l.line_id).join(",")}}`}::uuid[])`));
  const already = new Set(existing.rows.map((r) => r.document_line_id));
  const existingObligationIds = existing.rows.map((r) => r.id);
  const lines = lineRes.rows.filter((l) => !already.has(l.line_id));

  // A partial legacy replay still allocates against the WHOLE invoice bundle.
  // Existing allocations are immutable here; configuration drift must be
  // reconciled explicitly rather than silently repricing surviving obligations.
  // A complete replay skips pricing and only repairs missing schedules.
  // Lines flagged
  // 'exclude' from allocation keep their booked amount and don't dilute others.
  const included = lines.length > 0 ? lineRes.rows.filter((l) => l.revenue_allocation !== "exclude") : [];
  const bundleTotal = sum(included.map((l) => l.amount));
  const alloc = allocateByRelativeSSP(
    bundleTotal,
    included.map((l) => ({ ssp: l.item_ssp ?? l.fair_value, booked: l.amount, quantity: l.quantity })),
  );
  const allocByLine = new Map<string, string>();
  included.forEach((l, i) => allocByLine.set(l.line_id, alloc[i]!));
  for (const l of lineRes.rows) if (l.revenue_allocation === "exclude") allocByLine.set(l.line_id, l.amount);
  if (lines.length > 0 && existing.rows.some((row) => cmp(row.allocated_price, allocByLine.get(row.document_line_id)!) !== 0)) {
    throw new RevenueRecognitionError("Partial revenue allocation conflicts with existing obligations; reconcile the contract before retrying");
  }
  const contractTotal = sum(lineRes.rows.map((l) => l.amount));

  const obligationIds: string[] = [];
  const contractId = await db.transaction(async (tx) => {
    let cId: string | null = null;
    if (lines.length > 0) {
      // One contract per invoice. The unique storage key is the concurrency
      // authority; contract_number remains business display data, not a mutex.
      const contractKey = revenueContractPostingEffectKey(documentId);
      const insertedContract = await tx.execute<{ id: string }>(sql`
        insert into revenue_contracts
          (org_id, subsidiary_id, customer_id, contract_number, idempotency_key, status, starts_on,
           currency, total_transaction_price, created_by, updated_by)
        values (${orgId}, ${doc.subsidiary_id}, ${doc.party_id}, ${doc.document_number}, ${contractKey}, 'active',
                ${doc.document_date}, ${doc.currency}, ${contractTotal}, ${actorId}, ${actorId})
        on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing
        returning id
      `);
      const existingContract = insertedContract.rows[0]
        ? null
        : await tx.execute<{ id: string; total_transaction_price: string }>(sql`
            select id, total_transaction_price from revenue_contracts
             where org_id=${orgId} and idempotency_key=${contractKey}
          `);
      cId = insertedContract.rows[0]?.id ?? existingContract?.rows[0]?.id ?? null;
      if (!cId) throw new Error("revenue contract idempotency winner was not visible");
      if (existingContract?.rows[0] && cmp(existingContract.rows[0].total_transaction_price, contractTotal) !== 0) {
        throw new RevenueRecognitionError("Partial revenue allocation conflicts with the existing contract total; reconcile the contract before retrying");
      }

      for (const l of lines) {
        const startsOn = (l.line_custom?.recognitionStartsOn as string) ?? doc.document_date;
        const endsOn = (l.line_custom?.recognitionEndsOn as string) ?? null;
        const deferred = l.item_deferred ?? l.rule_deferred;
        const recognized = l.rule_recognized ?? l.income_account_id;
        const allocated = allocByLine.get(l.line_id) ?? l.amount;
        const obligationKey = revenueObligationPostingEffectKey(l.line_id);
        const fvFlag = rangePolicy === "warn"
          ? fairValueRangeFlag(allocated, l.quantity, l.fair_value_low, l.fair_value_high)
          : null;
        const insObl = (await tx.execute<{ id: string }>(sql`
          insert into performance_obligations
            (org_id, contract_id, document_line_id, idempotency_key, item_id, description, recognition_rule_id,
             booked_amount, standalone_selling_price, allocated_price,
             fair_value_flag, fair_value_low, fair_value_high,
             recognition_starts_on, recognition_ends_on,
             deferred_account_id, recognized_account_id, status, created_by, updated_by)
          values (${orgId}, ${cId}, ${l.line_id}, ${obligationKey}, ${l.item_id}, ${l.description ?? "Revenue"}, ${l.rule_id},
                  ${l.amount}, ${l.item_ssp ?? l.fair_value}, ${allocated},
                  ${fvFlag}, ${fvFlag ? l.fair_value_low : null}, ${fvFlag ? l.fair_value_high : null},
                  ${startsOn}, ${endsOn}, ${deferred}, ${recognized}, 'open', ${actorId}, ${actorId})
          on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing
          returning id`));
        if (insObl.rows[0]) obligationIds.push(insObl.rows[0].id);
      }

      // The schedules commit WITH the obligations they plan: a crash or a
      // schedule-build failure rolls the whole effect back, so committed money
      // obligations can never be left without their recognition schedules.
      for (const oid of obligationIds) {
        await buildAllRecognitionSchedulesOn(tx, oid, orgId, actorId);
      }
    }

    return cId;
  });

  // Replay repair: an interrupted or legacy attempt may have committed
  // obligations whose per-book coverage is incomplete. Rebuild on every active
  // GL-posting book — the builder upserts each book's plan in place (posted
  // history preserved, unposted lines replaced), so replay converges to exactly
  // one complete schedule per obligation/book with no duplicate lines.
  if (existingObligationIds.length > 0) {
    await repairMissingRecognitionSchedules(db, documentId, orgId, actorId);
  }

  return { created: obligationIds.length, contractId, obligationIds };
}

/**
 * Find open or satisfied obligations of one invoice that lack a recognition
 * schedule on at least one active GL-posting book and rebuild them. Satisfied
 * obligations are deliberately included: an obligation can only flip to
 * satisfied by scanning EXISTING schedule lines, so coverage it never received
 * could not argue for its own completion — rebuilding restores what was lost.
 * Cancelled obligations keep their cancelled lineage untouched. Returns the
 * repaired ids.
 */
async function repairMissingRecognitionSchedules(
  runner: SqlExecutor,
  documentId: string,
  orgId: string,
  actorId: string | null,
): Promise<string[]> {
  const missing = (await runner.execute<{ id: string }>(sql`
    select o.id
      from performance_obligations o
      join document_lines dl on dl.id = o.document_line_id and dl.org_id = o.org_id
     where o.org_id = ${orgId}
       and dl.document_id = ${documentId}
       and o.status <> 'cancelled'
       and (
         select count(*)::int from recognition_schedules s
           join accounting_books b
             on b.id = s.book_id and b.org_id = s.org_id and b.is_active and b.posts_gl
          where s.obligation_id = o.id and s.org_id = o.org_id
       ) < (
         select count(*)::int from accounting_books b
          where b.org_id = ${orgId} and b.is_active and b.posts_gl
       )
     order by o.created_at`));
  const repaired: string[] = [];
  for (const row of missing.rows) {
    await buildAllRecognitionSchedulesOn(runner, row.id, orgId, actorId);
    repaired.push(row.id);
  }
  return repaired;
}
