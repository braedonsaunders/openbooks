import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { add, isZero, neg, sum, toUnits } from "./money.ts";
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

/**
 * Card charge / refund. A charge DRs its expense lines and CRs the card's
 * liability control account; a refund is the arithmetic reverse and rides the
 * same rule with negative line amounts (its detail is stored already signed).
 * The liability account is the doc's `controlAccountId` override (the per-card
 * employee sub-account NetSuite used) else the resolved card liability.
 */
const cardRule: RuleFn = (doc, lines, deps) => {
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
  const cardLiability = controlOverride(doc) ?? deps.cardLiabilityAccountId;
  if (!cardLiability) throw new PostingError("card_charge requires a payment card");
  return [
    ...expense,
    ...tax,
    {
      accountId: cardLiability,
      amount: neg(total),
      paymentCardId: doc.paymentCardId,
      ...dims(doc),
    },
  ];
};

const dims = (d: Doc, l?: DocLine) => ({
  departmentId: l?.departmentId ?? d.departmentId,
  projectId: l?.projectId ?? d.projectId,
  locationId: l?.locationId ?? d.locationId,
  classId: l?.classId ?? d.classId,
});

const lineTotal = (l: DocLine) => add(l.amount, l.taxAmount ?? "0");

/**
 * The payable/receivable/card-liability control account a document should post
 * to. NetSuite lets a transaction choose its own AP/AR/financing account on the
 * header (usually the org default, but sometimes a financing sub-account like
 * "Ford Credit" or a per-card employee liability). We surface that choice as
 * `doc.custom.controlAccountId`; when present it wins over the org default.
 */
const controlOverride = (doc: Doc): string | undefined => {
  const c = (doc.custom as Record<string, unknown> | null)?.controlAccountId;
  return typeof c === "string" && c ? c : undefined;
};

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

export const RULES: Record<string, RuleFn> = {
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
        accountId: controlOverride(doc) ?? deps.control.ap,
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
        accountId: controlOverride(doc) ?? deps.control.ar,
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
        accountId: controlOverride(doc) ?? deps.control.employeePayable ?? deps.control.ap,
        amount: neg(total),
        partyId: doc.partyId,
        isOpenItem: true,
        ...dims(doc),
      },
    ];
  },

  card_charge: cardRule,
  /** Card refund: the arithmetic reverse of a charge, same posting rule. */
  card_refund: cardRule,

  /** Manual journal: lines carry signed amounts + accounts directly. */
  journal: (doc, lines) =>
    lines.map((l) => ({
      accountId: l.accountId!,
      amount: l.amount,
      memo: l.description,
      partyId: doc.partyId,
      ...dims(doc, l),
    })),

  /**
   * Check: a direct bank disbursement. DR the line accounts (expense or the
   * AP/liability being paid), CR bank. Like vendor_payment but the debit side
   * is the document's own line accounts. Purchase-side tax (taxPaid).
   */
  check: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => ({
      accountId: l.accountId!,
      amount: l.amount, // debit line account
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
        accountId: deps.control.bank,
        amount: neg(total), // credit bank
        ...dims(doc),
      },
    ];
  },

  /** Transfer: DR one account, CR another, equal amounts (line 0 = to, line 1 = from). */
  transfer: (doc, lines, deps) => {
    const total = sum(lines.map((l) => l.amount));
    return [
      { accountId: lines[0]?.accountId ?? deps.control.bank, amount: total, ...dims(doc) }, // debit destination
      { accountId: lines[1]?.accountId ?? deps.control.bank, amount: neg(total), ...dims(doc) }, // credit source
    ];
  },

  /** Vendor credit memo: the reverse of vendor_bill. DR AP / CR expense + tax. */
  vendor_credit: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => ({
      accountId: l.accountId!,
      amount: neg(l.amount), // credit expense (reverse of bill)
      memo: l.description,
      partyId: doc.partyId,
      ...dims(doc, l),
    }));
    const tax = taxLines(doc, lines, deps.control.taxPaid ?? deps.control.ap, -1);
    const total = sum([...expense, ...tax].map((l) => l.amount));
    return [
      {
        accountId: controlOverride(doc) ?? deps.control.ap,
        amount: neg(total), // debit AP (total is negative)
        partyId: doc.partyId,
        dueDate: doc.dueDate,
        isOpenItem: true,
        ...dims(doc),
      },
      ...expense,
      ...tax,
    ];
  },

  /** Customer credit memo: the reverse of customer_invoice. DR income / CR AR + tax. */
  customer_credit: (doc, lines, deps) => {
    const income: KernelLine[] = lines.map((l) => ({
      accountId: l.accountId!,
      amount: l.amount, // debit income (reverse of invoice)
      memo: l.description,
      partyId: doc.partyId,
      ...dims(doc, l),
    }));
    const tax = taxLines(doc, lines, deps.control.taxCollected ?? deps.control.ar, 1);
    const total = sum([...income, ...tax].map((l) => l.amount));
    return [
      {
        accountId: controlOverride(doc) ?? deps.control.ar,
        amount: neg(total), // credit AR (total is positive)
        partyId: doc.partyId,
        dueDate: doc.dueDate,
        isOpenItem: true,
        ...dims(doc),
      },
      ...income,
      ...tax,
    ];
  },
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
  const periodRes = (await db.execute(sql`
    select id from accounting_periods
    where org_id = ${doc.orgId} and starts_on <= ${postingDate} and ends_on >= ${postingDate}
      and is_adjustment = false
    limit 1`)) as unknown as { rows: { id: string }[] };
  const period = periodRes.rows[0];
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

