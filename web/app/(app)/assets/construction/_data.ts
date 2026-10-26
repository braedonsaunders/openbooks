import "server-only";
import { getTranslations } from "next-intl/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import {
  cipReconciliation,
  listCipCandidateLines,
  type CipCandidateLine,
  type CipReconciliationRow,
} from "@openbooks/engine/assets/asset-cip";
import { can, requirePermission } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { isFeatureEnabled } from "@/lib/features";
import { isUuid, pickString } from "@/lib/list-params";
import { ASSET_TYPES, PNL_COST_TYPES } from "@/lib/account-types";
import { subsidiaryVisibleFilter } from "@/lib/subsidiaries";
import { loadAssetWorkspaceTabs } from "../tabs-loader";

/** Noncurrent asset types a construction-in-progress account may have (the engine refuses others). */
const CIP_ACCOUNT_TYPES = ASSET_TYPES.filter(
  (type) => type === "asset_fixed" || type === "asset_other",
);

export interface CipRecordRow {
  id: string;
  assetNumber: string;
  name: string;
  status: "construction" | "capitalized";
  subsidiaryId: string;
  subsidiaryName: string;
  accountLabel: string;
  linked: string;
  capitalized: string;
  expensed: string;
  open: string;
}

export interface CipDetail extends CipRecordRow {
  costs: {
    id: string;
    entryId: string;
    entryNumber: string;
    postingDate: string;
    amount: string;
    memo: string | null;
    status: "linked" | "unlinked";
    unlinkReason: string | null;
    fromAcceptance: boolean;
  }[];
  candidates: CipCandidateLine[];
  capitalizations: {
    id: string;
    capitalizedOn: string;
    entryId: string;
    capitalized: string;
    expensed: string;
    reason: string;
    status: "posted" | "reversed";
    lines: {
      kind: "asset" | "component" | "expense";
      assetId: string | null;
      assetNumber: string | null;
      amount: string;
    }[];
  }[];
}

export interface ConstructionData {
  title: string;
  description: string;
  tabs: { key: string; href: string; label: string; active: boolean }[];
  currentParams: Record<string, string | string[] | undefined>;
  tab: "records" | "reconciliation";
  today: string;
  asOf: string;
  rows: CipRecordRow[];
  reconciliation: (CipReconciliationRow & { subsidiaryName: string })[];
  selected: CipDetail | null;
  createMode: boolean;
  canCapitalize: boolean;
  componentsEnabled: boolean;
  subsidiaries: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  cipAccounts: { id: string; label: string }[];
  expenseAccounts: { id: string; label: string }[];
  parents: { id: string; label: string; subsidiaryId: string }[];
}

const scoped = (column: SQL, allowed: Set<string> | null) =>
  allowed ? sql`and ${column} = any(${`{${[...allowed].join(",")}}`}::uuid[])` : sql``;

async function records(
  orgId: string,
  allowed: Set<string> | null,
  id?: string,
): Promise<CipRecordRow[]> {
  const rows = await db.execute<{
    id: string;
    asset_number: string;
    name: string;
    status: "construction" | "capitalized";
    subsidiary_id: string;
    subsidiary_name: string;
    account_label: string;
    linked: string;
    capitalized: string;
    expensed: string;
    open: string;
  }>(
    sql`
    select a.id, a.asset_number, a.name, a.status, a.subsidiary_id, s.name as subsidiary_name,
           concat_ws(' · ', acct.number, acct.name) as account_label,
           coalesce((select sum(c.amount) from asset_cip_costs c where c.org_id = a.org_id and c.cip_asset_id = a.id and c.status = 'linked'), 0)::text as linked,
           coalesce((select sum(k.capitalized_amount) from asset_cip_capitalizations k where k.org_id = a.org_id and k.cip_asset_id = a.id and k.status = 'posted'), 0)::text as capitalized,
           coalesce((select sum(k.expensed_amount) from asset_cip_capitalizations k where k.org_id = a.org_id and k.cip_asset_id = a.id and k.status = 'posted'), 0)::text as expensed,
           a.acquisition_cost::text as open
      from fixed_assets a
      join subsidiaries s on s.org_id = a.org_id and s.id = a.subsidiary_id
      left join accounts acct on acct.org_id = a.org_id and acct.id = a.asset_account_id
     where a.org_id = ${orgId} and a.status in ('construction', 'capitalized')
       ${id ? sql`and a.id = ${id}` : sql``}
       ${scoped(sql`a.subsidiary_id`, allowed)}
     order by a.status, a.asset_number
     limit 500`,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    assetNumber: row.asset_number,
    name: row.name,
    status: row.status,
    subsidiaryId: row.subsidiary_id,
    subsidiaryName: row.subsidiary_name,
    accountLabel: row.account_label,
    linked: row.linked,
    capitalized: row.capitalized,
    expensed: row.expensed,
    open: row.open,
  }));
}

