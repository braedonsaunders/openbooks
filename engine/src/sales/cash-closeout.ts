import { sql } from "drizzle-orm";
import { fromUnits, toUnits } from "../money/money.ts";
import type { Money } from "../money/brands.ts";
import { isUuid } from "../platform/uuid.ts";
import type { SqlExecutor } from "../platform/db.ts";
import type { CashSaleCloseout } from "../journal/posting-contracts.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";

/**
 * Daily close-out for a cash sale: card tips, processor fees and the cash
 * over/short. The money rides the tenders (a card tip is collected inside
 * its card tender; a fee is withheld from its card tender's settlement; the
 * over/short is the cash count against the expected till), while this
 * struct names how the kernel splits it back out:
 *
 * - tips credit the tips-payable liability (staff money, never revenue),
 *   tagged with the server's party when the sale names one;
 * - fees debit the configured processor-fee expense, so deposits reconcile
 *   net;
 * - a signed over/short debits (short) or credits (over) the configured
 *   over/short account.
 *
 * Persisted as `documents.custom.closeout` (canonical shape below); the
 * drawer submits per-tender tip/fee amounts inside `custom.tenders` entries
 * and the document writer folds them here. No tender-table migration: the
 * tender rows keep the gross collected amounts and the kernel cross-foots
 * `tenders = document total + tips − fees ± over/short` explicitly.
 */

export interface CashCloseoutTenderPart {
  /** 1-based tender position, matching document_tenders.position. */
  position: number;
  tipMinor: bigint;
  feeMinor: bigint;
}

export interface CashCloseoutInput {
  tipsTotalMinor: bigint;
  feeTotalMinor: bigint;
  /** Signed: positive is cash over, negative is cash short. */
  overShortMinor: bigint;
  /** Staff party the tips belong to; null pools the liability. */
  serverPartyId: string | null;
  parts: CashCloseoutTenderPart[];
}

/** A close-out refusal with the operator remedy each caller renders. */
export class CashCloseoutError extends Error {
  readonly name = "CashCloseoutError";

  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
  }
}

function closeoutError(message: string, remedy: string): CashCloseoutError {
  return new CashCloseoutError(message, remedy);
}

/** Tender channels a processor fee may be deducted from. Cash has no
 *  processor; stored value redeems a liability, never a card settlement. */
export const FEE_TENDER_KINDS: ReadonlySet<string> = new Set([
  "card",
  "bank_transfer",
  "wallet",
  "gateway",
]);

/**
 * Row-level close-out check shared by the tender writer and the document
 * writer: a tip is extra money collected (never a liability redemption),
 * a fee is withheld from a card settlement, and neither can exceed what
 * its tender collected.
 */
export function assertTenderCloseoutPart(
  tender: { kind: string; amountMinor: bigint; tipMinor: bigint; feeMinor: bigint },
  label: string,
): void {
  if (tender.tipMinor > 0n && tender.kind === "stored_value") {
    throw closeoutError(
      `${label} puts a tip on a gift card tender — a tip is extra money collected, never a liability redemption.`,
      "Move the tip onto the card tender that collected it.",
    );
  }
  if (tender.feeMinor > 0n && !FEE_TENDER_KINDS.has(tender.kind)) {
    throw closeoutError(
      `${label} deducts a processor fee from a ${tender.kind} tender — fees are withheld from card settlements.`,
      "Move the fee onto the card tender the processor settled, or record it at settlement.",
    );
  }
  if (tender.tipMinor > tender.amountMinor) {
    throw closeoutError(
      `${label} tip ${fromUnits(tender.tipMinor)} exceeds its tender's collected ${fromUnits(tender.amountMinor)}.`,
      "Enter the tip collected inside that tender — at most what the tender collected.",
    );
  }
  if (tender.feeMinor > tender.amountMinor) {
    throw closeoutError(
      `${label} fee ${fromUnits(tender.feeMinor)} exceeds its tender's collected ${fromUnits(tender.amountMinor)}.`,
      "Enter the fee withheld from that tender's settlement — at most what the tender collected.",
    );
  }
}

export interface CloseoutTenderFacts {
  kind: string;
  amountMinor: bigint;
}

