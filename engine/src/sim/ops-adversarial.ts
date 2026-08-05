import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScriptJournal } from "../journal-writes.ts";
import { requestDocumentVoid } from "../document-void.ts";
import { reverseProjectGlEntry } from "../project-recognition.ts";
import {
  createPaymentDocument,
  postPaymentWithApplications,
  sameCurrencyAllocation,
  updateDraftPayment,
} from "../payments.ts";
import { add } from "../money.ts";
import { collectibleOpenItems, createAndPostDocument, releaseDraftIfUngated } from "./activities/documents.ts";
import type { SimOrg, SimPeriod } from "./world.ts";
import type { InvariantResult } from "./invariants/index.ts";

/**
 * Endurance-run adversarial probes — the hostile user, exercised continuously
 * over a decade of simulated time, not just at close boundaries. Every probe
 * ATTEMPTS something the kernel must refuse (or performs a legal operation and
 * asserts its exact ledger effect), and returns an InvariantResult: a probe
 * that "succeeds" where the kernel should have refused is a HALT, identical in
 * severity to a broken balance.
 */

const ok = (): InvariantResult => ({ pass: true, failures: [] });
const fail = (invariant: string, detail: string): InvariantResult => ({
  pass: false,
  failures: [{ invariant, detail }],
});

/**
 * Backdating a journal into a CLOSED period must be refused — years later,
 * not merely on the day the period closed.
 */
export async function closedPeriodJournalProbe(
  world: SimOrg,
  closedPeriod: SimPeriod,
): Promise<InvariantResult> {
  const ref = `ADV-CLOSED-${randomUUID().slice(0, 8)}`;
  let rejected = false;
  try {
    await createScriptJournal(
      world.orgId,
      world.actors.controller,
      {
        documentDate: closedPeriod.startsOn,
        memo: "adversarial: backdated journal into closed period",
        referenceNumber: ref,
        lines: [
          { accountId: world.accounts.office!, amount: "100.00" },
          { accountId: world.accounts.bank!, amount: "-100.00" },
        ],
      },
      { post: true },
    );
  } catch {
    rejected = true;
  }
  // Whatever the outcome, no residue may remain.
  await db.execute(sql`
    delete from document_lines where org_id = ${world.orgId}
      and document_id in (select id from documents where org_id = ${world.orgId} and reference_number = ${ref} and status = 'draft')`);
  await db.execute(sql`
    delete from documents where org_id = ${world.orgId} and reference_number = ${ref} and status = 'draft'`);
  return rejected
    ? ok()
    : fail("adversarial-closed-journal", `journal dated ${closedPeriod.startsOn} posted into CLOSED period ${closedPeriod.name}`);
}

/**
 * Editing a POSTED document's financials without the controlled amend path
 * must be refused by the kernel constraints, and the stored figures must be
 * byte-identical afterwards.
 */