export async function loadConstruction(
  sp: Record<string, string | string[] | undefined>,
): Promise<ConstructionData> {
  const authz = await requirePermission("assets.read");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "constructionInProgress");
  const t = await getTranslations("assets");
  const allowed = authz.allowedSubsidiaryIds;
  const scope = allowed ? [...allowed] : null;
  const today = await businessToday(orgId);
  const requestedAsOf = pickString(sp.asOf);
  const asOf = requestedAsOf && isIsoCalendarDate(requestedAsOf) ? requestedAsOf : today;
  const tab = pickString(sp.tab) === "reconciliation" ? "reconciliation" : "records";
  const [
    rows,
    recon,
    componentsEnabled,
    subsidiaries,
    categories,
    cipAccounts,
    expenseAccounts,
    parents,
  ] = await Promise.all([
    records(orgId, allowed),
    tab === "reconciliation"
      ? cipReconciliation(orgId, { asOf, allowedSubsidiaryIds: scope })
      : Promise.resolve([]),
    isFeatureEnabled(orgId, "assetComponents"),
    db.execute<{ id: string; name: string }>(
      sql`
      select id, name from subsidiaries where org_id = ${orgId} and is_active and not is_elimination ${scoped(sql`id`, allowed)} order by name`,
      "objects",
    ),
    db.execute<{ id: string; name: string }>(
      sql`
      select id, name from asset_categories where org_id = ${orgId} and is_active and asset_account_id is not null order by name`,
      "objects",
    ),
    db.execute<{ id: string; label: string }>(
      sql`
      select id, concat_ws(' · ', number, name) as label from accounts
       where org_id = ${orgId} and is_active and not is_summary and type = any(${`{${CIP_ACCOUNT_TYPES.join(",")}}`}::text[])
         ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })}
       order by number nulls last`,
      "objects",
    ),
    db.execute<{ id: string; label: string }>(
      sql`
      select id, concat_ws(' · ', number, name) as label from accounts
       where org_id = ${orgId} and is_active and not is_summary and type = any(${`{${PNL_COST_TYPES.join(",")}}`}::text[])
         ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })}
       order by number nulls last`,
      "objects",
    ),
    db.execute<{ id: string; label: string; subsidiary_id: string }>(
      sql`
      select id, concat_ws(' · ', asset_number, name) as label, subsidiary_id from fixed_assets
       where org_id = ${orgId} and parent_asset_id is null and status in ('draft', 'in_service', 'fully_depreciated')
         ${scoped(sql`subsidiary_id`, allowed)}
       order by asset_number limit 1000`,
      "objects",
    ),
  ]);
  const names = new Map(subsidiaries.map((row) => [row.id, row.name]));
  let selected: CipDetail | null = null;
  const selectedId = pickString(sp.cip);
  if (selectedId && isUuid(selectedId)) {
    const [record] = await records(orgId, allowed, selectedId);
    if (record) {
      const [costs, capitalizations, candidates] = await Promise.all([
        db.execute<{
          id: string;
          entry_id: string;
          entry_number: string;
          posting_date: string;
          amount: string;
          memo: string | null;
          status: "linked" | "unlinked";
          unlink_reason: string | null;
          from_acceptance: boolean;
        }>(
          sql`
          select c.id, c.source_entry_id as entry_id, je.entry_number, c.posting_date::text as posting_date, c.amount::text as amount,
                 c.memo, c.status, c.unlink_reason,
                 exists (select 1 from asset_proposal_allocations al where al.org_id = c.org_id and al.cip_cost_id = c.id) as from_acceptance
            from asset_cip_costs c
            join journal_entries je on je.org_id = c.org_id and je.id = c.source_entry_id
           where c.org_id = ${orgId} and c.cip_asset_id = ${record.id}
           order by c.status, c.posting_date, je.entry_number`,
          "objects",
        ),
        db.execute<{
          id: string;
          capitalized_on: string;
          entry_id: string;
          capitalized_amount: string;
          expensed_amount: string;
          reason: string;
          status: "posted" | "reversed";
          lines: CipDetail["capitalizations"][number]["lines"];
        }>(
          sql`
          select k.id, k.capitalized_on::text as capitalized_on, k.entry_id, k.capitalized_amount::text as capitalized_amount,
                 k.expensed_amount::text as expensed_amount, k.reason, k.status,
                 coalesce((select jsonb_agg(jsonb_build_object('kind', l.kind, 'assetId', l.asset_id, 'assetNumber', l.asset_number, 'amount', l.amount::text) order by l.line_number)
                             from asset_cip_capitalization_lines l where l.org_id = k.org_id and l.capitalization_id = k.id), '[]'::jsonb) as lines
            from asset_cip_capitalizations k
           where k.org_id = ${orgId} and k.cip_asset_id = ${record.id}
           order by k.capitalized_on desc, k.created_at desc`,
          "objects",
        ),
        record.status === "construction"
          ? listCipCandidateLines(orgId, { cipAssetId: record.id, allowedSubsidiaryIds: scope })
          : Promise.resolve([]),
      ]);
      selected = {
        ...record,
        costs: costs.map((row) => ({
          id: row.id,
          entryId: row.entry_id,
          entryNumber: row.entry_number,
          postingDate: row.posting_date,
          amount: row.amount,
          memo: row.memo,
          status: row.status,
          unlinkReason: row.unlink_reason,
          fromAcceptance: row.from_acceptance,
        })),
        candidates,
        capitalizations: capitalizations.map((row) => ({
          id: row.id,
          capitalizedOn: row.capitalized_on,
          entryId: row.entry_id,
          capitalized: row.capitalized_amount,
          expensed: row.expensed_amount,
          reason: row.reason,
          status: row.status,
          lines: row.lines,
        })),
      };
    }
  }
  const canCapitalize = can(authz, "assets.capitalize");
  return {
    title: t("construction.title"),
    description: t("construction.description"),
    tabs: await loadAssetWorkspaceTabs(orgId, "construction", {
      register: t("tabs.register"),
      taxDepreciation: t("tabs.taxDepreciation"),
      equipment: t("equipment.title"),
      proposals: t("proposals.title"),
      construction: t("construction.title"),
      leases: t("leases.pageTitle"),
      maintenance: t("maintenance.title"),
      insurance: t("insurance.title"),
    }),
    currentParams: sp,
    tab,
    today,
    asOf,
    rows,
    reconciliation: recon.map((row) => ({
      ...row,
      subsidiaryName: names.get(row.subsidiaryId) ?? "",
    })),
    selected,
    createMode: pickString(sp.cip) === "new" && canCapitalize,
    canCapitalize,
    componentsEnabled,
    subsidiaries,
    categories,
    cipAccounts,
    expenseAccounts,
    parents: parents.map((row) => ({
      id: row.id,
      label: row.label,
      subsidiaryId: row.subsidiary_id,
    })),
  };
}