function parseAmount(raw: unknown, label: string, what: string): bigint {
  if (raw === undefined || raw === null || raw === "") return 0n;
  if (typeof raw !== "string") {
    throw closeoutError(
      `${label} ${what} must be a decimal amount.`,
      `Enter ${what} as a decimal amount, or leave it blank.`,
    );
  }
  try {
    return toUnits(raw);
  } catch {
    throw closeoutError(
      `${label} ${what} ${JSON.stringify(raw)} is not a valid amount.`,
      `Enter ${what} as a decimal amount with at most four places.`,
    );
  }
}

function parseNonNegative(raw: unknown, label: string, what: string): bigint {
  const minor = parseAmount(raw, label, what);
  if (minor < 0n) {
    throw closeoutError(
      `${label} ${what} cannot be negative.`,
      `Enter ${what} as zero or a positive amount.`,
    );
  }
  return minor;
}

/**
 * Parse and cross-foot a close-out bag from documents.custom.closeout.
 * Pure: every refusal is deterministic from the inputs, so the drawer, the
 * document writer and the posting kernel share one reading. Returns null
 * when no close-out was recorded (the pre-close-out behavior is unchanged).
 */
export function parseCashCloseout(
  raw: unknown,
  tenders: readonly CloseoutTenderFacts[],
): CashCloseoutInput | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw closeoutError(
      "Cash sale close-out must be an object.",
      "Rebuild the close-out from the tenders on the document.",
    );
  }
  const bag = raw as Record<string, unknown>;
  for (const key of Object.keys(bag)) {
    if (!["tipsTotal", "feeTotal", "overShort", "serverPartyId", "parts"].includes(key)) {
      throw closeoutError(
        `Cash sale close-out has an unknown field ${JSON.stringify(key)}.`,
        "Rebuild the close-out from the tenders on the document.",
      );
    }
  }
  const tipsTotalMinor = parseNonNegative(bag.tipsTotal, "Close-out", "tips total");
  const feeTotalMinor = parseNonNegative(bag.feeTotal, "Close-out", "fee total");
  const overShortMinor = parseAmount(bag.overShort, "Close-out", "over/short");
  let serverPartyId: string | null = null;
  if (bag.serverPartyId !== undefined && bag.serverPartyId !== null && bag.serverPartyId !== "") {
    if (typeof bag.serverPartyId !== "string" || !isUuid(bag.serverPartyId)) {
      throw closeoutError(
        "Cash sale close-out names a server that is not a valid staff reference.",
        "Pick the server from the staff list, or clear it to pool the tips.",
      );
    }
    serverPartyId = bag.serverPartyId;
  }
  const rawParts = bag.parts ?? [];
  if (!Array.isArray(rawParts)) {
    throw closeoutError(
      "Cash sale close-out parts must be a list.",
      "Rebuild the close-out from the tenders on the document.",
    );
  }
  const parts: CashCloseoutTenderPart[] = [];
  const seen = new Set<number>();
  rawParts.forEach((entry, index) => {
    const label = `Close-out tender ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw closeoutError(
        `${label} is not an object.`,
        "Rebuild the close-out from the tenders on the document.",
      );
    }
    const row = entry as Record<string, unknown>;
    const position = row.position;
    if (
      typeof position !== "number" ||
      !Number.isInteger(position) ||
      position < 1 ||
      position > tenders.length
    ) {
      throw closeoutError(
        `${label} names tender ${JSON.stringify(position ?? null)}, which is not one of this sale's ${tenders.length} tenders.`,
        "Rebuild the close-out from the tenders on the document.",
      );
    }
    if (seen.has(position)) {
      throw closeoutError(
        `${label} repeats tender ${position}.`,
        "Name each tender once in the close-out.",
      );
    }
    seen.add(position);
    const tender = tenders[position - 1]!;
    const tipMinor = parseNonNegative(row.tip, `${label} (tender ${position})`, "tip");
    const feeMinor = parseNonNegative(row.fee, `${label} (tender ${position})`, "fee");
    assertTenderCloseoutPart(
      { kind: tender.kind, amountMinor: tender.amountMinor, tipMinor, feeMinor },
      `${label} (tender ${position})`,
    );
    if (tipMinor === 0n && feeMinor === 0n) {
      throw closeoutError(
        `${label} names tender ${position} with no tip and no fee.`,
        "Remove the empty close-out row, or enter its tip or fee.",
      );
    }
    parts.push({ position, tipMinor, feeMinor });
  });
  const partTips = parts.reduce((sum, part) => sum + part.tipMinor, 0n);
  const partFees = parts.reduce((sum, part) => sum + part.feeMinor, 0n);
  if (partTips !== tipsTotalMinor) {
    throw closeoutError(
      `Close-out tips total ${fromUnits(tipsTotalMinor)} does not match its tender tips ${fromUnits(partTips)}.`,
      "Enter the tips on their card tenders and let the total follow — or correct the total.",
    );
  }
  if (partFees !== feeTotalMinor) {
    throw closeoutError(
      `Close-out fee total ${fromUnits(feeTotalMinor)} does not match its tender fees ${fromUnits(partFees)}.`,
      "Enter the fees on their card tenders and let the total follow — or correct the total.",
    );
  }
  if (tipsTotalMinor === 0n && feeTotalMinor === 0n && overShortMinor === 0n) {
    return null;
  }
  parts.sort((a, b) => a.position - b.position);
  return { tipsTotalMinor, feeTotalMinor, overShortMinor, serverPartyId, parts };
}

