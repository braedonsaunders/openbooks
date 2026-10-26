import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  replaceDocumentTenders,
  TenderRefusal,
  type TenderInput,
} from "@openbooks/engine/sales/document-tenders";
import {
  CashCloseoutError,
  assertCloseoutServer,
  parseCashCloseout,
  serializeCashCloseout,
} from "../sales/cash-closeout.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import type { DocumentEditInput, DocumentEditCurrent } from "./document-input.ts";
import type {
  DocumentEditContext,
  DocumentEditRunner,
  DocumentTransaction,
} from "./document-write-context.ts";

/**
 * Paid-at-sale tenders (cash_sale/cash_refund) arrive inside custom.tenders but
 * persist only in document_tenders, the single source clones and reports read.
 * Only supplied tenders are collected, so unrelated edits cannot lock tender writes.
 */
export function parseSuppliedTenders(
  current: DocumentEditCurrent,
  body: DocumentEditInput,
  headerCustom: Record<string, unknown> | null,
): TenderInput[] | undefined {
  let tenderInputs: TenderInput[] | undefined;
  if (
    body.custom !== undefined &&
    (current.kind === "cash_sale" || current.kind === "cash_refund")
  ) {
    const suppliedTenders = (body.custom as Record<string, unknown>).tenders;
    if (suppliedTenders !== undefined) {
      if (!Array.isArray(suppliedTenders)) {
        throw new DocumentEditError(
          422,
          "tenders must be a list — rebuild the tenders on the document",
        );
      }
      tenderInputs = suppliedTenders.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new DocumentEditError(
            422,
            "a tender is not an object — rebuild the tenders on the document",
          );
        }
        const tender = entry as Record<string, unknown>;
        return {
          kind: typeof tender.kind === "string" ? tender.kind : "",
          methodLabel: typeof tender.methodLabel === "string" ? tender.methodLabel : null,
          accountId: typeof tender.accountId === "string" ? tender.accountId : null,
          storedValueAccountId:
            typeof tender.storedValueAccountId === "string" ? tender.storedValueAccountId : null,
          amount: typeof tender.amount === "string" ? tender.amount : "",
          reference: typeof tender.reference === "string" ? tender.reference : null,
          externalRef: typeof tender.externalRef === "string" ? tender.externalRef : null,
          tipAmount: typeof tender.tipAmount === "string" ? tender.tipAmount : null,
          feeAmount: typeof tender.feeAmount === "string" ? tender.feeAmount : null,
        } satisfies TenderInput;
      });
      // Never persist the key: a stored bag carried in through the
      // existing-custom spread would otherwise keep it.
      if (headerCustom) delete headerCustom.tenders;
    }
  }
  return tenderInputs;
}

