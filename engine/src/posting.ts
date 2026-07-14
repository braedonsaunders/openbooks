import { asc, eq } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { add, isZero, neg, sum } from "./money.ts";
import { runTriggerScripts, type ScriptContext } from "./scripting.ts";

/**
 * The posting engine: document → journal entry, through the kernel.
 * Rules are pure functions from (document, lines, resolver) to kernel lines;
 * the database triggers are the final authority on balance/immutability.
 * before_post user scripts run first (can mutate whitelisted fields or veto);
 * after_post scripts run once the entry exists.
 */

type Doc = typeof schema.documents.$inferSelect;
type DocLine = typeof schema.documentLines.$inferSelect;

export interface KernelLine {
  accountId: string;
  amount: string; // signed base currency: + debit / − credit
  partyId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  paymentCardId?: string | null;
  taxCodeId?: string | null;
  memo?: string | null;
  dueDate?: string | null;
  isOpenItem?: boolean;
}

export interface PostingDeps {
  /** org-level control accounts (from orgs.settings.controlAccounts). */
  control: {
    ar: string;
    ap: string;
    bank: string;
    taxCollected?: string;
    taxPaid?: string;
    employeePayable?: string;
  };
  /** Resolved by postDocument when the document has a payment card. */
  cardLiabilityAccountId?: string;
}

type RuleFn = (doc: Doc, lines: DocLine[], deps: PostingDeps) => KernelLine[];

const dims = (d: Doc, l?: DocLine) => ({
  departmentId: l?.departmentId ?? d.departmentId,
  projectId: l?.projectId ?? d.projectId,
  locationId: l?.locationId ?? d.locationId,
  classId: l?.classId ?? d.classId,
});

const lineTotal = (l: DocLine) => add(l.amount, l.taxAmount ?? "0");

/** Group line tax by tax code → one kernel line per code. */
function taxLines(doc: Doc, lines: DocLine[], accountId: string, sign: 1 | -1): KernelLine[] {
  const byCode = new Map<string, string>();
  for (const l of lines) {
    if (!l.taxCodeId || isZero(l.taxAmount ?? "0")) continue;
    byCode.set(l.taxCodeId, add(byCode.get(l.taxCodeId) ?? "0", l.taxAmount!));
  }
  return [...byCode.entries()].map(([taxCodeId, amt]) => ({
    accountId,
    amount: sign === 1 ? amt : neg(amt),
    taxCodeId,
    ...dims(doc),
  }));
}

const RULES: Record<string, RuleFn> = {
  vendor_bill: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => ({
      accountId: l.accountId!,
      amount: l.amount, // debit expense
      memo: l.description,
      partyId: doc.partyId,
      ...dims(doc, l),
    }));
    const tax = taxLines(doc, lines, deps.control.taxPaid ?? deps.control.ap, 1);
    const total = sum([...expense, ...tax].map((l) => l.amount));
    return [
      ...expense,
      ...tax,
      {
        accountId: deps.control.ap,
        amount: neg(total), // credit AP
        partyId: doc.partyId,
        dueDate: doc.dueDate,
        isOpenItem: true,
        ...dims(doc),
      },
    ];
  },

  customer_invoice: (doc, lines, deps) => {
    const income: KernelLine[] = lines.map((l) => ({
      accountId: l.accountId!,
      amount: neg(l.amount), // credit income
      memo: l.description,
      partyId: doc.partyId,
      ...dims(doc, l),
    }));
    const tax = taxLines(doc, lines, deps.control.taxCollected ?? deps.control.ar, -1);
    const total = sum([...income, ...tax].map((l) => l.amount));
    return [
      {
        accountId: deps.control.ar,
        amount: neg(total), // debit AR (total is negative)
        partyId: doc.partyId,
        dueDate: doc.dueDate,
        isOpenItem: true,
        ...dims(doc),
      },
      ...income,
      ...tax,
    ];
  },

  vendor_payment: (doc, lines, deps) => {
    const total = sum(lines.map(lineTotal));
    return [
      { accountId: deps.control.ap, amount: total, partyId: doc.partyId, ...dims(doc) }, // debit AP
      { accountId: lines[0]?.accountId ?? deps.control.bank, amount: neg(total), ...dims(doc) }, // credit bank
    ];
  },

  customer_payment: (doc, lines, deps) => {
    const total = sum(lines.map(lineTotal));
    return [
      { accountId: lines[0]?.accountId ?? deps.control.bank, amount: total, ...dims(doc) }, // debit bank
      { accountId: deps.control.ar, amount: neg(total), partyId: doc.partyId, ...dims(doc) }, // credit AR
    ];
  },

  expense_report: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => ({
      accountId: l.accountId!,
      amount: l.amount,
      memo: l.description,
      partyId: doc.partyId,
      ...dims(doc, l),
    }));
    const tax = taxLines(doc, lines, deps.control.taxPaid ?? deps.control.ap, 1);
    const total = sum([...expense, ...tax].map((l) => l.amount));
    return [
      ...expense,
      ...tax,
      {
        accountId: deps.control.employeePayable ?? deps.control.ap,
        amount: neg(total),
        partyId: doc.partyId,
        isOpenItem: true,
        ...dims(doc),
      },
    ];
  },

  card_charge: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => ({
      accountId: l.accountId!,
      amount: l.amount,
      memo: l.description,
      partyId: doc.partyId,
      paymentCardId: doc.paymentCardId,
      ...dims(doc, l),
    }));
    const tax = taxLines(doc, lines, deps.control.taxPaid ?? deps.control.ap, 1);
    const total = sum([...expense, ...tax].map((l) => l.amount));
    if (!deps.cardLiabilityAccountId) throw new PostingError("card_charge requires a payment card");
    // credit the card's liability control account; per-card detail = card dim
    return [
      ...expense,
      ...tax,
      {
        accountId: deps.cardLiabilityAccountId,
        amount: neg(total),
        paymentCardId: doc.paymentCardId,
        ...dims(doc),
      },
    ];
  },

  /** Manual journal: lines carry signed amounts + accounts directly. */
  journal: (doc, lines) =>
    lines.map((l) => ({
      accountId: l.accountId!,
      amount: l.amount,
      memo: l.description,
      partyId: doc.partyId,
      ...dims(doc, l),
    })),
};