/** Canonical JSON for documents.custom.closeout (minor units stay strings). */
export function serializeCashCloseout(parsed: CashCloseoutInput): Record<string, unknown> {
  return {
    tipsTotal: fromUnits(parsed.tipsTotalMinor),
    feeTotal: fromUnits(parsed.feeTotalMinor),
    overShort: fromUnits(parsed.overShortMinor),
    serverPartyId: parsed.serverPartyId,
    parts: parsed.parts.map((part) => ({
      position: part.position,
      tip: fromUnits(part.tipMinor),
      fee: fromUnits(part.feeMinor),
    })),
  };
}

export interface ResolvedCashCloseoutAccounts {
  tipsPayableAccountId: string | null;
  processorFeeAccountId: string | null;
  cashOverShortAccountId: string | null;
}

async function resolveControlAccount(
  runner: SqlExecutor,
  orgId: string,
  role: string,
  label: string,
  allowedTypes: readonly string[],
): Promise<string> {
  const mapping =
    (
      await runner.execute<{ account_id: string | null }>(
        sql`
    select settings->'controlAccounts'->>${role}::text as account_id
      from orgs where id = ${orgId}`,
        "objects",
      )
    )[0]?.account_id ?? null;
  if (!mapping) {
    throw closeoutError(
      `This sale records ${label}, but no ${label} account is configured.`,
      `Set the ${label} account in Setup → Company & Accounting → Control accounts, then repost.`,
    );
  }
  const row = (
    await runner.execute<{ type: string; is_active: boolean; is_summary: boolean }>(
      sql`
    select type, is_active, is_summary from accounts
     where org_id = ${orgId} and id = ${mapping}::uuid`,
      "objects",
    )
  )[0];
  if (!row || !row.is_active || row.is_summary || !allowedTypes.includes(row.type)) {
    throw closeoutError(
      `The configured ${label} account is not a usable posting account.`,
      `Choose an active ${label} account in Setup → Company & Accounting → Control accounts, then repost.`,
    );
  }
  return mapping;
}

function closeoutRemedyNoun(kind: "tips" | "fees" | "over/short"): string {
  if (kind === "tips") return "tips-payable liability";
  if (kind === "fees") return "processor-fee expense";
  return "cash over/short";
}

/**
 * Resolve the control accounts a parsed close-out posts to, lazily: an
 * account is required only when its amount is nonzero, so sales without a
 * close-out — and close-outs without that component — need no
 * configuration. Every refusal names the Setup remedy.
 */
export async function resolveCashCloseoutAccounts(
  runner: SqlExecutor,
  orgId: string,
  parsed: CashCloseoutInput,
): Promise<ResolvedCashCloseoutAccounts> {
  return {
    tipsPayableAccountId:
      parsed.tipsTotalMinor === 0n
        ? null
        : await resolveControlAccount(runner, orgId, "tipsPayable", closeoutRemedyNoun("tips"), [
            "liability_payable",
            "liability_current_other",
          ]),
    processorFeeAccountId:
      parsed.feeTotalMinor === 0n
        ? null
        : await resolveControlAccount(runner, orgId, "processorFees", closeoutRemedyNoun("fees"), [
            "expense",
            "expense_other",
          ]),
    cashOverShortAccountId:
      parsed.overShortMinor === 0n
        ? null
        : await resolveControlAccount(
            runner,
            orgId,
            "cashOverShort",
            closeoutRemedyNoun("over/short"),
            ["income", "income_other", "expense", "expense_other"],
          ),
  };
}