// Till-drop linkage (transfer only): the cashier's bank drop records
// which posted cash sale (or which till, by date) it moves cash from, plus the bank slip
// number as control evidence. Not a registered custom field, so it is
// carried explicitly like the funding override: uuid-shaped sale plus a
// short slip reference. Absent leaves the stored link untouched; an
// explicit null clears it.
export function applyTillDropLinkage(
  current: DocumentEditCurrent,
  body: DocumentEditInput,
  headerCustom: Record<string, unknown> | null,
): void {
  if (body.custom !== undefined && current.kind === "transfer" && headerCustom) {
    const link = (body.custom as Record<string, unknown>).cashSaleDeposit;
    if (link !== undefined) {
      if (link === null) {
        delete headerCustom.cashSaleDeposit;
      } else {
        if (!link || typeof link !== "object" || Array.isArray(link)) {
          throw new DocumentEditError(
            422,
            "bank drop linkage must be an object — record the drop from the cash sale",
          );
        }
        const { saleId, slipNumber } = link as Record<string, unknown>;
        if (typeof saleId !== "string" || !isUuid(saleId)) {
          throw new DocumentEditError(
            422,
            "bank drop linkage must name the cash sale — record the drop from the cash sale",
          );
        }
        if (
          typeof slipNumber !== "string" ||
          slipNumber.trim().length === 0 ||
          slipNumber.trim().length > 120
        ) {
          throw new DocumentEditError(
            422,
            "bank drop needs the bank slip number — enter it from the deposit slip",
          );
        }
        headerCustom.cashSaleDeposit = { saleId, slipNumber: slipNumber.trim() };
      }
    }
    // A drop recorded by till and date (before its sales post) names the
    // till cash account it leaves, the drop date, the last sale date its cash
    // covers and the slip, plus the count reason when the drop exceeds what
    // the recorded sales explain or lands behind a later drop.
    const till = (body.custom as Record<string, unknown>).tillDrop;
    if (till !== undefined) {
      if (till === null) {
        delete headerCustom.tillDrop;
      } else {
        if (!till || typeof till !== "object" || Array.isArray(till)) {
          throw new DocumentEditError(
            422,
            "till drop linkage must be an object — record the drop from Cash Sales",
          );
        }
        const { tillAccountId, dropDate, coversThrough, slipNumber, reason } = till as Record<
          string,
          unknown
        >;
        if (typeof tillAccountId !== "string" || !isUuid(tillAccountId)) {
          throw new DocumentEditError(
            422,
            "till drop linkage must name the till cash account — record the drop from Cash Sales",
          );
        }
        if (typeof dropDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dropDate)) {
          throw new DocumentEditError(
            422,
            "till drop linkage must carry the drop date — record the drop from Cash Sales",
          );
        }
        if (
          coversThrough !== undefined &&
          (typeof coversThrough !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(coversThrough) ||
            coversThrough > dropDate)
        ) {
          throw new DocumentEditError(
            422,
            "till drop cash cutoff must be a date on or before the drop date — enter the last sale date the counted cash covers",
          );
        }
        if (
          typeof slipNumber !== "string" ||
          slipNumber.trim().length === 0 ||
          slipNumber.trim().length > 120
        ) {
          throw new DocumentEditError(
            422,
            "till drop needs the bank slip number — enter it from the deposit slip",
          );
        }
        if (
          reason !== undefined &&
          (typeof reason !== "string" || reason.trim().length < 5 || reason.trim().length > 500)
        ) {
          throw new DocumentEditError(
            422,
            "till drop count note must be between 5 and 500 characters",
          );
        }
        headerCustom.tillDrop = {
          tillAccountId,
          dropDate,
          ...(typeof coversThrough === "string" ? { coversThrough } : {}),
          slipNumber: slipNumber.trim(),
          ...(typeof reason === "string" ? { reason: reason.trim() } : {}),
        };
      }
    }
  }
}

