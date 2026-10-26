/**
 * Book-specific account mapping: an effective-dated mapping from a primary
 * chart account to the account a secondary book carries it in, for one book
 * and optionally one subsidiary. Mappings apply wherever entries are
 * replicated or generated into the book (postEntry applies them to every
 * non-primary posting), so the book's ledger never carries the mapped source
 * account inside a mapping's window.
 *
 * A mapping must keep the account's statement class (an asset stays an
 * asset, revenue stays revenue), honour currency restrictions, and post only
 * where the target account is available to the line's subsidiary. The same
 * rules refuse a mapping when it is configured and again when it is applied,
 * so an account changed after configuration cannot slip through.
 */
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { ACCOUNT_CLASS_TYPES, type AccountClassKey } from "../records/account-types.ts";
import {
  loadSubsidiaryContext,
  restrictionAdmits,
  type SubsidiaryContext,
} from "../organization/subsidiaries.ts";

export class BookAccountMapError extends Error {
  override readonly name = "BookAccountMapError";
}

/** The account facts a mapping is judged on. */
export interface MappableAccount {
  id: string;
  label: string;
  type: string;
  isActive: boolean;
  isSummary: boolean;
  currencyRestriction: string | null;
  subsidiaryId: string | null;
  subsidiaryIncludeChildren: boolean;
}

/** The statement class an account type belongs to, or null for a type outside the classes. */
export function accountClassOf(type: string): AccountClassKey | null {
  for (const [key, types] of Object.entries(ACCOUNT_CLASS_TYPES) as [
    AccountClassKey,
    readonly string[],
  ][]) {
    if (types.includes(type)) return key;
  }
  return null;
}

/**
 * Why `source` may not be carried as `target` in a book, or null when the
 * mapping is compatible. Pure, so configuration and posting share it.
 */
export function bookAccountMapRefusal(
  source: MappableAccount,
  target: MappableAccount,
): string | null {
  if (source.id === target.id) return `${source.label} cannot map to itself`;
  if (target.isSummary) return `${target.label} is a summary account and cannot be posted to`;
  if (!target.isActive)
    return `${target.label} is inactive — reactivate it or map ${source.label} to an active account`;
  const sourceClass = accountClassOf(source.type);
  const targetClass = accountClassOf(target.type);
  if (sourceClass === null || targetClass === null) {
    if (source.type !== target.type)
      return `${source.label} (${source.type}) can only map to an account of the same type`;
  } else if (sourceClass !== targetClass) {
    return `${source.label} is ${sourceClass} and ${target.label} is ${targetClass} — a book mapping keeps the account's statement class`;
  }
  if (target.currencyRestriction && target.currencyRestriction !== source.currencyRestriction) {
    return `${target.label} only accepts ${target.currencyRestriction} postings, but ${source.label} ${source.currencyRestriction ? `is restricted to ${source.currencyRestriction}` : "accepts any currency"}`;
  }
  return null;
}

/**
 * Whether `target` is available everywhere the mapping applies: to the
 * mapping's subsidiary, or (for an organization-wide mapping) to every
 * subsidiary the source account admits.
 */
export function bookAccountMapScopeRefusal(
  ctx: SubsidiaryContext,
  source: MappableAccount,
  target: MappableAccount,
  subsidiaryId: string | null,
): string | null {
  const scope = subsidiaryId
    ? [subsidiaryId]
    : [...ctx.byId.values()]
        .filter(
          (sub) =>
            !sub.isElimination &&
            restrictionAdmits(ctx, source.subsidiaryId, source.subsidiaryIncludeChildren, sub.id),
        )
        .map((sub) => sub.id);
  for (const sub of scope) {
    if (!restrictionAdmits(ctx, target.subsidiaryId, target.subsidiaryIncludeChildren, sub)) {
      const name = ctx.byId.get(sub)?.name ?? sub;
      return `${target.label} is not available to subsidiary "${name}"${subsidiaryId ? "" : ", which the organization-wide mapping covers"} — choose an account available there or scope the mapping to a subsidiary`;
    }
  }
  return null;
}