/** Confirm the named server is a party in this organization. Null pools. */
export async function assertCloseoutServer(
  runner: SqlExecutor,
  orgId: string,
  serverPartyId: string | null,
): Promise<void> {
  if (!serverPartyId) return;
  const row = (
    await runner.execute<{ id: string }>(
      sql`
    select id from parties where org_id = ${orgId} and id = ${serverPartyId} and is_active`,
      "objects",
    )
  )[0];
  if (!row) {
    throw closeoutError(
      "Cash sale close-out names a server who is not an active party in this organization.",
      "Pick the server from the staff list, or clear it to pool the tips.",
    );
  }
}

/**
 * Full posting-time resolution: parse, confirm the server, resolve the
 * accounts. The kernel backstops a missing account for a nonzero amount —
 * prepare always resolves first, so that refusal only fires on a
 * hand-built dependency set.
 */
export async function resolveCashCloseoutForPosting(
  runner: SqlExecutor,
  orgId: string,
  custom: unknown,
  tenders: readonly CloseoutTenderFacts[],
): Promise<CashSaleCloseout | null> {
  const parsed = parseCashCloseout((custom as Record<string, unknown> | null)?.closeout, tenders);
  if (!parsed) return null;
  await assertCloseoutServer(runner, orgId, parsed.serverPartyId);
  const accounts = await resolveCashCloseoutAccounts(runner, orgId, parsed);
  return {
    tipsTotal: fromUnits(parsed.tipsTotalMinor) as Money,
    feeTotal: fromUnits(parsed.feeTotalMinor) as Money,
    overShort: fromUnits(parsed.overShortMinor) as Money,
    serverPartyId: parsed.serverPartyId,
    ...accounts,
  };
}

export type TipsPayableExposureRow = {
  partyId: string | null;
  partyName: string | null;
  day: string;
  documentNumber: string;
  amountMinor: string;
};

/**
 * Tips payable carried for payroll pay-out: posted cash-sale tips legs on
 * the tips-payable control account, grouped by server (party) and sale day.
 * Unnamed-server tips pool under a null party. Empty when the control
 * account is unconfigured — there is nothing carried to pay out.
 */
export async function readTipsPayableExposure(
  runner: SqlExecutor,
  orgId: string,
  options: {
    from?: string;
    to?: string;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  },
): Promise<TipsPayableExposureRow[]> {
  const mapping =
    (
      await runner.execute<{ account_id: string | null }>(
        sql`
    select settings->'controlAccounts'->>'tipsPayable' as account_id
      from orgs where id = ${orgId}`,
        "objects",
      )
    )[0]?.account_id ?? null;
  if (!mapping) return [];
  const rows = await runner.execute<TipsPayableExposureRow>(
    sql`
    select l.party_id as "partyId", p.display_name as "partyName",
           d.document_date::text as day, d.document_number as "documentNumber",
           sum(round(l.amount * 10000))::bigint::text as "amountMinor"
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join documents d on d.id = e.source_document_id and d.org_id = e.org_id
      left join parties p on p.id = l.party_id and p.org_id = l.org_id
     where l.org_id = ${orgId} and l.account_id = ${mapping}::uuid
       -- A voided sale's reversal posts against its original, so both statuses
       -- are read and the pair nets to nothing.
       and e.status in ('posted', 'reversed') and d.kind = 'cash_sale'
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, options.allowedSubsidiaryIds)}
       and (${options.from ?? null}::date is null or d.document_date >= (${options.from ?? null})::date)
       and (${options.to ?? null}::date is null or d.document_date <= (${options.to ?? null})::date)
     group by l.party_id, p.display_name, d.document_date, d.document_number
    having sum(round(l.amount * 10000)) <> 0
     order by d.document_date, d.document_number`,
    "objects",
  );
  return rows;
}