// ---------------------------------------------------------------------------
// GL Impact as a derived projection.
//
// For a document-sourced entry the DOCUMENT is the system of record; its
// journal entry is a derived projection — entry = postingRules(document) —
// re-materialized on every save (NetSuite's model). `postDocument` above is
// the first materialization; `regenerateGlImpactTx` re-materializes a posted
// document's entry in place after an edit. A non-GL edit (memo, reference #)
// produces an identical projection and is a no-op on the ledger; a GL edit
// produces a different projection and regenerates the entry's lines, blocked
// only if the posting period is closed.
// ---------------------------------------------------------------------------

/** Raised when a GL-affecting edit would land in a closed accounting period. */
export class ClosedPeriodError extends Error {}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Build + validate the GL-Impact projection (kernel lines) for a document. */
function buildProjection(doc: Doc, lines: DocLine[], deps: PostingDeps): KernelLine[] {
  const rule = RULES[doc.kind];
  if (!rule) throw new PostingError(`no posting rule for document kind "${doc.kind}"`);
  const kl = rule(doc, lines, deps).filter((l) => !isZero(l.amount));
  if (kl.length < 2) throw new PostingError("posting produced fewer than 2 lines");
  if (!isZero(sum(kl.map((l) => l.amount)))) {
    throw new PostingError(`posting rule for ${doc.kind} does not balance`);
  }
  return kl;
}

/** Stable comparison key for a set of GL lines (order-sensitive, amount-normalized). */
function glKey(
  lines: {
    accountId: string;
    amount: string;
    partyId?: string | null;
    departmentId?: string | null;
    projectId?: string | null;
    locationId?: string | null;
    classId?: string | null;
    taxCodeId?: string | null;
    paymentCardId?: string | null;
    dueDate?: string | null;
    isOpenItem?: boolean | null;
  }[],
): string {
  return JSON.stringify(
    lines.map((l) => [
      l.accountId,
      toUnits(l.amount).toString(),
      l.partyId ?? null,
      l.departmentId ?? null,
      l.projectId ?? null,
      l.locationId ?? null,
      l.classId ?? null,
      l.taxCodeId ?? null,
      l.paymentCardId ?? null,
      l.dueDate ?? null,
      !!l.isOpenItem,
    ]),
  );
}

/**
 * Re-materialize a POSTED document's GL-Impact projection in place, from its
 * (already-updated) source document + lines, inside the caller's transaction.
 * The caller MUST have run `set local openbooks.amend = on`.
 *
 * Returns `{ changed: false }` when the projection is unchanged (a non-GL edit)
 * — no ledger write happens, so it is allowed even in a closed period. When the
 * projection differs it regenerates the entry's lines in place (the entry keeps
 * its id and stays posted) and throws `ClosedPeriodError` if the old or new
 * period is closed.
 */