// Daily close-out (cash_sale only): tips, processor fees and the counted
// over/short. The drawer submits per-tender tip/fee amounts inside the
// tender entries above plus overShort/serverPartyId inside custom.closeout
// (never totals — the writer derives them from the parts, so the two can
// never drift). Persisted canonically as custom.closeout; the tenders key
// above never stores it. A close-out on a refund refuses: payouts ride
// the sale.
export async function applyCashCloseout(args: {
  runner: DocumentEditRunner;
  orgId: string;
  id: string;
  current: DocumentEditCurrent;
  body: DocumentEditInput;
  tenderInputs: TenderInput[] | undefined;
  headerCustom: Record<string, unknown> | null;
}): Promise<void> {
  const { runner, orgId, id, current, body, tenderInputs, headerCustom } = args;
  if (
    body.custom !== undefined &&
    (current.kind === "cash_sale" || current.kind === "cash_refund")
  ) {
    const suppliedCloseout = (body.custom as Record<string, unknown>).closeout;
    const tenderTipsFees = (tenderInputs ?? []).some(
      (input) =>
        (typeof input.tipAmount === "string" && input.tipAmount !== "") ||
        (typeof input.feeAmount === "string" && input.feeAmount !== ""),
    );
    if (current.kind === "cash_refund" && (suppliedCloseout !== undefined || tenderTipsFees)) {
      throw new DocumentEditError(
        422,
        "a cash refund cannot carry a close-out — record tips, fees and over/short on the cash sale",
      );
    }
    const existingCloseout = (current.custom as Record<string, unknown> | null)?.closeout;
    // A resubmitted tender set re-opens the stored close-out even when the
    // caller said nothing about it: stale positions must refuse here with
    // the rebuild remedy, not at posting.
    const closeoutTouched =
      suppliedCloseout !== undefined ||
      tenderTipsFees ||
      (tenderInputs !== undefined && existingCloseout !== undefined && existingCloseout !== null);
    if (current.kind === "cash_sale" && closeoutTouched && headerCustom) {
      try {
        if (
          suppliedCloseout !== undefined &&
          suppliedCloseout !== null &&
          (typeof suppliedCloseout !== "object" || Array.isArray(suppliedCloseout))
        ) {
          throw new CashCloseoutError(
            "Cash sale close-out must be an object.",
            "Rebuild the close-out from the tenders on the document.",
          );
        }
        const suppliedBag =
          suppliedCloseout !== undefined && suppliedCloseout !== null
            ? (suppliedCloseout as Record<string, unknown>)
            : {};
        // Tender facts for the cross-foot: freshly supplied inputs win (the
        // writer validates their amounts below); otherwise the table rows
        // already stored for this draft.
        const facts = await closeoutTenderFacts(runner, orgId, id, tenderInputs);
        // Parts ride the freshly supplied tenders when present; otherwise
        // the stored close-out's parts (an over/short-only edit resubmits no
        // tenders). Supplied parts are ignored beside fresh tenders — the
        // inputs are the single source — and read only in that case.
        const partRaws =
          tenderInputs !== undefined
            ? tenderInputs.map((input, index) => ({
                position: index + 1,
                tip: input.tipAmount ?? "",
                fee: input.feeAmount ?? "",
              }))
            : ((suppliedBag.parts ??
                (existingCloseout as Record<string, unknown> | undefined)?.parts ??
                []) as unknown[]);
        if (!Array.isArray(partRaws)) {
          throw new CashCloseoutError(
            "Cash sale close-out parts must be a list.",
            "Rebuild the close-out from the tenders on the document.",
          );
        }
        const parts = partRaws
          .map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              throw new CashCloseoutError(
                "A close-out tender part is not an object.",
                "Rebuild the close-out from the tenders on the document.",
              );
            }
            const row = entry as Record<string, unknown>;
            const position = row.position;
            if (typeof position !== "number" || !Number.isInteger(position)) {
              throw new CashCloseoutError(
                "A close-out tender part names no tender.",
                "Rebuild the close-out from the tenders on the document.",
              );
            }
            return {
              position,
              tip: fromUnits(closeoutPartMinor(row.tip, position, "tip")),
              fee: fromUnits(closeoutPartMinor(row.fee, position, "fee")),
            };
          })
          .filter((part) => part.tip !== "0.0000" || part.fee !== "0.0000");
        const bag: Record<string, unknown> = { ...suppliedBag, parts };
        // Fresh tenders are the single source: the header totals derive from
        // the same payload in the same statement, so the header can never
        // disagree with the tender fields (a save recomputes it, which also
        // recovers drafts wedged by an earlier divergence). An
        // over/short-only edit resubmits no tenders; then stated totals
        // still cross-foot against the stored parts.
        if (tenderInputs !== undefined) {
          bag.tipsTotal = fromUnits(parts.reduce((sum, part) => sum + toUnits(part.tip), 0n));
          bag.feeTotal = fromUnits(parts.reduce((sum, part) => sum + toUnits(part.fee), 0n));
        } else {
          if (bag.tipsTotal === undefined) {
            bag.tipsTotal = fromUnits(parts.reduce((sum, part) => sum + toUnits(part.tip), 0n));
          }
          if (bag.feeTotal === undefined) {
            bag.feeTotal = fromUnits(parts.reduce((sum, part) => sum + toUnits(part.fee), 0n));
          }
        }
        if (bag.overShort === undefined) {
          bag.overShort =
            typeof (existingCloseout as Record<string, unknown> | undefined)?.overShort === "string"
              ? (existingCloseout as Record<string, unknown>).overShort
              : "0";
        }
        if (bag.serverPartyId === undefined) {
          const existingServer = (existingCloseout as Record<string, unknown> | undefined)
            ?.serverPartyId;
          bag.serverPartyId = typeof existingServer === "string" ? existingServer : null;
        }
        const parsed = parseCashCloseout(bag, facts);
        if (parsed) await assertCloseoutServer(runner, orgId, parsed.serverPartyId);
        if (parsed) headerCustom.closeout = serializeCashCloseout(parsed);
        else delete headerCustom.closeout;
      } catch (error) {
        if (error instanceof CashCloseoutError)
          throw new DocumentEditError(422, error.message, undefined, error.remedy);
        throw error;
      }
    }
  }
}

