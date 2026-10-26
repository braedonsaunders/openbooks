/**
 * Multi-book configuration: a secondary book's base currency per
 * subsidiary and its account mappings. Both are effective-dated versions
 * that never change under entries the book already holds (storage guards
 * enforce it for every writer); these services add the business
 * validation, serialize against posting through the ledger-setup fence and
 * the book row, and audit every change with its reason.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import {
  assertUnrestrictedScope,
  subsidiaryVisibleFilter,
} from "../organization/subsidiary-scope.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import {
  bookAccountMapRefusal,
  bookAccountMapScopeRefusal,
  loadMappableAccounts,
} from "../journal/book-account-maps.ts";
import { isBookRateType } from "../journal/book-translation.ts";
import { MULTI_BOOK_DISABLED, MultiBookError, multiBookStorageRefusal } from "./errors.ts";

export interface BookCurrencyRow {
  id: string;
  bookId: string;
  subsidiaryId: string;
  currency: string;
  rateType: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
}

export interface BookAccountMapRow {
  id: string;
  bookId: string;
  subsidiaryId: string | null;
  sourceAccountId: string;
  targetAccountId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
}

const CURRENCY_COLUMNS = sql`
  id, book_id as "bookId", subsidiary_id as "subsidiaryId", currency, rate_type as "rateType",
  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo", reason`;

const MAP_COLUMNS = sql`
  id, book_id as "bookId", subsidiary_id as "subsidiaryId",
  source_account_id as "sourceAccountId", target_account_id as "targetAccountId",
  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo", reason`;

export function requireReason(reason: unknown): string {
  const value = typeof reason === "string" ? reason.trim() : "";
  if (value.length < 8 || value.length > 500)
    throw new MultiBookError("a reason between 8 and 500 characters is required");
  return value;
}

export function requireDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !isIsoCalendarDate(value))
    throw new MultiBookError(`${label} must be a date (YYYY-MM-DD)`);
  return value;
}

function optionalDate(value: unknown, label: string): string | null {
  return value == null || value === "" ? null : requireDate(value, label);
}

export async function requireMultiBookFeature(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(runner, orgId, "multiBookAccounting")))
    throw new MultiBookError(MULTI_BOOK_DISABLED, 404);
}

/**
 * Lock a secondary book for a configuration change: postings into the book
 * hold its row for share, so the change waits for them and later postings
 * see it. The primary book is the chart of record and takes no book
 * configuration.
 */
export async function lockSecondaryBook(
  runner: SqlExecutor,
  orgId: string,
  bookId: unknown,
): Promise<{
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  postsGl: boolean;
  replicationMode: string;
  replicationFrom: string | null;
  currencyDifferenceAccountId: string | null;
}> {
  if (!isUuid(bookId)) throw new MultiBookError("accounting book not found", 404);
  const row = (
    await runner.execute<{
      id: string;
      code: string;
      name: string;
      is_primary: boolean;
      is_active: boolean;
      posts_gl: boolean;
      replication_mode: string;
      replication_from: string | null;
      currency_difference_account_id: string | null;
    }>(
      sql`
    select id, code, name, is_primary, is_active, posts_gl, replication_mode,
           replication_from::text as replication_from, currency_difference_account_id
      from accounting_books where org_id = ${orgId} and id = ${bookId}
      for update`,
      "objects",
    )
  )[0];
  if (!row) throw new MultiBookError("accounting book not found", 404);
  if (row.is_primary)
    throw new MultiBookError(
      `${row.code} is the primary book — the chart of record carries no book-specific configuration`,
    );
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.is_active,
    postsGl: row.posts_gl,
    replicationMode: row.replication_mode,
    replicationFrom: row.replication_from,
    currencyDifferenceAccountId: row.currency_difference_account_id,
  };
}

