import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { subsidiaryVisibleFilter } from "@openbooks/engine/organization/scope";
import { NextResponse } from "next/server";
import {
  accountNameKey,
  type DuplicateAccountNameHolder,
  type DuplicateAccountNameWarning,
  DUPLICATE_ACCOUNT_NAME,
} from "../../../lib/accounts-hygiene";
import {
  loadCustomFieldAccessDefs,
  redactHiddenCustomValues,
  type CustomFieldViewer,
} from "../../../lib/custom-fields";

export interface AccountPayload {
  account: Record<string, unknown>;
  parentName: string | null;
  subsidiaryName: string | null;
  hasTransactions: boolean;
  childCount: number;
  activeChildCount: number;
}

/** Org base currency code (e.g. USD) — the only settlement currency a
 * single-currency org can carry. */
export async function orgBaseCurrency(orgId: string): Promise<string | null> {
  const result = await db.execute<{ base_currency: string | null }>(
    sql`
    select base_currency from orgs where id = ${orgId}
  `,
    "objects",
  );
  return result[0]?.base_currency ?? null;
}

/**
 * Tenant-scoped account payload used by both the list flyout and API. The
 * stored custom bag is returned unredacted: read-modify-write callers merge
 * against it, so a reader's view is applied by redactAccountCustomFields at
 * each response boundary.
 */
export async function loadAccount(
  id: string,
  orgId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<AccountPayload | null> {
  const subsidiaryScope =
    allowedSubsidiaryIds === undefined
      ? sql``
      : subsidiaryVisibleFilter(sql`a.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true });
  const childScope =
    allowedSubsidiaryIds === undefined
      ? sql``
      : subsidiaryVisibleFilter(sql`child.subsidiary_id`, allowedSubsidiaryIds, {
          orgWideNull: true,
        });
  const parentScope =
    allowedSubsidiaryIds === undefined
      ? sql``
      : subsidiaryVisibleFilter(sql`parent.subsidiary_id`, allowedSubsidiaryIds, {
          orgWideNull: true,
        });
  const transactionScope =
    allowedSubsidiaryIds === undefined
      ? sql``
      : subsidiaryVisibleFilter(sql`l.subsidiary_id`, allowedSubsidiaryIds);
  const result = await db.execute<Record<string, unknown>>(
    sql`
    select a.*,
           case when parent.id is null then null else concat_ws(' ', parent.number, parent.name) end as parent_name,
           s.name as subsidiary_name,
           exists(select 1 from journal_lines l where l.org_id = a.org_id and l.account_id = a.id ${transactionScope}) as has_transactions,
           (select count(*)::int from accounts child
             where child.org_id = a.org_id and child.parent_id = a.id ${childScope}) as child_count,
           (select count(*)::int from accounts child
             where child.org_id = a.org_id and child.parent_id = a.id and child.is_active ${childScope}) as active_child_count
      from accounts a
      left join accounts parent on parent.id = a.parent_id and parent.org_id = a.org_id ${parentScope}
      left join subsidiaries s on s.id = a.subsidiary_id and s.org_id = a.org_id
     where a.id = ${id} and a.org_id = ${orgId} ${subsidiaryScope}
  `,
    "objects",
  );
  const row = result[0];
  if (!row) return null;
  const {
    parent_name,
    subsidiary_name,
    has_transactions,
    child_count,
    active_child_count,
    ...account
  } = row;
  return {
    account,
    parentName: (parent_name as string | null) ?? null,
    subsidiaryName: (subsidiary_name as string | null) ?? null,
    hasTransactions: has_transactions === true,
    childCount: Number(child_count ?? 0),
    activeChildCount: Number(active_child_count ?? 0),
  };
}

/** The account payload as the reader may see it: restricted custom values removed. */
export async function redactAccountCustomFields(
  payload: AccountPayload,
  viewer: CustomFieldViewer,
): Promise<AccountPayload> {
  if (!("custom" in payload.account)) return payload;
  const defs = await loadCustomFieldAccessDefs("accounts");
  return {
    ...payload,
    account: {
      ...payload.account,
      custom: redactHiddenCustomValues(
        defs,
        viewer,
        payload.account.custom as Record<string, unknown> | null,
      ),
    },
  };
}

/**
 * Active accounts whose name matches `name` (case- and whitespace-insensitive)
 * in a subsidiary scope that overlaps the target's. The shared chart overlaps
 * every subsidiary, so a shared target conflicts with any subsidiary account of
 * the same name, and a subsidiary target conflicts with shared and same-entity
 * accounts only. Rows outside the caller's visible scope are never returned, so
 * the refusal cannot disclose a hidden account. Callers hold the name advisory
 * lock (accountNameLock) before reading, so two concurrent writes serialize.
 */
export async function findNamedAccounts(
  executor: Pick<typeof db, "execute">,
  opts: {
    orgId: string;
    name: string;
    subsidiaryId: string | null;
    excludeId?: string | null;
    allowedSubsidiaryIds?: ReadonlySet<string> | null;
  },
): Promise<DuplicateAccountNameHolder[]> {
  const excludeId = opts.excludeId ?? null;
  const subsidiaryId = opts.subsidiaryId ?? null;
  const visible =
    opts.allowedSubsidiaryIds === undefined
      ? sql``
      : subsidiaryVisibleFilter(sql`a.subsidiary_id`, opts.allowedSubsidiaryIds, {
          orgWideNull: true,
        });
  const result = await executor.execute<{ id: string; number: string | null; name: string }>(
    sql`
    select a.id, a.number, a.name
      from accounts a
     where a.org_id = ${opts.orgId}
       and a.is_active
       and lower(btrim(regexp_replace(a.name, '[[:space:]]+', ' ', 'g'))) = ${accountNameKey(opts.name)}
       and (${excludeId}::uuid is null or a.id <> ${excludeId}::uuid)
       and (${subsidiaryId}::uuid is null or a.subsidiary_id is null or a.subsidiary_id = ${subsidiaryId}::uuid)
       ${visible}
     order by a.number nulls last, a.name
     limit 5
  `,
    "objects",
  );
  return result;
}

/** Transaction-scoped advisory lock keyed by org and normalized account name. */
export function accountNameLock(orgId: string, name: string) {
  return sql`select pg_advisory_xact_lock(hashtextextended(${`accounts-name:${orgId}:${accountNameKey(name)}`}, 0))`;
}

/**
 * The 409 refusal for an unacknowledged duplicate name. It names the holding
 * account so the drawer can offer to open it instead of creating a second one.
 */
export function duplicateNameRefusal(warning: DuplicateAccountNameWarning): NextResponse {
  return NextResponse.json(
    {
      error: DUPLICATE_ACCOUNT_NAME,
      field: "name",
      remedy:
        "Open the existing account, or resend the request with acknowledgeDuplicateName set to true to create it anyway.",
      details: {
        existingAccountId: warning.existingAccountId,
        existingAccountName: warning.existingAccountName,
        existingAccountNumber: warning.existingAccountNumber,
      },
    },
    { status: 409 },
  );
}