export class PostingError extends Error {}

export async function postDocument(documentId: string, deps: PostingDeps): Promise<string> {
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
  if (!doc) throw new PostingError(`document ${documentId} not found`);
  if (doc.status === "posted") throw new PostingError(`document ${doc.documentNumber} already posted`);
  if (doc.status === "voided") throw new PostingError(`document ${doc.documentNumber} is voided`);

  const lines = await db
    .select()
    .from(schema.documentLines)
    .where(eq(schema.documentLines.documentId, documentId))
    .orderBy(asc(schema.documentLines.lineNumber));

  const rule = RULES[doc.kind];
  if (!rule) throw new PostingError(`no posting rule for document kind "${doc.kind}"`);

  if (doc.paymentCardId && !deps.cardLiabilityAccountId) {
    const [card] = await db
      .select()
      .from(schema.paymentCards)
      .where(eq(schema.paymentCards.id, doc.paymentCardId));
    if (card) deps = { ...deps, cardLiabilityAccountId: card.liabilityAccountId };
  }

  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, doc.orgId));
  const scriptCtx: ScriptContext = {
    trigger: "before_post",
    document: doc as unknown as Record<string, unknown>,
    lines: lines as unknown as Record<string, unknown>[],
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
  };

  // -- user scripts: before_post (veto / mutate) --------------------------
  const outcomes = await runTriggerScripts("before_post", scriptCtx, doc.id);
  const bad = outcomes.find((o) => o.status !== "ok");
  if (bad) {
    throw new PostingError(
      bad.status === "aborted"
        ? `posting vetoed by script "${bad.name}": ${bad.abortReason}`
        : `script "${bad.name}" ${bad.status}: ${bad.abortReason ?? ""}`,
    );
  }
  let effectiveDoc = doc;
  const mutations = Object.assign({}, ...outcomes.map((o) => o.set ?? {}));
  if (Object.keys(mutations).length > 0) {
    const [updated] = await db
      .update(schema.documents)
      .set(mutations)
      .where(eq(schema.documents.id, doc.id))
      .returning();
    effectiveDoc = updated;
  }

  // -- build + validate kernel lines --------------------------------------
  const kernelLines = rule(effectiveDoc, lines, deps).filter((l) => !isZero(l.amount));
  if (kernelLines.length < 2) throw new PostingError("posting produced fewer than 2 lines");
  const total = sum(kernelLines.map((l) => l.amount));
  if (!isZero(total)) {
    throw new PostingError(`posting rule for ${doc.kind} does not balance (sum=${total})`);
  }

  const postingDate = effectiveDoc.postingDate ?? effectiveDoc.documentDate;
  const [period] = await db.execute<{ id: string }>(
    // deliberate raw query: date-range lookup
    (await import("drizzle-orm")).sql`
      select id from accounting_periods
      where org_id = ${doc.orgId} and starts_on <= ${postingDate} and ends_on >= ${postingDate}
        and is_adjustment = false
      limit 1`,
  ).then((r: any) => r.rows);
  if (!period) throw new PostingError(`no accounting period covers ${postingDate}`);

  const [book] = await db
    .select()
    .from(schema.accountingBooks)
    .where(eq(schema.accountingBooks.isPrimary, true));

  // -- write entry + lines + flip document, atomically ---------------------
  const entryId = await db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({
        orgId: doc.orgId,
        bookId: book.id,
        entryNumber: `${effectiveDoc.documentNumber}`,
        postingDate,
        periodId: period.id,
        memo: effectiveDoc.memo,
        status: "draft",
        sourceDocumentId: doc.id,
        origin: "document",
      })
      .returning({ id: schema.journalEntries.id });

    await tx.insert(schema.journalLines).values(
      kernelLines.map((l, i) => ({
        orgId: doc.orgId,
        entryId: entry.id,
        lineNumber: i + 1,
        accountId: l.accountId,
        amount: l.amount,
        currency: effectiveDoc.currency,
        txnAmount: l.amount,
        fxRate: effectiveDoc.fxRate,
        partyId: l.partyId ?? null,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        locationId: l.locationId ?? null,
        classId: l.classId ?? null,
        paymentCardId: l.paymentCardId ?? null,
        taxCodeId: l.taxCodeId ?? null,
        memo: l.memo ?? null,
        dueDate: l.dueDate ?? null,
        isOpenItem: l.isOpenItem ?? false,
      })),
    );

    await tx
      .update(schema.journalEntries)
      .set({ status: "posted", postedAt: new Date() })
      .where(eq(schema.journalEntries.id, entry.id));

    await tx
      .update(schema.documents)
      .set({ status: "posted", postedEntryId: entry.id, postingDate })
      .where(eq(schema.documents.id, doc.id));

    return entry.id;
  });

  await runTriggerScripts("after_post", { ...scriptCtx, trigger: "after_post" }, doc.id);
  return entryId;
}