export async function regenerateGlImpactTx(
  tx: Tx,
  documentId: string,
  deps: PostingDeps,
  _userId: string,
): Promise<{ entryId: string | null; changed: boolean }> {
  const [doc] = await tx.select().from(schema.documents).where(eq(schema.documents.id, documentId));
  if (!doc) throw new PostingError(`document ${documentId} not found`);
  // Only posted documents have a materialized projection to regenerate.
  if (doc.status !== "posted" || !doc.postedEntryId) return { entryId: null, changed: false };

  if (doc.paymentCardId && !deps.cardLiabilityAccountId) {
    const [card] = await tx
      .select()
      .from(schema.paymentCards)
      .where(eq(schema.paymentCards.id, doc.paymentCardId));
    if (card) deps = { ...deps, cardLiabilityAccountId: card.liabilityAccountId };
  }

  const lines = await tx
    .select()
    .from(schema.documentLines)
    .where(eq(schema.documentLines.documentId, documentId))
    .orderBy(asc(schema.documentLines.lineNumber));

  const kernelLines = buildProjection(doc, lines, deps);
  const postingDate = doc.postingDate ?? doc.documentDate;

  const periodRes = (await tx.execute(sql`
    select id, gl_closed_at from accounting_periods
     where org_id = ${doc.orgId} and starts_on <= ${postingDate} and ends_on >= ${postingDate}
       and is_adjustment = false
     limit 1`)) as unknown as { rows: { id: string; gl_closed_at: string | null }[] };
  const period = periodRes.rows[0];
  if (!period) throw new PostingError(`no accounting period covers ${postingDate}`);

  const [entry] = await tx
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.id, doc.postedEntryId));
  const existing = await tx
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id))
    .orderBy(asc(schema.journalLines.lineNumber));

  // Unchanged projection (same lines, same period, same posting date + memo) →
  // this was a non-GL edit; the ledger is untouched (safe in a closed period).
  const unchanged =
    entry.periodId === period.id &&
    entry.postingDate === postingDate &&
    (entry.memo ?? null) === (doc.memo ?? null) &&
    glKey(kernelLines) === glKey(existing as unknown as Parameters<typeof glKey>[0]);
  if (unchanged) return { entryId: entry.id, changed: false };

  // GL projection changed → must land in an open period (old + new).
  if (period.gl_closed_at) throw new ClosedPeriodError(`the accounting period for ${postingDate} is closed`);
  const oldClosed = (await tx.execute(sql`
    select 1 from accounting_periods where id = ${entry.periodId} and gl_closed_at is not null`)) as unknown as {
    rows: unknown[];
  };
  if (oldClosed.rows.length > 0) {
    throw new ClosedPeriodError(`${doc.documentNumber} was posted into a period that is now closed`);
  }

  // Regenerate the entry's lines IN PLACE, preserving line identity so payment
  // applications and bank-reconciliation matches (which FK to journal_line ids)
  // stay linked. Overlapping lines are UPDATEd by position; extra new lines are
  // inserted; surplus old lines are deleted (a delete of a still-referenced line
  // FK-fails and rolls the whole edit back — you can't drop an applied line).
  const vals = (l: KernelLine, i: number) => ({
    orgId: doc.orgId,
    entryId: entry.id,
    lineNumber: i + 1,
    accountId: l.accountId,
    amount: l.amount,
    currency: doc.currency,
    txnAmount: l.amount,
    fxRate: doc.fxRate,
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
  });
  const overlap = Math.min(existing.length, kernelLines.length);
  for (let i = 0; i < overlap; i++) {
    const { orgId: _o, entryId: _e, ...set } = vals(kernelLines[i]!, i);
    await tx.update(schema.journalLines).set(set).where(eq(schema.journalLines.id, existing[i]!.id));
  }
  if (kernelLines.length > existing.length) {
    await tx
      .insert(schema.journalLines)
      .values(kernelLines.slice(existing.length).map((l, k) => vals(l, existing.length + k)));
  } else if (existing.length > kernelLines.length) {
    for (let i = kernelLines.length; i < existing.length; i++) {
      await tx.delete(schema.journalLines).where(eq(schema.journalLines.id, existing[i]!.id));
    }
  }
  await tx
    .update(schema.journalEntries)
    .set({ postingDate, periodId: period.id, memo: doc.memo })
    .where(eq(schema.journalEntries.id, entry.id));

  return { entryId: entry.id, changed: true };
}
