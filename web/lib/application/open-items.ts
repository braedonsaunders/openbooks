import "server-only";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { openItems } from "../cash/open-items";
import { normalizeMoneyValue } from "../cash/core";
import { clamp } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { invalidInput } from "./errors";

export type OpenItemSide = "ar" | "ap";

function isoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalidInput("asOf must be YYYY-MM-DD");
  }
  return value;
}

/** Open AR/AP items — same reader as `list_open_items` and the cash cockpits. */
export async function listApplicationOpenItems(
  context: ApplicationContext,
  input: { side: string; asOf?: string; partyId?: string; limit?: number },
) {
  if (input.side !== "ar" && input.side !== "ap") {
    throw invalidInput("side is required; use ar or ap");
  }
  const side = input.side as OpenItemSide;
  assertApplicationPermission(context, side === "ar" ? "ar.read" : "ap.read");
  const asOf = input.asOf ? isoDate(input.asOf) : await businessToday(context.authz.user.orgId);
  const allowed = context.authz.allowedSubsidiaryIds;
  const all = await openItems(
    context.authz.user.orgId,
    side,
    asOf,
    allowed === null ? undefined : [...allowed],
  );
  const scoped = input.partyId ? all.filter((item) => item.partyId === input.partyId) : all;
  scoped.sort((left, right) =>
    (left.dueDate ?? left.tranDate).getTime() - (right.dueDate ?? right.tranDate).getTime(),
  );
  const limit = clamp(input.limit ?? 100, 1, 200);
  return {
    side,
    asOf,
    total: scoped.length,
    items: scoped.slice(0, limit).map((item) => ({
      openLineId: item.id,
      documentId: item.docId,
      documentKind: item.docKind,
      documentNumber: item.docNumber,
      partyId: item.partyId,
      party: item.partyName,
      tranDate: item.tranDate.toISOString().slice(0, 10),
      dueDate: item.dueDate ? item.dueDate.toISOString().slice(0, 10) : null,
      remaining: normalizeMoneyValue(String(item.remaining)),
    })),
  };
}
