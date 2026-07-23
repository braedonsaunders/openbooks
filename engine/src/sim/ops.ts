import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  createPaymentDocument,
  postPaymentWithApplications,
  sameCurrencyAllocation,
  type AllocationInput,
} from "../payments.ts";
import { createScriptJournal, type ScriptJournalLine } from "../journal-writes.ts";
import { setPeriodLockState, CLOSE_MODULES } from "../close.ts";
import { postDraftDocument, collectibleOpenItems } from "./activities/documents.ts";
import type { SimOrg } from "./world.ts";

/**
 * The environment's action surface — the capabilities a persona (an LLM
 * subagent) can invoke through the CLI. Every action routes through the real
 * engine (posting kernel, payment-application engine, close/period-lock engine);
 * none writes ledger rows directly. Judgment (which, how much, when) belongs to
 * the caller; correctness belongs to the engine.
 */

// --- AP -------------------------------------------------------------------

/** Approve & post a draft vendor bill (AP clerk accepting an arrived invoice). */
export async function postBill(world: SimOrg, documentId: string): Promise<{ entryId: string }> {
  const entryId = await postDraftDocument(world, documentId);
  return { entryId };
}

/** Hold/dispute a draft bill: flag it, don't post it (stays in the inbox). */
export async function disputeBill(world: SimOrg, documentId: string, reason: string): Promise<void> {
  await db.execute(sql`
    update documents
       set custom = jsonb_set(coalesce(custom, '{}'::jsonb), '{sim,dispute}', to_jsonb(${reason}::text), true)
     where id = ${documentId} and org_id = ${world.orgId} and status = 'draft'`);
}

/**
 * Pay a set of open AP items (by their open-item journal line ids), full open
 * amount each, from one vendor, in a single payment document.
 */
export async function payVendor(
  world: SimOrg,
  vendorId: string,
  lineIds: string[],
  actorId: string,
  documentDate: string,
): Promise<{ paymentId: string; paid: string } | null> {
  const items = await collectibleOpenItems(world.orgId, vendorId, "ap");
  const wanted = new Set(lineIds);
  const chosen = items.filter((i) => wanted.has(i.lineId) && i.kind === "vendor_bill");
  if (chosen.length === 0) return null;

  const allocations: AllocationInput[] = chosen.map((i) => sameCurrencyAllocation(i.lineId, i.open));
  const payment = await createPaymentDocument({
    orgId: world.orgId,
    kind: "vendor_payment",
    createdBy: actorId,
    partyId: vendorId,
    documentDate,
    currency: world.currency,
    memo: `AP payment ${documentDate}`,
  });
  await postPaymentWithApplications(payment.id, allocations, actorId);
  const paid = chosen.reduce((acc, i) => acc + Number(i.open), 0).toFixed(2);
  return { paymentId: payment.id, paid };
}

// --- AR -------------------------------------------------------------------

/** Issue (post) a draft customer invoice. */
export async function issueInvoice(world: SimOrg, documentId: string): Promise<{ entryId: string }> {
  const entryId = await postDraftDocument(world, documentId);
  return { entryId };
}

/**
 * Cash application: apply an incoming (draft) customer payment to specific
 * invoice open-item lines with explicit amounts. This is the AR specialist's
 * judgment work — matching money to invoices.
 */
export async function applyReceipt(
  world: SimOrg,
  paymentDocId: string,
  allocations: { lineId: string; amount: string }[],
  actorId: string,
): Promise<{ entryId: string }> {
  const built: AllocationInput[] = allocations.map((a) => sameCurrencyAllocation(a.lineId, a.amount));
  const { entryId } = await postPaymentWithApplications(paymentDocId, built, actorId);
  return { entryId };
}

// --- Controller / GL ------------------------------------------------------

/** Post a balanced adjusting journal (accruals, reclasses, corrections). */
export async function postAdjustingJournal(
  world: SimOrg,
  actorId: string,
  lines: ScriptJournalLine[],
  memo: string,
  documentDate: string,
): Promise<{ id: string; entryId?: string }> {
  const res = await createScriptJournal(world.orgId, actorId, { documentDate, memo, lines }, { post: true });
  return { id: res.id, entryId: res.entryId };
}

/**
 * Close a month: soft-then-hard lock the subledgers and then the GL, in the
 * order the close engine requires (all non-GL modules closed before GL).
 */
export async function closeMonth(
  world: SimOrg,
  periodId: string,
  actorId: string,
  reason = "month-end close",
): Promise<{ modules: string[] }> {
  // All non-GL subledgers first, then GL (the order the close engine requires).
  const ordered: (typeof CLOSE_MODULES)[number][] = [
    ...CLOSE_MODULES.filter((m) => m !== "gl"),
    "gl",
  ];
  for (const module of ordered) {
    await setPeriodLockState({
      orgId: world.orgId,
      periodId,
      bookId: world.bookId,
      module,
      state: "closed",
      actorId,
      reason,
    });
  }
  return { modules: ordered };
}