export async function postedEditProbe(world: SimOrg): Promise<InvariantResult> {
  const r = (await db.execute(sql`
    select id, total::text as total from documents
     where org_id = ${world.orgId} and status = 'posted'
       and kind in ('customer_invoice', 'vendor_bill')
     order by created_at desc limit 1`)) as unknown as { rows: { id: string; total: string }[] };
  const doc = r.rows[0];
  if (!doc) return ok(); // nothing posted yet — probe is inert today

  let rejected = false;
  try {
    await db.execute(sql`
      update documents set total = total + 100 where id = ${doc.id} and org_id = ${world.orgId}`);
  } catch {
    rejected = true;
  }
  const after = (await db.execute(sql`
    select total::text as total from documents where id = ${doc.id} and org_id = ${world.orgId}`)) as unknown as {
    rows: { total: string }[];
  };
  const unchanged = after.rows[0]?.total === doc.total;
  if (!unchanged) {
    // The mutation landed — that is the defect being reported, but the probe
    // must not leave the org poisoned, or every later oracle pass re-fails on
    // probe residue instead of on the product. Restore under the governed
    // amend flag (the engine's own correction path).
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local openbooks.amend = on`);
      await tx.execute(sql`
        update documents set total = ${doc.total} where id = ${doc.id} and org_id = ${world.orgId}`);
    });
  }
  if (rejected && unchanged) return ok();
  return fail(
    "adversarial-posted-edit",
    `raw UPDATE of posted document ${doc.id} total was ${rejected ? "" : "NOT "}rejected; stored total ${unchanged ? "unchanged" : `CHANGED ${doc.total} → ${after.rows[0]?.total}`}`,
  );
}

/**
 * Applying more than an item's open balance must be refused by the payment
 * engine, and the failed attempt must leave no ledger trace.
 */
export async function overApplicationProbe(world: SimOrg, simDate: string): Promise<InvariantResult> {
  for (const customer of world.customers) {
    const items = (await collectibleOpenItems(world.orgId, customer.id, "ar")).filter(
      (i) => i.kind === "customer_invoice" && Number(i.open) > 1,
    );
    const item = items[0];
    if (!item) continue;

    const payment = await createPaymentDocument({
      orgId: world.orgId,
      kind: "customer_payment",
      createdBy: world.actors.arClerk,
      partyId: customer.id,
      bankAccountId: world.accounts.bank,
      documentDate: simDate,
      currency: world.currency,
      memo: "adversarial: over-application attempt",
    });
    let rejected = false;
    let detail = "";
    try {
      await updateDraftPayment(
        payment.id,
        { allocations: [sameCurrencyAllocation(item.lineId, add(item.open, "0.01"))], bankAccountId: world.accounts.bank },
        world.actors.arClerk,
      );
      await releaseDraftIfUngated(world, payment.id, world.actors.arClerk);
      await postPaymentWithApplications(payment.id, undefined, world.actors.arClerk);
      detail = `payment ${payment.id} over-applied ${add(item.open, "0.01")} against open ${item.open} and POSTED`;
    } catch {
      rejected = true;
    }
    // Remove the probe draft (it must not have posted).
    const posted = (await db.execute(sql`
      select posted_entry_id from documents where id = ${payment.id} and org_id = ${world.orgId}`)) as unknown as {
      rows: { posted_entry_id: string | null }[];
    };
    if (rejected && !posted.rows[0]?.posted_entry_id) {
      // Best-effort cleanup; an approval-flow row may pin the draft, which is
      // harmless — an unposted probe draft has no ledger effect.
      try {
        await db.execute(sql`delete from documents where id = ${payment.id} and org_id = ${world.orgId}`);
      } catch { /* pinned by flow evidence — leave the unposted draft */ }
      return ok();
    }
    return fail("adversarial-over-application", detail || `over-application was rejected but the payment still posted (${payment.id})`);
  }
  return ok(); // no open items today — inert
}

/**
 * Reversal symmetry: post a journal, reverse it, and assert the pair nets to
 * exactly zero on every account it touched.
 */
export async function reversalSymmetryProbe(world: SimOrg, simDate: string): Promise<InvariantResult> {
  const res = await createScriptJournal(
    world.orgId,
    world.actors.controller,
    {
      documentDate: simDate,
      memo: "adversarial: reversal symmetry probe",
      referenceNumber: `ADV-REV-${randomUUID().slice(0, 8)}`,
      lines: [
        { accountId: world.accounts.office!, amount: "123.45" },
        { accountId: world.accounts.bank!, amount: "-123.45" },
      ],
    },
    { post: true },
  );
  if (!res.entryId) return fail("adversarial-reversal", "probe journal did not post");
  const reversalId = await reverseProjectGlEntry(world.orgId, world.actors.controller, res.entryId, "reversal symmetry probe");
  if (!reversalId) return fail("adversarial-reversal", `entry ${res.entryId} could not be reversed`);
  const net = (await db.execute(sql`
    select count(*) as n from (
      select account_id from journal_lines
       where org_id = ${world.orgId} and entry_id in (${res.entryId}, ${reversalId})
       group by account_id having abs(sum(amount)) >= 0.005) x`)) as unknown as { rows: { n: string }[] };
  return Number(net.rows[0]?.n ?? "1") === 0
    ? ok()
    : fail("adversarial-reversal", `journal ${res.entryId} + reversal ${reversalId} do not net to zero per account`);
}

/**
 * Void/recreate: post a bill, void it through the CONTROLLED void action
 * (request → reversal entry), assert the original and its reversal net to
 * exactly zero on every account, then repost an identical bill. The books
 * must end up exactly as if only the second bill ever existed.
 */
export async function voidRecreateProbe(world: SimOrg, simDate: string): Promise<InvariantResult> {
  const vendor = world.vendors[0];
  if (!vendor || !world.accounts.office) return ok();

  const first = await createAndPostDocument(world, {
    kind: "vendor_bill",
    documentNumber: `ADV-VOID-${randomUUID().slice(0, 8)}`,
    partyId: vendor.id,
    documentDate: simDate,
    dueDate: simDate,
    createdBy: world.actors.apClerk,
    currency: world.currency,
    memo: "adversarial: void/recreate probe (first)",
    custom: { sim: { adversarial: "void_recreate" } },
    lines: [{ accountId: world.accounts.office, description: "void probe", amount: "222.22" }],
  });
  const voided = await requestDocumentVoid({
    documentId: first.documentId,
    orgId: world.orgId,
    actorId: world.actors.controller,
    reason: "adversarial void/recreate probe",
    reversalDate: simDate,
  });
  if (voided.status !== "voided" || !voided.reversalEntryId) {
    return fail(
      "adversarial-void",
      `controlled void did not complete (status=${voided.status}, reversal=${voided.reversalEntryId ?? "none"})`,
    );
  }

  const residue = (await db.execute(sql`
    select
      (select count(*) from (
        select account_id from journal_lines
         where org_id = ${world.orgId} and entry_id in (${first.entryId}, ${voided.reversalEntryId})
         group by account_id having abs(sum(amount)) >= 0.005) x) as unbalanced,
      (select status from documents where org_id = ${world.orgId} and id = ${first.documentId}) as status`)) as unknown as {
    rows: { unbalanced: string; status: string }[];
  };
  if (Number(residue.rows[0]?.unbalanced) !== 0 || residue.rows[0]?.status !== "voided") {
    return fail(
      "adversarial-void",
      `void of ${first.documentId} did not reverse cleanly (unbalanced accounts=${residue.rows[0]?.unbalanced}, status=${residue.rows[0]?.status})`,
    );
  }

  await createAndPostDocument(world, {
    kind: "vendor_bill",
    documentNumber: `ADV-VOID-${randomUUID().slice(0, 8)}`,
    partyId: vendor.id,
    documentDate: simDate,
    dueDate: simDate,
    createdBy: world.actors.apClerk,
    currency: world.currency,
    memo: "adversarial: void/recreate probe (recreated)",
    custom: { sim: { adversarial: "void_recreate" } },
    lines: [{ accountId: world.accounts.office, description: "void probe recreated", amount: "222.22" }],
  });
  return ok();
}