async function audit(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  table: string,
  rowId: string,
  action: "insert" | "update",
  before: unknown,
  after: unknown,
  reason: string,
): Promise<void> {
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${table}, ${rowId}, ${action}, ${JSON.stringify({ before, after, reason })}::jsonb, ${actorId})`);
}

async function dayBefore(runner: SqlExecutor, date: string): Promise<string> {
  return (
    await runner.execute<{ d: string }>(sql`select (${date}::date - 1)::text as d`, "objects")
  )[0]!.d;
}

export async function listBookCurrencies(
  orgId: string,
  runner: SqlExecutor = db,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<BookCurrencyRow[]> {
  return await runner.execute<BookCurrencyRow & Record<string, unknown>>(
    sql`
    select ${CURRENCY_COLUMNS} from accounting_book_currencies
     where org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)}
     order by book_id, subsidiary_id, effective_from desc`,
    "objects",
  );
}

export async function listBookAccountMaps(
  orgId: string,
  runner: SqlExecutor = db,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<BookAccountMapRow[]> {
  return await runner.execute<BookAccountMapRow & Record<string, unknown>>(
    sql`
    select ${MAP_COLUMNS} from accounting_book_account_maps
     where org_id = ${orgId}
       ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     order by book_id, source_account_id, effective_from desc`,
    "objects",
  );
}

/**
 * Give a secondary book its own base currency (and rate type) for one
 * subsidiary from a date. A version still open on that date closes the day
 * before; a later version must be closed first. The storage guard refuses a
 * version that would reinterpret entries the book already holds.
 */
export async function createBookCurrencyVersion(args: {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  input: {
    bookId: unknown;
    subsidiaryId: unknown;
    currency: unknown;
    rateType: unknown;
    effectiveFrom: unknown;
    effectiveTo?: unknown;
  };
  reason: unknown;
}): Promise<BookCurrencyRow> {
  assertUnrestrictedScope(args.allowedSubsidiaryIds);
  const reason = requireReason(args.reason);
  const effectiveFrom = requireDate(args.input.effectiveFrom, "effective from");
  const effectiveTo = optionalDate(args.input.effectiveTo, "effective to");
  if (effectiveTo && effectiveTo < effectiveFrom)
    throw new MultiBookError("effective to must be on or after effective from");
  if (!isBookRateType(args.input.rateType))
    throw new MultiBookError("rate type must be spot or month_average");
  const rateType = args.input.rateType;
  const currency =
    typeof args.input.currency === "string" ? args.input.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency))
    throw new MultiBookError("currency must be a three-letter ISO code");
  if (!isUuid(args.input.subsidiaryId)) throw new MultiBookError("subsidiary not found", 404);
  const subsidiaryId = args.input.subsidiaryId;
  try {
    return await withOrgTransaction(args.orgId, async () => {
      await requireMultiBookFeature(db, args.orgId);
      await lockLedgerSetupFence(db, args.orgId, "exclusive");
      const book = await lockSecondaryBook(db, args.orgId, args.input.bookId);
      const refs = (
        await db.execute<{ subsidiary_ok: boolean; currency_ok: boolean }>(
          sql`
        select exists(select 1 from subsidiaries where org_id = ${args.orgId} and id = ${subsidiaryId}
                       and is_active and not is_elimination) as subsidiary_ok,
               exists(select 1 from currencies where code = ${currency}) as currency_ok`,
          "objects",
        )
      )[0];
      if (!refs?.subsidiary_ok) throw new MultiBookError("subsidiary not found or inactive", 404);
      if (!refs.currency_ok) throw new MultiBookError(`${currency} is not a known currency`);
      const versions = await db.execute<BookCurrencyRow & Record<string, unknown>>(
        sql`
        select ${CURRENCY_COLUMNS} from accounting_book_currencies
         where org_id = ${args.orgId} and book_id = ${book.id} and subsidiary_id = ${subsidiaryId}
         order by effective_from for update`,
        "objects",
      );
      const later = versions.find((version) => version.effectiveFrom >= effectiveFrom);
      if (later)
        throw new MultiBookError(
          `a version from ${later.effectiveFrom} already exists; start this version after it or close that version first`,
        );
      const prior = versions.find(
        (version) => version.effectiveTo === null || version.effectiveTo >= effectiveFrom,
      );
      if (prior) {
        const closeTo = await dayBefore(db, effectiveFrom);
        const closed = (
          await db.execute<BookCurrencyRow & Record<string, unknown>>(
            sql`
          update accounting_book_currencies set effective_to = ${closeTo}::date, updated_at = now(), updated_by = ${args.actorId}
           where org_id = ${args.orgId} and id = ${prior.id} returning ${CURRENCY_COLUMNS}`,
            "objects",
          )
        )[0];
        if (!closed)
          throw new MultiBookError(
            "the book currency changed while you were saving; reload and try again",
            409,
          );
        await audit(
          db,
          args.orgId,
          args.actorId,
          "accounting_book_currencies",
          prior.id,
          "update",
          prior,
          closed,
          reason,
        );
      }
      const created = (
        await db.execute<BookCurrencyRow & Record<string, unknown>>(
          sql`
        insert into accounting_book_currencies (org_id, book_id, subsidiary_id, currency, rate_type, effective_from,
                                                effective_to, reason, created_by, updated_by)
        values (${args.orgId}, ${book.id}, ${subsidiaryId}, ${currency}, ${rateType}, ${effectiveFrom}::date,
                ${effectiveTo}::date, ${reason}, ${args.actorId}, ${args.actorId})
        returning ${CURRENCY_COLUMNS}`,
          "objects",
        )
      )[0];
      if (!created) throw new Error("book currency insert returned no row");
      await audit(
        db,
        args.orgId,
        args.actorId,
        "accounting_book_currencies",
        created.id,
        "insert",
        null,
        created,
        reason,
      );
      return created;
    });
  } catch (error) {
    throw multiBookStorageRefusal(error) ?? error;
  }
}

/** End a book currency version's window (never before entries it governed). */
export async function closeBookCurrencyVersion(args: {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  id: unknown;
  effectiveTo: unknown;
  reason: unknown;
}): Promise<BookCurrencyRow> {
  assertUnrestrictedScope(args.allowedSubsidiaryIds);
  const reason = requireReason(args.reason);
  const effectiveTo = optionalDate(args.effectiveTo, "effective to");
  if (!isUuid(args.id)) throw new MultiBookError("book currency not found", 404);
  const id = args.id;
  try {
    return await withOrgTransaction(args.orgId, async () => {
      await requireMultiBookFeature(db, args.orgId);
      await lockLedgerSetupFence(db, args.orgId, "exclusive");
      const current = (
        await db.execute<BookCurrencyRow & Record<string, unknown>>(
          sql`
        select ${CURRENCY_COLUMNS} from accounting_book_currencies where org_id = ${args.orgId} and id = ${id}`,
          "objects",
        )
      )[0];
      if (!current) throw new MultiBookError("book currency not found", 404);
      await lockSecondaryBook(db, args.orgId, current.bookId);
      if (effectiveTo && effectiveTo < current.effectiveFrom)
        throw new MultiBookError("effective to must be on or after effective from");
      const after = (
        await db.execute<BookCurrencyRow & Record<string, unknown>>(
          sql`
        update accounting_book_currencies set effective_to = ${effectiveTo}::date, updated_at = now(), updated_by = ${args.actorId}
         where org_id = ${args.orgId} and id = ${id} returning ${CURRENCY_COLUMNS}`,
          "objects",
        )
      )[0];
      if (!after)
        throw new MultiBookError(
          "the book currency changed while you were saving; reload and try again",
          409,
        );
      await audit(
        db,
        args.orgId,
        args.actorId,
        "accounting_book_currencies",
        id,
        "update",
        current,
        after,
        reason,
      );
      return after;
    });
  } catch (error) {
    throw multiBookStorageRefusal(error) ?? error;
  }
}

/**
 * Map a chart account to the account a secondary book carries it in, from
 * a date (optionally for one subsidiary). The mapping must keep the
 * statement class, honour currency restrictions and be available wherever
 * it applies; the storage guard refuses one that would reinterpret entries
 * the book already holds on the source account.
 */
export async function createBookAccountMap(args: {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  input: {
    bookId: unknown;
    subsidiaryId?: unknown;
    sourceAccountId: unknown;
    targetAccountId: unknown;
    effectiveFrom: unknown;
    effectiveTo?: unknown;
  };
  reason: unknown;
}): Promise<BookAccountMapRow> {
  assertUnrestrictedScope(args.allowedSubsidiaryIds);
  const reason = requireReason(args.reason);
  const effectiveFrom = requireDate(args.input.effectiveFrom, "effective from");
  const effectiveTo = optionalDate(args.input.effectiveTo, "effective to");
  if (effectiveTo && effectiveTo < effectiveFrom)
    throw new MultiBookError("effective to must be on or after effective from");
  const subsidiaryId =
    args.input.subsidiaryId == null || args.input.subsidiaryId === ""
      ? null
      : args.input.subsidiaryId;
  if (subsidiaryId !== null && !isUuid(subsidiaryId))
    throw new MultiBookError("subsidiary not found", 404);
  if (!isUuid(args.input.sourceAccountId) || !isUuid(args.input.targetAccountId)) {
    throw new MultiBookError("choose the source and book accounts from the chart of accounts");
  }
  const sourceId = args.input.sourceAccountId;
  const targetId = args.input.targetAccountId;
  try {
    return await withOrgTransaction(args.orgId, async () => {
      await requireMultiBookFeature(db, args.orgId);
      await lockLedgerSetupFence(db, args.orgId, "exclusive");
      const book = await lockSecondaryBook(db, args.orgId, args.input.bookId);
      const accounts = await loadMappableAccounts(db, args.orgId, [sourceId, targetId]);
      const source = accounts.get(sourceId);
      const target = accounts.get(targetId);
      if (!source || !target)
        throw new MultiBookError("account not found in this organization", 404);
      const refusal = bookAccountMapRefusal(source, target);
      if (refusal) throw new MultiBookError(refusal);
      const ctx = await loadSubsidiaryContext(db, args.orgId);
      if (subsidiaryId !== null && !ctx.byId.has(subsidiaryId))
        throw new MultiBookError("subsidiary not found", 404);
      const scopeRefusal = bookAccountMapScopeRefusal(ctx, source, target, subsidiaryId);
      if (scopeRefusal) throw new MultiBookError(scopeRefusal);
      const created = (
        await db.execute<BookAccountMapRow & Record<string, unknown>>(
          sql`
        insert into accounting_book_account_maps (org_id, book_id, subsidiary_id, source_account_id, target_account_id,
                                                  effective_from, effective_to, reason, created_by, updated_by)
        values (${args.orgId}, ${book.id}, ${subsidiaryId}, ${source.id}, ${target.id},
                ${effectiveFrom}::date, ${effectiveTo}::date, ${reason}, ${args.actorId}, ${args.actorId})
        returning ${MAP_COLUMNS}`,
          "objects",
        )
      )[0];
      if (!created) throw new Error("book account mapping insert returned no row");
      await audit(
        db,
        args.orgId,
        args.actorId,
        "accounting_book_account_maps",
        created.id,
        "insert",
        null,
        created,
        reason,
      );
      return created;
    });
  } catch (error) {
    throw multiBookStorageRefusal(error) ?? error;
  }
}

/** End a mapping's window (never before entries it governed). */
export async function closeBookAccountMap(args: {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  id: unknown;
  effectiveTo: unknown;
  reason: unknown;
}): Promise<BookAccountMapRow> {
  assertUnrestrictedScope(args.allowedSubsidiaryIds);
  const reason = requireReason(args.reason);
  const effectiveTo = optionalDate(args.effectiveTo, "effective to");
  if (!isUuid(args.id)) throw new MultiBookError("account mapping not found", 404);
  const id = args.id;
  try {
    return await withOrgTransaction(args.orgId, async () => {
      await requireMultiBookFeature(db, args.orgId);
      await lockLedgerSetupFence(db, args.orgId, "exclusive");
      const current = (
        await db.execute<BookAccountMapRow & Record<string, unknown>>(
          sql`
        select ${MAP_COLUMNS} from accounting_book_account_maps where org_id = ${args.orgId} and id = ${id}`,
          "objects",
        )
      )[0];
      if (!current) throw new MultiBookError("account mapping not found", 404);
      await lockSecondaryBook(db, args.orgId, current.bookId);
      if (effectiveTo && effectiveTo < current.effectiveFrom)
        throw new MultiBookError("effective to must be on or after effective from");
      const after = (
        await db.execute<BookAccountMapRow & Record<string, unknown>>(
          sql`
        update accounting_book_account_maps set effective_to = ${effectiveTo}::date, updated_at = now(), updated_by = ${args.actorId}
         where org_id = ${args.orgId} and id = ${id} returning ${MAP_COLUMNS}`,
          "objects",
        )
      )[0];
      if (!after)
        throw new MultiBookError(
          "the account mapping changed while you were saving; reload and try again",
          409,
        );
      await audit(
        db,
        args.orgId,
        args.actorId,
        "accounting_book_account_maps",
        id,
        "update",
        current,
        after,
        reason,
      );
      return after;
    });
  } catch (error) {
    throw multiBookStorageRefusal(error) ?? error;
  }
}
