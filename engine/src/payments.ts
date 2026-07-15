import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, env, schema } from "./db.ts";
import { cmp, isZero, sum, toUnits } from "./money.ts";
import { postDocument, type PostingDeps } from "./posting.ts";
import { runTriggerScripts, type ScriptContext } from "./scripting.ts";

/**
 * Payments: vendor payments and customer receipts with open-item application,
 * payment runs, and CPA Standard 005 EFT file generation.
 *
 * A payment is an ordinary document (kind vendor_payment / customer_payment)
 * posted through the kernel: DR AP / CR bank (vendor) or DR bank / CR AR
 * (customer). What it settles is recorded in `applications` rows linking the
 * payment entry's AP/AR line (from) to each open-item journal line (to); the
 * deferred `app_check_open` trigger is the final authority on caps.
 *
 * Draft payments carry their working state on documents.custom:
 *   { bankAccountId: uuid, allocations: [{ openLineId, amount }] }
 * plus a single document line (the bank account, amount = payment total) so
 * the existing posting rules pick up the right bank account.
 */

export class PaymentError extends Error {}

export type PaymentKind = "vendor_payment" | "customer_payment";
export type OpenItemSide = "ap" | "ar";

export const PAYMENT_KIND_SIDE: Record<PaymentKind, OpenItemSide> = {
  vendor_payment: "ap",
  customer_payment: "ar",
};

const NUMBER_PREFIX: Record<PaymentKind, string> = {
  vendor_payment: "PAY-",
  customer_payment: "RCPT-",
};

export interface AllocationInput {
  openLineId: string;
  amount: string;
}

function isPaymentKind(kind: string): kind is PaymentKind {
  return kind === "vendor_payment" || kind === "customer_payment";
}

async function nextNumber(orgId: string, kind: string, prefix: string): Promise<string> {
  const seq = (await db.execute(sql`
    insert into number_sequences (org_id, document_kind, prefix)
    values (${orgId}, ${kind}, ${prefix})
    on conflict (org_id, document_kind)
    do update set next_number = number_sequences.next_number + 1
    returning prefix, next_number, padding
  `)) as unknown as { rows: { prefix: string; next_number: number; padding: number }[] };
  const s = seq.rows[0]!;
  return `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;
}

// ---------------------------------------------------------------------------
// Control accounts
// ---------------------------------------------------------------------------

export async function paymentControlDeps(orgId: string): Promise<PostingDeps> {
  const r = (await db.execute(
    sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`,
  )) as unknown as { rows: { c: Record<string, string> | null }[] };
  const c = r.rows[0]?.c ?? {};
  if (!c.ap || !c.ar || !c.bank) {
    throw new PaymentError(
      "org control accounts are not configured (orgs.settings.controlAccounts.ap/ar/bank)",
    );
  }
  return {
    control: {
      ap: c.ap,
      ar: c.ar,
      bank: c.bank,
      taxCollected: c.taxCollected,
      taxPaid: c.taxPaid,
      employeePayable: c.employeePayable,
    },
  };
}

// ---------------------------------------------------------------------------
// Draft payment documents
// ---------------------------------------------------------------------------

export async function createPaymentDocument(opts: {
  orgId: string;
  kind: PaymentKind;
  createdBy: string;
  partyId?: string | null;
  bankAccountId?: string | null;
  documentDate?: string;
  memo?: string | null;
}): Promise<{ id: string; documentNumber: string }> {
  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, opts.orgId));
  if (!org) throw new PaymentError("org not found");
  const documentNumber = await nextNumber(opts.orgId, opts.kind, NUMBER_PREFIX[opts.kind]);
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId: opts.orgId,
      kind: opts.kind,
      documentNumber,
      partyId: opts.partyId ?? null,
      documentDate: opts.documentDate ?? new Date().toISOString().slice(0, 10),
      currency: org.baseCurrency,
      memo: opts.memo ?? null,
      subtotal: "0",
      taxTotal: "0",
      total: "0",
      custom: opts.bankAccountId ? { bankAccountId: opts.bankAccountId, allocations: [] } : { allocations: [] },
      createdBy: opts.createdBy,
    })
    .returning({ id: schema.documents.id, documentNumber: schema.documents.documentNumber });
  return doc;
}

/** Validate allocation shape: positive exact money amounts, distinct lines. */
function validateAllocationInputs(allocations: AllocationInput[]): void {
  const seen = new Set<string>();
  for (const a of allocations) {
    if (!a.openLineId) throw new PaymentError("allocation is missing its open item line");
    if (seen.has(a.openLineId)) throw new PaymentError("the same open item is allocated twice");
    seen.add(a.openLineId);
    let units: bigint;
    try {
      units = toUnits(a.amount);
    } catch {
      throw new PaymentError(`allocation amount "${a.amount}" is not a valid amount`);
    }
    if (units <= 0n) throw new PaymentError("allocation amounts must be greater than zero");
  }
}

/**
 * Autosave surface for draft payments. Replaces header fields, the stored
 * allocations, and the single bank-account document line; the payment total
 * is always the sum of the allocations.
 */
