/**
 * "Duplicate yesterday" seed: yesterday's cash sale returns as today's draft
 * template — same lines, same tender shape, today's date. Day-specific
 * close-out facts (tips, fees, over/short, server) never copy: yesterday's
 * tips belong to yesterday's staff.
 */

export interface DuplicateSeedLine {
  accountId: string;
  itemId?: string | null;
  quantity?: string | null;
  unitPrice?: string | null;
  amount: string;
  description?: string | null;
  taxCodeId?: string | null;
  taxGroupId?: string | null;
}

export interface DuplicateSeedTender {
  kind: string;
  methodLabel?: string | null;
  accountId?: string | null;
  storedValueAccountId?: string | null;
  amount: string;
  reference?: string | null;
  externalRef?: string | null;
}

export interface DuplicateSeed {
  partyId: string | null;
  lines: DuplicateSeedLine[];
  tenders: DuplicateSeedTender[];
}

interface SeedLineRow {
  account_id: string | null;
  item_id: string | null;
  quantity: string | null;
  unit_price: string | null;
  amount: string | null;
  description: string | null;
  tax_code_id: string | null;
  tax_group_id: string | null;
}

export interface SeedTenderRow {
  kind: string | null;
  method_label: string | null;
  account_id: string | null;
  stored_value_account_id: string | null;
  amount: string | null;
  reference: string | null;
}

const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * Build the draft seed from a source sale's stored rows. Pure: every row
 * that cannot seed (missing account or amount) is dropped, and tender
 * minor units render back to decimal strings. Returns null when nothing
 * seedable remains.
 */
export function buildDuplicateSeed(args: {
  partyId: string | null;
  lines: SeedLineRow[];
  tenders: SeedTenderRow[];
}): DuplicateSeed | null {
  const lines: DuplicateSeedLine[] = [];
  for (const row of args.lines) {
    if (!isUuid(row.account_id) || typeof row.amount !== "string" || row.amount === "") continue;
    lines.push({
      accountId: row.account_id,
      ...(isUuid(row.item_id) ? { itemId: row.item_id } : {}),
      ...(row.quantity ? { quantity: row.quantity } : {}),
      ...(row.unit_price ? { unitPrice: row.unit_price } : {}),
      amount: row.amount,
      ...(row.description ? { description: row.description } : {}),
      ...(isUuid(row.tax_code_id) ? { taxCodeId: row.tax_code_id } : {}),
      ...(isUuid(row.tax_group_id) ? { taxGroupId: row.tax_group_id } : {}),
    });
  }
  if (lines.length === 0) return null;
  const tenders: DuplicateSeedTender[] = [];
  for (const row of args.tenders) {
    if (typeof row.amount !== "string" || row.amount === "") continue;
    tenders.push({
      kind: row.kind ?? "cash",
      ...(row.method_label ? { methodLabel: row.method_label } : {}),
      ...(isUuid(row.account_id) ? { accountId: row.account_id } : {}),
      ...(isUuid(row.stored_value_account_id)
        ? { storedValueAccountId: row.stored_value_account_id }
        : {}),
      amount: row.amount,
      ...(row.reference ? { reference: row.reference } : {}),
    });
  }
  return {
    partyId: isUuid(args.partyId) ? args.partyId : null,
    lines,
    tenders,
  };
}