/** Tender amounts the close-out cross-foots: freshly supplied inputs, else the stored rows. */
async function closeoutTenderFacts(
  runner: DocumentEditRunner,
  orgId: string,
  id: string,
  tenderInputs: TenderInput[] | undefined,
): Promise<{ kind: string; amountMinor: bigint }[]> {
  let facts: { kind: string; amountMinor: bigint }[];
  if (tenderInputs !== undefined) {
    facts = tenderInputs.map((input, index) => {
      let amountMinor: bigint;
      try {
        amountMinor = toUnits(input.amount);
      } catch {
        throw new CashCloseoutError(
          `Tender ${index + 1} amount ${JSON.stringify(input.amount)} is not a valid amount.`,
          `Enter tender ${index + 1} as a decimal amount with at most four places.`,
        );
      }
      return { kind: input.kind, amountMinor };
    });
  } else {
    const stored = await runner.execute<{ kind: string; minor: string }>(
      sql`
            select kind, amount_minor::text as minor from document_tenders
             where org_id = ${orgId} and document_id = ${id} order by position`,
      "objects",
    );
    facts = stored.map((row) => ({ kind: row.kind, amountMinor: BigInt(row.minor) }));
  }
  return facts;
}

/** One close-out tip or fee in minor units; blank is zero and negatives refuse. */
function closeoutPartMinor(raw: unknown, position: number, what: "tip" | "fee"): bigint {
  if (raw === undefined || raw === null || raw === "") return 0n;
  if (typeof raw !== "string") {
    throw new CashCloseoutError(
      `Close-out tender ${position} ${what} must be a decimal amount.`,
      `Enter tender ${position}'s ${what} as a decimal amount, or leave it blank.`,
    );
  }
  let minor: bigint;
  try {
    minor = toUnits(raw);
  } catch {
    throw new CashCloseoutError(
      `Close-out tender ${position} ${what} ${JSON.stringify(raw)} is not a valid amount.`,
      `Enter tender ${position}'s ${what} as a decimal amount with at most four places.`,
    );
  }
  if (minor < 0n) {
    throw new CashCloseoutError(
      `Close-out tender ${position} ${what} cannot be negative.`,
      `Enter tender ${position}'s ${what} as zero or a positive amount.`,
    );
  }
  return minor;
}

// Paid-at-sale tenders persist in document_tenders through the engine
// writer — validated (kinds, accounts, amounts, stored-value balances)
// and swapped atomically with the header and lines above, still on the
// draft the lifecycle guard requires. A refusal rolls the whole edit
// back with its message intact.
export async function replaceEditedTenders(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    id: string;
    userId: string;
    ctx: DocumentEditContext;
    tenderInputs: TenderInput[] | undefined;
    totals: { subtotal: string; taxTotal: string; total: string } | null;
  },
): Promise<void> {
  const { orgId, id, userId, ctx, tenderInputs, totals } = args;
  if (tenderInputs !== undefined) {
    try {
      await replaceDocumentTenders(
        tx as unknown as SqlExecutor,
        orgId,
        id,
        tenderInputs,
        // The edit's own authority flows through: an explicit scope wins,
        // otherwise the writer resolves the actor's live grants itself.
        {
          actorId: userId,
          allowedSubsidiaryIds: ctx.allowedSubsidiaryIds,
          ...(totals?.total !== undefined ? { documentTotal: totals.total } : {}),
        },
      );
    } catch (error) {
      if (error instanceof TenderRefusal)
        throw new DocumentEditError(error.status, error.message, undefined, error.remedy);
      throw error;
    }
  }
}