export async function updateDraftPayment(
  id: string,
  patch: {
    partyId?: string | null;
    bankAccountId?: string | null;
    documentDate?: string;
    referenceNumber?: string | null;
    memo?: string | null;
    allocations?: AllocationInput[];
  },
  userId: string,
): Promise<void> {
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, id));
  if (!doc || !isPaymentKind(doc.kind)) throw new PaymentError("payment document not found");
  if (doc.status !== "draft") throw new PaymentError("only draft payments can be edited");

  const custom = (doc.custom ?? {}) as { bankAccountId?: string; allocations?: AllocationInput[] };
  const partyId = patch.partyId !== undefined ? patch.partyId : doc.partyId;
  const bankAccountId =
    patch.bankAccountId !== undefined ? patch.bankAccountId : (custom.bankAccountId ?? null);
  const allocations = patch.allocations ?? custom.allocations ?? [];

  validateAllocationInputs(allocations);

  if (bankAccountId) {
    const bank = (await db.execute(sql`
      select id from accounts
       where id = ${bankAccountId} and org_id = ${doc.orgId}
         and type = 'asset_bank' and is_active and not is_summary
    `)) as unknown as { rows: { id: string }[] };
    if (!bank.rows[0]) throw new PaymentError("bank account must be an active bank-type account");
  }
  if (partyId && partyId !== doc.partyId) {
    const party = (await db.execute(
      sql`select id from parties where id = ${partyId} and org_id = ${doc.orgId} and is_active`,
    )) as unknown as { rows: { id: string }[] };
    if (!party.rows[0]) throw new PaymentError("party not found");
  }

  // Allocations must target real open items of this party, within open balance.
  if (allocations.length > 0) {
    if (!partyId) throw new PaymentError("select a party before applying open items");
    const openItems = await openItemsForParty(partyId, PAYMENT_KIND_SIDE[doc.kind]);
    const byLine = new Map(openItems.map((i) => [i.lineId, i]));
    for (const a of allocations) {
      const item = byLine.get(a.openLineId);
      if (!item) throw new PaymentError("an allocated item is not an open item for this party");
      if (cmp(a.amount, item.open) > 0) {
        throw new PaymentError(
          `applying ${a.amount} exceeds the open balance ${item.open} on ${item.documentNumber ?? item.entryNumber}`,
        );
      }
    }
  }

  const total = sum(allocations.map((a) => a.amount));

  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from document_lines where document_id = ${id}`);
    if (bankAccountId && !isZero(total)) {
      await tx.insert(schema.documentLines).values({
        orgId: doc.orgId,
        documentId: id,
        lineNumber: 1,
        accountId: bankAccountId,
        quantity: "1",
        unitPrice: total,
        amount: total,
        taxAmount: "0",
      });
    }
    await tx.execute(sql`
      update documents set
        party_id = ${partyId ?? null},
        document_date = coalesce(${patch.documentDate ?? null}, document_date),
        reference_number = ${patch.referenceNumber !== undefined ? patch.referenceNumber : sql`reference_number`},
        memo = ${patch.memo !== undefined ? patch.memo : sql`memo`},
        custom = ${JSON.stringify({ ...custom, bankAccountId, allocations })}::jsonb,
        subtotal = ${total}, tax_total = '0', total = ${total},
        updated_at = now(), updated_by = ${userId}
      where id = ${id}
    `);
  });
}

// ---------------------------------------------------------------------------
// Open items
// ---------------------------------------------------------------------------

export interface OpenItem {
  lineId: string;
  entryId: string;
  entryNumber: string;
  postingDate: string;
  dueDate: string | null;
  documentId: string | null;
  documentNumber: string | null;
  documentKind: string | null;
  referenceNumber: string | null;
  memo: string | null;
  /** Absolute original amount of the open-item line. */
  amount: string;
  /** Sum of live applications against this line. */
  applied: string;
  /** amount − applied. Only items with open > 0 are returned. */
  open: string;
}

/**
 * Open AP (credit) or AR (debit) journal lines for a party: is_open_item
 * lines on posted entries, with applied-to-date sums and remaining balance.
 */
export async function openItemsForParty(partyId: string, side: OpenItemSide): Promise<OpenItem[]> {
  const signFilter = side === "ap" ? sql`jl.amount < 0` : sql`jl.amount > 0`;
  const r = (await db.execute(sql`
    select jl.id as line_id, abs(jl.amount) as amount, jl.due_date, jl.memo,
           je.id as entry_id, je.entry_number, je.posting_date,
           d.id as document_id, d.document_number, d.kind as document_kind, d.reference_number,
           coalesce(ap.applied, 0) as applied
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
      left join documents d on d.id = je.source_document_id
      left join lateral (
        select sum(a.amount) as applied
          from applications a
         where a.to_line_id = jl.id and a.unapplied_at is null
      ) ap on true
     where jl.party_id = ${partyId} and jl.is_open_item and ${signFilter}
     order by jl.due_date nulls last, je.posting_date, je.entry_number
  `)) as unknown as {
    rows: {
      line_id: string;
      amount: string;
      due_date: string | null;
      memo: string | null;
      entry_id: string;
      entry_number: string;
      posting_date: string;
      document_id: string | null;
      document_number: string | null;
      document_kind: string | null;
      reference_number: string | null;
      applied: string;
    }[];
  };
  return r.rows
    .map((row) => ({
      lineId: row.line_id,
      entryId: row.entry_id,
      entryNumber: row.entry_number,
      postingDate: row.posting_date,
      dueDate: row.due_date,
      documentId: row.document_id,
      documentNumber: row.document_number,
      documentKind: row.document_kind,
      referenceNumber: row.reference_number,
      memo: row.memo,
      amount: row.amount,
      applied: row.applied,
      open: sum([row.amount, negStr(String(row.applied))]),
    }))
    .filter((i) => cmp(i.open, "0") > 0);
}

function negStr(a: string): string {
  return toUnits(a) === 0n ? "0" : a.startsWith("-") ? a.slice(1) : `-${a}`;
}

/**
 * Full drawer payload for a payment document: header, stored draft
 * allocations, and (once posted) the live applications with their targets.
 */
export async function loadPaymentDocument(id: string, kind: PaymentKind) {
  const doc = (await db.execute(sql`
    select d.*, p.display_name as party_name, e.id as entry_id, e.entry_number,
           ba.id as bank_account_id_line, ba.number as bank_account_number, ba.name as bank_account_name
      from documents d
      left join parties p on p.id = d.party_id
      left join journal_entries e on e.id = d.posted_entry_id
      left join document_lines dl on dl.document_id = d.id and dl.line_number = 1
      left join accounts ba on ba.id = coalesce((d.custom->>'bankAccountId')::uuid, dl.account_id)
     where d.id = ${id} and d.kind = ${kind}
  `)) as unknown as { rows: Record<string, unknown>[] };
  const row = doc.rows[0];
  if (!row) return null;

  const custom = (row.custom ?? {}) as { bankAccountId?: string; allocations?: AllocationInput[] };
  const applied =
    row.status === "posted" && row.posted_entry_id
      ? ((await db.execute(sql`
          select a.id, a.amount, a.applied_on,
                 te.entry_number as target_entry_number, te.posting_date as target_posting_date,
                 tl.due_date as target_due_date, abs(tl.amount) as target_amount,
                 td.id as target_document_id, td.document_number as target_document_number,
                 td.kind as target_document_kind, td.reference_number as target_reference_number
            from journal_lines jl
            join applications a on a.from_line_id = jl.id and a.unapplied_at is null
            join journal_lines tl on tl.id = a.to_line_id
            join journal_entries te on te.id = tl.entry_id
            left join documents td on td.id = te.source_document_id
           where jl.entry_id = ${row.posted_entry_id}
           order by te.posting_date, te.entry_number
        `)) as unknown as { rows: Record<string, unknown>[] }).rows
      : [];

  return {
    doc: row,
    bankAccountId: custom.bankAccountId ?? null,
    allocations: custom.allocations ?? [],
    applied,
  };
}

// ---------------------------------------------------------------------------
// Post + apply
// ---------------------------------------------------------------------------

/**
 * Post the payment document through the kernel, then link its AP/AR line to
 * each selected open item via `applications` (+ document_links 'pays').
 *
 * postDocument commits its own transaction, so applications cannot share it.
 * The allocations are fully validated first; if the applications insert still
 * fails (e.g. a concurrent application won the race at the deferred trigger),
 * the posted entry is automatically reversed and the document voided so no
 * half-applied payment survives.
 */
export async function postPaymentWithApplications(
  paymentDocId: string,
  allocations?: AllocationInput[],
  userId?: string,
): Promise<{ entryId: string }> {
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, paymentDocId));
  if (!doc || !isPaymentKind(doc.kind)) throw new PaymentError("payment document not found");
  if (doc.status === "posted") throw new PaymentError(`${doc.documentNumber} is already posted`);
  if (doc.status === "voided") throw new PaymentError(`${doc.documentNumber} is voided`);
  if (!doc.partyId) throw new PaymentError("select a party before posting");

  const custom = (doc.custom ?? {}) as { bankAccountId?: string; allocations?: AllocationInput[] };
  const allocs = allocations ?? custom.allocations ?? [];
  if (allocs.length === 0) throw new PaymentError("select at least one open item to apply");
  validateAllocationInputs(allocs);

  const side = PAYMENT_KIND_SIDE[doc.kind];
  const openItems = await openItemsForParty(doc.partyId, side);
  const byLine = new Map(openItems.map((i) => [i.lineId, i]));
  for (const a of allocs) {
    const item = byLine.get(a.openLineId);
    if (!item) throw new PaymentError("an allocated item is no longer an open item for this party");
    if (cmp(a.amount, item.open) > 0) {
      throw new PaymentError(
        `applying ${a.amount} exceeds the open balance ${item.open} on ${item.documentNumber ?? item.entryNumber}`,
      );
    }
  }
  const totalAlloc = sum(allocs.map((a) => a.amount));
  if (cmp(totalAlloc, doc.total) !== 0) {
    throw new PaymentError(
      `payment total ${doc.total} does not equal the applied total ${totalAlloc} — save the draft again`,
    );
  }

  const deps = await paymentControlDeps(doc.orgId);
  const controlAccountId = side === "ap" ? deps.control.ap : deps.control.ar;

  const entryId = await postDocument(doc.id, deps);

  const fromLine = (await db.execute(sql`
    select jl.id, je.posting_date
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
     where jl.entry_id = ${entryId} and jl.account_id = ${controlAccountId}
     limit 1
  `)) as unknown as { rows: { id: string; posting_date: string }[] };

  try {
    const from = fromLine.rows[0];
    if (!from) {
      throw new PaymentError("posted payment entry has no AP/AR control line");
    }
    await db.transaction(async (tx) => {
      await tx.insert(schema.applications).values(
        allocs.map((a) => ({
          orgId: doc.orgId,
          fromLineId: from.id,
          toLineId: a.openLineId,
          amount: a.amount,
          appliedOn: from.posting_date,
          createdBy: userId ?? doc.createdBy,
        })),
      );
      const lineIds = allocs.map((a) => a.openLineId);
      const targets = (await tx.execute(sql`
        select distinct je.source_document_id as doc_id
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id
         where jl.id in ${lineIds} and je.source_document_id is not null
      `)) as unknown as { rows: { doc_id: string }[] };
      if (targets.rows.length > 0) {
        await tx.insert(schema.documentLinks).values(
          targets.rows.map((t) => ({
            orgId: doc.orgId,
            fromDocumentId: doc.id,
            toDocumentId: t.doc_id,
            linkType: "pays" as const,
            createdBy: userId ?? doc.createdBy,
          })),
        );
      }
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await reversePostedEntry(entryId, doc.id, doc.orgId, `auto-reversal: applying ${doc.documentNumber} failed`);
    throw new PaymentError(
      `${doc.documentNumber} was posted but applying it failed (${reason}); the posting was automatically reversed — review the open items and retry`,
    );
  }

  return { entryId };
}

/** Compensation: reverse a just-posted entry and void its document. */
async function reversePostedEntry(
  entryId: string,
  documentId: string,
  orgId: string,
  memo: string,
): Promise<void> {
  const [entry] = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.id, entryId));
  if (!entry) return;
  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entryId));

  // -- user scripts: before_void (veto) -----------------------------------
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, orgId));
  if (doc && org) {
    const docLines = await db
      .select()
      .from(schema.documentLines)
      .where(eq(schema.documentLines.documentId, documentId));
    const scriptCtx: ScriptContext = {
      trigger: "before_void",
      document: doc as unknown as Record<string, unknown>,
      lines: docLines as unknown as Record<string, unknown>[],
      org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
    };
    const outcomes = await runTriggerScripts("before_void", scriptCtx, documentId);
    const bad = outcomes.find((o) => o.status !== "ok");
    if (bad) {
      throw new PaymentError(
        bad.status === "aborted"
          ? `voiding vetoed by script "${bad.name}": ${bad.abortReason}`
          : `script "${bad.name}" ${bad.status}: ${bad.abortReason ?? ""}`,
      );
    }
  }

  await db.transaction(async (tx) => {
    const [rev] = await tx
      .insert(schema.journalEntries)
      .values({
        orgId,
        bookId: entry.bookId,
        entryNumber: `${entry.entryNumber}-R`,
        postingDate: entry.postingDate,
        periodId: entry.periodId,
        memo,
        status: "draft",
        sourceDocumentId: entry.sourceDocumentId,
        origin: "document",
        reversesEntryId: entryId,
      })
      .returning({ id: schema.journalEntries.id });
    await tx.insert(schema.journalLines).values(
      lines.map((l) => ({
        orgId,
        entryId: rev.id,
        lineNumber: l.lineNumber,
        accountId: l.accountId,
        amount: negStr(l.amount),
        currency: l.currency,
        txnAmount: negStr(l.txnAmount),
        fxRate: l.fxRate,
        partyId: l.partyId,
        departmentId: l.departmentId,
        projectId: l.projectId,
        locationId: l.locationId,
        classId: l.classId,
        paymentCardId: l.paymentCardId,
        taxCodeId: l.taxCodeId,
        memo: l.memo,
        dueDate: null,
        isOpenItem: false,
      })),
    );
    await tx
      .update(schema.journalEntries)
      .set({ status: "posted", postedAt: new Date() })
      .where(eq(schema.journalEntries.id, rev.id));
    await tx
      .update(schema.journalEntries)
      .set({ status: "reversed" })
      .where(eq(schema.journalEntries.id, entryId));
    await tx.execute(sql`
      update documents set status = 'voided', voided_at = now() where id = ${documentId}
    `);
  });
}

// ---------------------------------------------------------------------------
// EFT settings (orgs.settings.eft)
// ---------------------------------------------------------------------------

export interface EftSettings {
  /** 10-character originator ID assigned by the financial institution. */
  originatorId: string;
  /** Up to 15 characters; appears on payee statements. */
  originatorShortName: string;
  /** Up to 30 characters; appears on payee statements. */
  originatorLongName: string;
  /** 5-digit destination data centre code of the processing institution. */
  dataCentre: string;
  /** Payer (settlement) bank: 3-digit institution, 5-digit transit, account. */
  institution: string;
  transit: string;
  account: string;
  /** Optional CPA transaction code override; default 460 (accounts payable). */
  transactionCode?: string;
}

const EFT_REQUIRED: (keyof EftSettings)[] = [
  "originatorId",
  "originatorShortName",
  "originatorLongName",
  "dataCentre",
  "institution",
  "transit",
  "account",
];

export type EftSettingsResult =
  | { ok: true; settings: EftSettings }
  | { ok: false; missing: string[] };

/** Read and validate the org's EFT origination settings. Never fakes success. */
export async function loadEftSettings(orgId: string): Promise<EftSettingsResult> {
  const r = (await db.execute(
    sql`select settings->'eft' as eft from orgs where id = ${orgId}`,
  )) as unknown as { rows: { eft: Partial<EftSettings> | null }[] };
  const eft = r.rows[0]?.eft ?? {};
  const missing = EFT_REQUIRED.filter((k) => {
    const v = eft[k];
    return typeof v !== "string" || v.trim() === "" || v.includes("FILL-ME");
  });
  if (missing.length > 0) return { ok: false, missing };
  const s = eft as EftSettings;
  if (!/^\d{5}$/.test(s.dataCentre)) return { ok: false, missing: ["dataCentre (must be 5 digits)"] };
  if (!/^\d{3}$/.test(s.institution)) return { ok: false, missing: ["institution (must be 3 digits)"] };
  if (!/^\d{5}$/.test(s.transit)) return { ok: false, missing: ["transit (must be 5 digits)"] };
  if (!/^\d{1,12}$/.test(s.account)) return { ok: false, missing: ["account (1–12 digits)"] };
  if (s.originatorId.length > 10) return { ok: false, missing: ["originatorId (max 10 characters)"] };
  return { ok: true, settings: s };
}

// ---------------------------------------------------------------------------
// Payee bank account number encryption (app-layer, AES-256-GCM)
// ---------------------------------------------------------------------------

const ENC_PREFIX = "enc:v1:";

function dataKey(): Buffer {
  const raw = env.OPENBOOKS_DATA_KEY;
  if (!raw) {
    throw new PaymentError(
      "OPENBOOKS_DATA_KEY is not set in .env — required to encrypt/decrypt payee bank account numbers (32-byte key, hex or base64)",
    );
  }
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new PaymentError("OPENBOOKS_DATA_KEY must decode to exactly 32 bytes (hex or base64)");
  }
  return buf;
}

/** Encrypt a payee bank account number for party_bank_accounts.account_number_encrypted. */
export function encryptAccountNumber(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${ENC_PREFIX}${iv.toString("base64")}:${ct.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
}

export function decryptAccountNumber(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) {
    throw new PaymentError(
      "stored bank account number is not in the expected enc:v1 format — re-save the payee's bank details",
    );
  }
  const [ivB64, ctB64, tagB64] = stored.slice(ENC_PREFIX.length).split(":");
  if (!ivB64 || !ctB64 || !tagB64) throw new PaymentError("stored bank account number is malformed");
  const decipher = createDecipheriv("aes-256-gcm", dataKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Payment runs
// ---------------------------------------------------------------------------

/**
 * Create an EFT payment run from selected posted vendor bills: one draft
 * vendor_payment per vendor (allocating each bill's current open balance) and
 * one payment_instruction per vendor. Nothing posts until the explicit
 * post step; the CPA-005 file is generated from the instructions.
 */
export async function createPaymentRun(opts: {
  orgId: string;
  createdBy: string;
  bankAccountId: string;
  billDocumentIds: string[];
  scheduledFor?: string | null;
}): Promise<{ id: string; runNumber: string }> {
  if (opts.billDocumentIds.length === 0) throw new PaymentError("select at least one bill to pay");

  const bank = (await db.execute(sql`
    select id from accounts
     where id = ${opts.bankAccountId} and org_id = ${opts.orgId}
       and type = 'asset_bank' and is_active and not is_summary
  `)) as unknown as { rows: { id: string }[] };
  if (!bank.rows[0]) throw new PaymentError("bank account must be an active bank-type account");

  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, opts.orgId));
  if (!org) throw new PaymentError("org not found");

  // Selected bills → their open AP lines with current open balances.
  const bills = (await db.execute(sql`
    select d.id as document_id, d.document_number, d.party_id, p.display_name as vendor,
           jl.id as open_line_id, abs(jl.amount) - coalesce(ap.applied, 0) as open
      from documents d
      join parties p on p.id = d.party_id
      join journal_entries je on je.id = d.posted_entry_id and je.status = 'posted'
      join journal_lines jl on jl.entry_id = je.id and jl.is_open_item and jl.amount < 0
      left join lateral (
        select sum(a.amount) as applied from applications a
         where a.to_line_id = jl.id and a.unapplied_at is null
      ) ap on true
     where d.id in ${opts.billDocumentIds}
       and d.org_id = ${opts.orgId} and d.kind = 'vendor_bill' and d.status = 'posted'
  `)) as unknown as {
    rows: { document_id: string; document_number: string; party_id: string; vendor: string; open_line_id: string; open: string }[];
  };

  const found = new Set(bills.rows.map((b) => b.document_id));
  const missing = opts.billDocumentIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new PaymentError("some selected bills are not posted vendor bills with an open balance");
  }
  const payable = bills.rows.filter((b) => cmp(b.open, "0") > 0);
  if (payable.length === 0) throw new PaymentError("all selected bills are already fully paid");

  const byVendor = new Map<string, typeof payable>();
  for (const b of payable) {
    const list = byVendor.get(b.party_id) ?? [];
    list.push(b);
    byVendor.set(b.party_id, list);
  }

  const runNumber = await nextNumber(opts.orgId, "payment_run", "RUN-");

  const [run] = await db
    .insert(schema.paymentRuns)
    .values({
      orgId: opts.orgId,
      runNumber,
      bankAccountId: opts.bankAccountId,
      method: "eft",
      status: "draft",
      scheduledFor: opts.scheduledFor ?? null,
      createdBy: opts.createdBy,
    })
    .returning({ id: schema.paymentRuns.id, runNumber: schema.paymentRuns.runNumber });

  for (const [partyId, vendorBills] of byVendor) {
    const allocations: AllocationInput[] = vendorBills.map((b) => ({
      openLineId: b.open_line_id,
      amount: b.open,
    }));
    const total = sum(allocations.map((a) => a.amount));

    const payment = await createPaymentDocument({
      orgId: opts.orgId,
      kind: "vendor_payment",
      createdBy: opts.createdBy,
      partyId,
      bankAccountId: opts.bankAccountId,
      memo: `Payment run ${runNumber}`,
    });
    await updateDraftPayment(
      payment.id,
      { partyId, bankAccountId: opts.bankAccountId, allocations },
      opts.createdBy,
    );

    // Latest approved, active bank account for the payee (may be none — the
    // file export blocks on it with a clear error, never silently).
    const payeeBank = (await db.execute(sql`
      select id from party_bank_accounts
       where party_id = ${partyId} and is_active and approved_at is not null
       order by approved_at desc, created_at desc limit 1
    `)) as unknown as { rows: { id: string }[] };

    await db.insert(schema.paymentInstructions).values({
      orgId: opts.orgId,
      paymentRunId: run.id,
      payeePartyId: partyId,
      payeeBankAccountId: payeeBank.rows[0]?.id ?? null,
      amount: total,
      currency: org.baseCurrency,
      paymentDocumentId: payment.id,
      status: "pending",
      createdBy: opts.createdBy,
    });
  }

  return run;
}

/** Cancel a draft run: void nothing — drafts are deleted, instructions cancelled. */
export async function cancelPaymentRun(runId: string, orgId: string): Promise<void> {
  const [run] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, runId));
  if (!run || run.orgId !== orgId) throw new PaymentError("payment run not found");
  if (run.status !== "draft" && run.status !== "exported") {
    throw new PaymentError(`a ${run.status} run cannot be cancelled`);
  }
  const instructions = await db
    .select()
    .from(schema.paymentInstructions)
    .where(eq(schema.paymentInstructions.paymentRunId, runId));

  await db.transaction(async (tx) => {
    for (const ins of instructions) {
      // Release the FK to the draft payment before deleting it.
      await tx
        .update(schema.paymentInstructions)
        .set({ status: "cancelled", paymentDocumentId: null, updatedAt: new Date() })
        .where(eq(schema.paymentInstructions.id, ins.id));
      if (ins.paymentDocumentId) {
        const [doc] = await tx
          .select({ status: schema.documents.status })
          .from(schema.documents)
          .where(eq(schema.documents.id, ins.paymentDocumentId));
        if (doc && doc.status !== "draft") {
          throw new PaymentError("run has payments that are no longer drafts — it cannot be cancelled");
        }
        await tx.execute(sql`delete from document_lines where document_id = ${ins.paymentDocumentId}`);
        await tx.execute(sql`delete from documents where id = ${ins.paymentDocumentId}`);
      }
    }
    await tx
      .update(schema.paymentRuns)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(schema.paymentRuns.id, runId));
  });
}

export interface RunBlocker {
  instructionId: string;
  payee: string;
  reason: string;
}

/**
 * Everything the run detail view and the file export need to agree on:
 * EFT settings state and per-instruction bank-detail blockers.
 */
export async function paymentRunReadiness(runId: string, orgId: string): Promise<{
  eft: EftSettingsResult;
  blockers: RunBlocker[];
}> {
  const eft = await loadEftSettings(orgId);
  const rows = (await db.execute(sql`
    select i.id, p.display_name as payee, i.payee_bank_account_id,
           b.approved_at, b.is_active, b.routing, b.account_number_encrypted, i.currency
      from payment_instructions i
      join parties p on p.id = i.payee_party_id
      left join party_bank_accounts b on b.id = i.payee_bank_account_id
     where i.payment_run_id = ${runId} and i.org_id = ${orgId} and i.status <> 'cancelled'
  `)) as unknown as {
    rows: {
      id: string;
      payee: string;
      payee_bank_account_id: string | null;
      approved_at: string | null;
      is_active: boolean | null;
      routing: Record<string, string> | null;
      account_number_encrypted: string | null;
      currency: string;
    }[];
  };

  const blockers: RunBlocker[] = [];
  for (const r of rows.rows) {
    if (!r.payee_bank_account_id) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "no approved bank account on file" });
      continue;
    }
    if (!r.approved_at) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "bank account is not approved" });
      continue;
    }
    if (!r.is_active) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "bank account is inactive" });
      continue;
    }
    const routing = r.routing ?? {};
    if (!/^\d{3}$/.test(routing.institution ?? "")) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "missing/invalid 3-digit institution number" });
      continue;
    }
    if (!/^\d{5}$/.test(routing.transit ?? "")) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "missing/invalid 5-digit transit number" });
      continue;
    }
    if (!r.account_number_encrypted) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "missing account number" });
      continue;
    }
    if (r.currency !== "CAD") {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: `CPA-005 CAD file cannot carry ${r.currency}` });
    }
  }
  return { eft, blockers };
}

/**
 * Post every pending instruction's payment document (+ applications).
 * Sequential and partial-failure-honest: successes are marked 'sent'; any
 * failures are reported and leave the run 'exported' for retry.
 */
export async function postPaymentRun(
  runId: string,
  orgId: string,
  userId: string,
): Promise<{ posted: number; failures: { payee: string; error: string }[] }> {
  const [run] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, runId));
  if (!run || run.orgId !== orgId) throw new PaymentError("payment run not found");
  if (run.status !== "exported") {
    throw new PaymentError(
      run.status === "confirmed"
        ? "run is already posted"
        : "generate and download the EFT file before posting the run",
    );
  }

  const instructions = (await db.execute(sql`
    select i.id, i.payment_document_id, i.status, p.display_name as payee,
           d.status as document_status
      from payment_instructions i
      join parties p on p.id = i.payee_party_id
      left join documents d on d.id = i.payment_document_id
     where i.payment_run_id = ${runId} and i.status = 'pending'
     order by p.display_name
  `)) as unknown as {
    rows: {
      id: string;
      payment_document_id: string | null;
      status: string;
      payee: string;
      document_status: string | null;
    }[];
  };

  let posted = 0;
  const failures: { payee: string; error: string }[] = [];
  for (const ins of instructions.rows) {
    try {
      if (!ins.payment_document_id) throw new PaymentError("instruction has no payment document");
      // Already posted individually from its own flyout — just mark it sent.
      if (ins.document_status !== "posted") {
        await postPaymentWithApplications(ins.payment_document_id, undefined, userId);
      }
      await db
        .update(schema.paymentInstructions)
        .set({ status: "sent", updatedAt: new Date(), updatedBy: userId })
        .where(eq(schema.paymentInstructions.id, ins.id));
      posted += 1;
    } catch (e) {
      failures.push({ payee: ins.payee, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (failures.length === 0) {
    await db
      .update(schema.paymentRuns)
      .set({ status: "confirmed", updatedAt: new Date(), updatedBy: userId })
      .where(eq(schema.paymentRuns.id, runId));
  }
  return { posted, failures };
}

// ---------------------------------------------------------------------------
// CPA Standard 005 file
// ---------------------------------------------------------------------------

export interface Cpa005Payment {
  /** Amount in cents (positive integer, max 10 digits). */
  amountCents: bigint;
  /** Date funds are to be made available (payment date). */
  fundsDate: Date;
  /** Payee routing: 3-digit institution + 5-digit transit. */
  institution: string;
  transit: string;
  /** Payee account number, 1–12 digits/characters. */
  accountNumber: string;
  /** Payee name, truncated to 30 characters. */
  payeeName: string;
  /** Originator's cross-reference (e.g. payment document number), ≤19 chars. */
  crossReference: string;
}

export interface Cpa005Run {
  settings: EftSettings;
  /** 1–9999, unique per file transmitted to the institution. */
  fileCreationNumber: number;
  fileCreationDate: Date;
  payments: Cpa005Payment[];
}

const RECORD_LEN = 1464;
const SEGMENTS_PER_RECORD = 6;
const SEGMENT_LEN = 240;

function alpha(value: string, len: number): string {
  return value.slice(0, len).padEnd(len, " ");
}

function num(value: bigint | number, len: number): string {
  const s = String(value);
  if (s.length > len || Number(value) < 0) {
    throw new PaymentError(`numeric field value ${s} does not fit in ${len} digits`);
  }
  return s.padStart(len, "0");
}

/** CPA date format: 0YYDDD (leading zero, 2-digit year, julian day of year). */
function julian(d: Date): string {
  const year = d.getFullYear();
  const start = Date.UTC(year, 0, 1);
  const day =
    Math.floor((Date.UTC(year, d.getMonth(), d.getDate()) - start) / 86_400_000) + 1;
  return `0${String(year % 100).padStart(2, "0")}${String(day).padStart(3, "0")}`;
}

/** 9-digit institutional ID: 0 + institution(3) + transit(5). */
function institutionalId(institution: string, transit: string): string {
  if (!/^\d{3}$/.test(institution)) throw new PaymentError(`institution "${institution}" must be 3 digits`);
  if (!/^\d{5}$/.test(transit)) throw new PaymentError(`transit "${transit}" must be 5 digits`);
  return `0${institution}${transit}`;
}

/**
 * Build a CPA Standard 005 credit file (logical records A, C, Z; fixed-width
 * 1464-character records; up to six 240-character credit segments per C
 * record; CAD funds). Records are joined with CRLF.
 */
export function buildCpa005File(run: Cpa005Run): string {
  const s = run.settings;
  if (run.fileCreationNumber < 1 || run.fileCreationNumber > 9999) {
    throw new PaymentError("file creation number must be 1–9999");
  }
  if (run.payments.length === 0) throw new PaymentError("run has no payments to export");

  const originatorId = alpha(s.originatorId, 10);
  const fileCreationNo = num(run.fileCreationNumber, 4);
  const originControl = `${originatorId}${fileCreationNo}`; // positions 11–24
  const txnType = /^\d{3}$/.test(s.transactionCode ?? "") ? s.transactionCode! : "460";

  let recordCount = 0;
  const records: string[] = [];

  // -- A: header --------------------------------------------------------
  recordCount += 1;
  records.push(
    (
      "A" +
      num(recordCount, 9) +
      originControl +
      julian(run.fileCreationDate) +
      num(Number(s.dataCentre), 5) +
      " ".repeat(20) + // reserved customer-direct clearer communication area
      "CAD"
    ).padEnd(RECORD_LEN, " "),
  );

  // -- C: credit details, 6 segments per logical record -------------------
  const returnRouting = institutionalId(s.institution, s.transit);
  const returnAccount = alpha(s.account, 12);

  const segments = run.payments.map((p) => {
    if (p.amountCents <= 0n) throw new PaymentError("payment amounts must be positive");
    return (
      txnType + // transaction type (3)
      num(p.amountCents, 10) + // amount in cents (10)
      julian(p.fundsDate) + // date funds to be available (6)
      institutionalId(p.institution, p.transit) + // payee institutional id (9)
      alpha(p.accountNumber, 12) + // payee account number (12)
      "0".repeat(22) + // item trace number (22)
      "0".repeat(3) + // stored transaction type (3)
      alpha(s.originatorShortName, 15) + // originator short name (15)
      alpha(p.payeeName, 30) + // payee name (30)
      alpha(s.originatorLongName, 30) + // originator long name (30)
      originatorId + // originating direct clearer's user id (10)
      alpha(p.crossReference, 19) + // originator cross-reference (19)
      returnRouting + // institutional id for returns (9)
      returnAccount + // account number for returns (12)
      " ".repeat(15) + // originator sundry information (15)
      " ".repeat(22) + // filler (22)
      " ".repeat(2) + // originator-direct clearer settlement code (2)
      "0".repeat(11) // invalid data element id (11)
    );
  });
  for (const seg of segments) {
    if (seg.length !== SEGMENT_LEN) throw new PaymentError("internal error: CPA-005 segment is not 240 characters");
  }

  for (let i = 0; i < segments.length; i += SEGMENTS_PER_RECORD) {
    recordCount += 1;
    const chunk = segments.slice(i, i + SEGMENTS_PER_RECORD).join("");
    records.push(("C" + num(recordCount, 9) + originControl + chunk).padEnd(RECORD_LEN, " "));
  }

  // -- Z: trailer ---------------------------------------------------------
  const totalValue = run.payments.reduce((acc, p) => acc + p.amountCents, 0n);
  recordCount += 1;
  records.push(
    (
      "Z" +
      num(recordCount, 9) +
      originControl +
      num(0, 14) + // total value of debit transactions
      num(0, 8) + // total number of debit transactions
      num(totalValue, 14) + // total value of credit transactions
      num(run.payments.length, 8) + // total number of credit transactions
      num(0, 14) + // total value of error corrections "E"
      num(0, 8) + // total number of error corrections "E"
      num(0, 14) + // total value of error corrections "F"
      num(0, 8) // total number of error corrections "F"
    ).padEnd(RECORD_LEN, " "),
  );

  for (const rec of records) {
    if (rec.length !== RECORD_LEN) throw new PaymentError("internal error: CPA-005 record is not 1464 characters");
  }
  return records.join("\r\n") + "\r\n";
}

/**
 * Assemble and build the CPA-005 file for a payment run. Throws PaymentError
 * with every blocking problem (settings or payee bank details) — no partial
 * or fake files. The file creation number derives from the run number
 * sequence, so re-downloading the same run reproduces the same number.
 */
export async function loadCpa005RunFile(
  runId: string,
  orgId: string,
): Promise<{ filename: string; content: string; runNumber: string }> {
  const [run] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, runId));
  if (!run || run.orgId !== orgId) throw new PaymentError("payment run not found");
  if (run.status === "cancelled") throw new PaymentError("run is cancelled");
  if (run.method !== "eft") throw new PaymentError(`CPA-005 export applies to EFT runs, not ${run.method}`);

  const { eft, blockers } = await paymentRunReadiness(runId, orgId);
  if (!eft.ok) {
    throw new PaymentError(
      `EFT origination is not configured — missing orgs.settings.eft: ${eft.missing.join(", ")}. See engine/src/seed-eft-settings.ts.`,
    );
  }
  if (blockers.length > 0) {
    throw new PaymentError(
      `cannot generate the EFT file: ${blockers.map((b) => `${b.payee} (${b.reason})`).join("; ")}`,
    );
  }

  const rows = (await db.execute(sql`
    select i.id, i.amount, p.display_name as payee, b.routing, b.account_number_encrypted,
           d.document_number
      from payment_instructions i
      join parties p on p.id = i.payee_party_id
      join party_bank_accounts b on b.id = i.payee_bank_account_id
      left join documents d on d.id = i.payment_document_id
     where i.payment_run_id = ${runId} and i.status <> 'cancelled'
     order by p.display_name
  `)) as unknown as {
    rows: {
      id: string;
      amount: string;
      payee: string;
      routing: Record<string, string>;
      account_number_encrypted: string;
      document_number: string | null;
    }[];
  };
  if (rows.rows.length === 0) throw new PaymentError("run has no payable instructions");

  const fundsDate = run.scheduledFor ? new Date(`${run.scheduledFor}T00:00:00`) : new Date();
  const payments: Cpa005Payment[] = rows.rows.map((r) => {
    const units = toUnits(r.amount);
    if (units % 100n !== 0n) {
      throw new PaymentError(`instruction for ${r.payee} has sub-cent precision (${r.amount})`);
    }
    return {
      amountCents: units / 100n,
      fundsDate,
      institution: r.routing.institution,
      transit: r.routing.transit,
      accountNumber: decryptAccountNumber(r.account_number_encrypted),
      payeeName: r.payee,
      crossReference: r.document_number ?? r.id.slice(0, 19),
    };
  });

  const numeric = run.runNumber.replace(/\D/g, "");
  const fileCreationNumber = ((Number(numeric || "1") - 1) % 9999) + 1;

  const content = buildCpa005File({
    settings: eft.settings,
    fileCreationNumber,
    fileCreationDate: new Date(),
    payments,
  });
  return { filename: `CPA005-${run.runNumber}.txt`, content, runNumber: run.runNumber };
}
