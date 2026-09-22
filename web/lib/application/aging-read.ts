import "server-only";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { can } from "../authz";
import { normalizeMoneyValue } from "../cash/core";
import { clamp, isUuid } from "../list-params";
import {
  AgingRatesUnavailableError,
  agingByParty,
  agingDetail,
  type AgingSide,
} from "../reports/aging";
import { partnerStatement } from "../reports/registers";
import { ZERO, compareAbsoluteDescending } from "../reports/decimals";
import { decimalAdd, decimalCmp, type ExactDecimal } from "../statement-format";
import type { ApplicationContext } from "./context";
import { ApplicationError, forbidden, invalidInput } from "./errors";

const BUCKETS = new Set([
  "current",
  "days1to30",
  "days31to60",
  "days61to90",
  "over90",
  "over30",
  "over60",
  "overdue",
]);

type AgingBuckets = {
  current: ExactDecimal;
  b1: ExactDecimal;
  b2: ExactDecimal;
  b3: ExactDecimal;
  b4: ExactDecimal;
  total: ExactDecimal;
};

function isoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalidInput("asOf must be YYYY-MM-DD");
  return value;
}

function money(value: unknown): string {
  return normalizeMoneyValue(String(value ?? "0"));
}

function reportDims(context: ApplicationContext) {
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed === null) return undefined;
  if (allowed.size === 0) throw forbidden("subsidiary.restricted");
  return { subsidiaryIds: [...allowed] };
}

function assertSide(context: ApplicationContext, side: string): AgingSide {
  if (side !== "ar" && side !== "ap") throw invalidInput("side is required; use ar or ap");
  const permission = side === "ar" ? "ar.read" : "ap.read";
  if (!can(context.authz, permission)) throw forbidden(permission);
  return side;
}

function sliceOf(row: AgingBuckets, bucket: string | undefined): ExactDecimal {
  switch (bucket) {
    case "current": return row.current;
    case "days1to30": return row.b1;
    case "days31to60": return row.b2;
    case "days61to90": return row.b3;
    case "over90": return row.b4;
    case "over30": return decimalAdd(decimalAdd(row.b2, row.b3), row.b4);
    case "over60": return decimalAdd(row.b3, row.b4);
    case "overdue": return decimalAdd(decimalAdd(row.b1, row.b2), decimalAdd(row.b3, row.b4));
    default: return row.total;
  }
}

async function agingAsOf(context: ApplicationContext, asOf?: string): Promise<string> {
  return asOf ? isoDate(asOf) : businessToday(context.authz.user.orgId);
}

function agingFailure(error: unknown): never {
  if (error instanceof AgingRatesUnavailableError) {
    throw new ApplicationError("invalid_input", error.message, 422);
  }
  throw error;
}

function presentTotals(totals: AgingBuckets) {
  return {
    current: money(totals.current),
    days1to30: money(totals.b1),
    days31to60: money(totals.b2),
    days61to90: money(totals.b3),
    over90: money(totals.b4),
    total: money(totals.total),
  };
}

/** AR/AP aging by party — same `agingByParty` reader as the aging report and `aging`. */
export async function listApplicationAging(
  context: ApplicationContext,
  input: { side: string; asOf?: string; bucket?: string; limit?: number },
) {
  const side = assertSide(context, input.side);
  if (input.bucket && !BUCKETS.has(input.bucket)) {
    throw invalidInput("bucket must be current, days1to30, days31to60, days61to90, over90, over30, over60, or overdue");
  }
  const asOf = await agingAsOf(context, input.asOf);
  const limit = clamp(input.limit ?? 30, 1, 100);
  let result;
  try {
    result = await agingByParty(side, asOf, reportDims(context), context.authz.user.orgId);
  } catch (error) {
    agingFailure(error);
  }
  const ranked = input.bucket
    ? result.rows
      .filter((row) => decimalCmp(sliceOf(row, input.bucket), ZERO) !== 0)
      .sort((left, right) => compareAbsoluteDescending(sliceOf(left, input.bucket), sliceOf(right, input.bucket)))
    : result.rows;
  return {
    side,
    asOf: result.asOf,
    basis: result.basis,
    reportingCurrency: result.reportingCurrency,
    totals: presentTotals(result.totals),
    totalParties: result.rows.length,
    parties: ranked.slice(0, limit).map((row) => ({
      partyId: row.partyId,
      party: row.partyName,
      current: money(row.current),
      days1to30: money(row.b1),
      days31to60: money(row.b2),
      days61to90: money(row.b3),
      over90: money(row.b4),
      total: money(row.total),
      ...(input.bucket ? { bucketAmount: money(sliceOf(row, input.bucket)) } : {}),
    })),
  };
}

/** Per-document aging — same `agingDetail` reader as the aging detail report. */
export async function listApplicationAgingDetail(
  context: ApplicationContext,
  input: { side: string; asOf?: string; limit?: number },
) {
  const side = assertSide(context, input.side);
  const asOf = await agingAsOf(context, input.asOf);
  const limit = clamp(input.limit ?? 100, 1, 200);
  let result;
  try {
    result = await agingDetail(side, asOf, reportDims(context), context.authz.user.orgId);
  } catch (error) {
    agingFailure(error);
  }
  return {
    side,
    asOf: result.asOf,
    basis: result.basis,
    reportingCurrency: result.reportingCurrency,
    totals: presentTotals(result.totals),
    totalItems: result.rows.length,
    items: result.rows.slice(0, limit).map((row) => ({
      documentId: row.docId,
      documentKind: row.docKind,
      partyId: row.partyId,
      party: row.partyName,
      reference: row.reference,
      dueDate: row.dueDate,
      ageDays: row.ageDays,
      bucket: row.bucket,
      open: money(row.open),
      documentCurrency: row.docCurrency,
      transactionOpen: money(row.txnOpen),
    })),
  };
}

/** Customer/vendor statement — same `partnerStatement` reader as the statement report. */
export async function getApplicationPartnerStatement(
  context: ApplicationContext,
  input: { partyId: string; side: string; from: string; to: string },
) {
  const side = assertSide(context, input.side);
  if (!isUuid(input.partyId)) throw invalidInput("partyId must be a UUID");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) {
    throw invalidInput("from and to must be YYYY-MM-DD");
  }
  let result;
  try {
    result = await partnerStatement(input.partyId, context.authz.user.orgId, {
      from: input.from,
      to: input.to,
      side,
      dims: reportDims(context),
    });
  } catch (error) {
    agingFailure(error);
  }
  return {
    party: result.party,
    side: result.side,
    from: result.from,
    to: result.to,
    opening: money(result.opening),
    closing: money(result.closing),
    aging: presentTotals(result.aging),
    truncated: result.truncated,
    lines: result.lines.map((line) => ({
      entryId: line.entryId,
      entryNumber: line.entryNumber,
      date: line.date,
      memo: line.memo,
      debit: money(line.debit),
      credit: money(line.credit),
      balance: money(line.balance),
      documentKind: line.docKind,
      documentId: line.docId,
    })),
  };
}