export async function loadMappableAccounts(
  runner: SqlExecutor,
  orgId: string,
  ids: readonly string[],
): Promise<Map<string, MappableAccount>> {
  if (ids.length === 0) return new Map();
  const rows = await runner.execute<{
    id: string;
    number: string | null;
    name: string;
    type: string;
    is_active: boolean;
    is_summary: boolean;
    currency_restriction: string | null;
    subsidiary_id: string | null;
    subsidiary_include_children: boolean;
  }>(
    sql`
    select id, number, name, type, is_active, is_summary, currency_restriction,
           subsidiary_id, subsidiary_include_children
      from accounts
     where org_id = ${orgId} and id = any(${`{${[...new Set(ids)].join(",")}}`}::uuid[])`,
    "objects",
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        label: [row.number, row.name].filter(Boolean).join(" "),
        type: row.type,
        isActive: row.is_active,
        isSummary: row.is_summary,
        currencyRestriction: row.currency_restriction,
        subsidiaryId: row.subsidiary_id,
        subsidiaryIncludeChildren: row.subsidiary_include_children,
      },
    ]),
  );
}

export interface AppliedBookAccountMap {
  mapId: string;
  subsidiaryId: string;
  sourceAccountId: string;
  targetAccountId: string;
}

/**
 * Redirect each line's account through the book's mappings in effect on
 * `postingDate`. A subsidiary-specific mapping wins over an
 * organization-wide one. Every mapped line is re-validated against the
 * mapping rules and the line's subsidiary; any refusal refuses the posting.
 */
export async function applyBookAccountMaps<T extends { accountId: string; subsidiaryId: string }>(
  runner: SqlExecutor,
  args: {
    orgId: string;
    bookId: string;
    bookLabel: string;
    postingDate: string;
    entryLabel: string;
    lines: readonly T[];
  },
): Promise<{ lines: T[]; applied: AppliedBookAccountMap[] }> {
  const sourceIds = [...new Set(args.lines.map((line) => line.accountId))];
  if (sourceIds.length === 0) return { lines: [...args.lines], applied: [] };
  const maps = await runner.execute<{
    id: string;
    subsidiary_id: string | null;
    source_account_id: string;
    target_account_id: string;
  }>(
    sql`
    select id, subsidiary_id, source_account_id, target_account_id
      from accounting_book_account_maps
     where org_id = ${args.orgId} and book_id = ${args.bookId}
       and source_account_id = any(${`{${sourceIds.join(",")}}`}::uuid[])
       and effective_from <= ${args.postingDate}::date
       and (effective_to is null or effective_to >= ${args.postingDate}::date)`,
    "objects",
  );
  if (maps.length === 0) return { lines: [...args.lines], applied: [] };
  const pick = (accountId: string, subsidiaryId: string) =>
    maps.find((map) => map.source_account_id === accountId && map.subsidiary_id === subsidiaryId) ??
    maps.find((map) => map.source_account_id === accountId && map.subsidiary_id === null);
  const accounts = await loadMappableAccounts(runner, args.orgId, [
    ...maps.map((map) => map.source_account_id),
    ...maps.map((map) => map.target_account_id),
  ]);
  let ctx: SubsidiaryContext | null = null;
  const applied: AppliedBookAccountMap[] = [];
  const lines: T[] = [];
  for (const line of args.lines) {
    const map = pick(line.accountId, line.subsidiaryId);
    if (!map) {
      lines.push(line);
      continue;
    }
    const source = accounts.get(map.source_account_id);
    const target = accounts.get(map.target_account_id);
    if (!source || !target) {
      throw new BookAccountMapError(
        `${args.entryLabel}: book ${args.bookLabel} maps an account that no longer exists in this organization`,
      );
    }
    const refusal = bookAccountMapRefusal(source, target);
    if (refusal)
      throw new BookAccountMapError(
        `${args.entryLabel}: book ${args.bookLabel} account mapping refused — ${refusal}`,
      );
    ctx ??= await loadSubsidiaryContext(runner, args.orgId);
    if (
      !restrictionAdmits(
        ctx,
        target.subsidiaryId,
        target.subsidiaryIncludeChildren,
        line.subsidiaryId,
      )
    ) {
      const name = ctx.byId.get(line.subsidiaryId)?.name ?? line.subsidiaryId;
      throw new BookAccountMapError(
        `${args.entryLabel}: book ${args.bookLabel} maps ${source.label} to ${target.label}, which is not available to subsidiary "${name}" — correct the mapping in the book's account mappings`,
      );
    }
    lines.push({ ...line, accountId: target.id });
    applied.push({
      mapId: map.id,
      subsidiaryId: line.subsidiaryId,
      sourceAccountId: source.id,
      targetAccountId: target.id,
    });
  }
  return { lines, applied };
}
