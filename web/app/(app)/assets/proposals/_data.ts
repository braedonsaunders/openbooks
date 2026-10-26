import "server-only";
import { getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { can, requirePermission } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { isFeatureEnabled } from "@/lib/features";
import { isUuid, pickString } from "@/lib/list-params";
import { loadAssetWorkspaceTabs } from "../tabs-loader";

export const PROPOSAL_STATUSES = ["pending", "accepted", "rejected", "voided"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface ProposalRow {
  id: string;
  status: ProposalStatus;
  origin: "rule" | "manual";
  postingDate: string;
  amount: string;
  currency: string;
  quantity: string | null;
  description: string | null;
  accountLabel: string;
  vendorName: string | null;
  sourceLabel: string;
  sourceEntryId: string;
  sourceDocumentId: string | null;
  ruleName: string | null;
  suggestedCategoryId: string | null;
  subsidiaryId: string;
  subsidiaryName: string;
  resolutionReason: string | null;
  acceptance: {
    id: string;
    operation: string;
    status: "posted" | "reversed";
    acceptedOn: string;
    reclassEntryId: string | null;
    assets: { id: string | null; assetNumber: string; amount: string }[];
  } | null;
}

export interface ProposalsData {
  title: string;
  description: string;
  tabs: { key: string; href: string; label: string; active: boolean }[];
  currentParams: Record<string, string | string[] | undefined>;
  status: ProposalStatus | "all";
  rows: ProposalRow[];
  selected: ProposalRow | null;
  today: string;
  canCapitalize: boolean;
  componentsEnabled: boolean;
  cipEnabled: boolean;
  categories: { id: string; name: string }[];
  parents: { id: string; label: string; subsidiaryId: string }[];
  cipRecords: { id: string; label: string; subsidiaryId: string }[];
  hasRules: boolean;
}

const scope = (column: ReturnType<typeof sql.raw>, allowed: Set<string> | null) =>
  allowed ? sql`and ${column} = any(${`{${[...allowed].join(",")}}`}::uuid[])` : sql``;

export async function loadProposals(
  sp: Record<string, string | string[] | undefined>,
): Promise<ProposalsData> {
  const authz = await requirePermission("assets.read");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "assetProposals");
  const t = await getTranslations("assets");
  const requested = pickString(sp.status);
  const status =
    requested === "all" || (PROPOSAL_STATUSES as readonly string[]).includes(requested ?? "")
      ? (requested as ProposalStatus | "all")
      : "pending";
  const allowed = authz.allowedSubsidiaryIds;
  const [rows, today, componentsEnabled, cipEnabled, categories, parents, cipRecords, rules] =
    await Promise.all([
      db.execute<{
        id: string;
        status: ProposalStatus;
        origin: "rule" | "manual";
        posting_date: string;
        amount: string;
        currency: string;
        quantity: string | null;
        description: string | null;
        account_label: string;
        vendor_name: string | null;
        source_label: string;
        source_entry_id: string;
        source_document_id: string | null;
        rule_name: string | null;
        suggested_category_id: string | null;
        subsidiary_id: string;
        subsidiary_name: string;
        resolution_reason: string | null;
        acceptance_id: string | null;
        operation: string | null;
        acceptance_status: "posted" | "reversed" | null;
        accepted_on: string | null;
        reclass_entry_id: string | null;
        assets: { id: string | null; assetNumber: string; amount: string }[] | null;
      }>(
        sql`
      select p.id, p.status, p.origin, p.posting_date::text as posting_date, p.amount::text as amount, p.currency,
             p.quantity::text as quantity, p.description,
             concat_ws(' · ', acct.number, acct.name) as account_label, vendor.display_name as vendor_name,
             coalesce(d.document_number, je.entry_number) as source_label, p.source_entry_id, p.source_document_id,
             r.name as rule_name, p.suggested_category_id, p.subsidiary_id, s.name as subsidiary_name, p.resolution_reason,
             ac.id as acceptance_id, ac.operation, ac.status as acceptance_status, ac.accepted_on::text as accepted_on,
             ac.reclass_entry_id,
             (select jsonb_agg(jsonb_build_object('id', al.asset_id, 'assetNumber', al.asset_number, 'amount', al.amount::text) order by al.asset_number)
                from asset_proposal_allocations al where al.org_id = p.org_id and al.proposal_id = p.id and al.acceptance_id = ac.id) as assets
        from asset_proposals p
        join accounts acct on acct.org_id = p.org_id and acct.id = p.account_id
        join journal_entries je on je.org_id = p.org_id and je.id = p.source_entry_id
        join subsidiaries s on s.org_id = p.org_id and s.id = p.subsidiary_id
        left join documents d on d.org_id = p.org_id and d.id = p.source_document_id
        left join parties vendor on vendor.org_id = p.org_id and vendor.id = p.vendor_party_id
        left join asset_capitalization_rules r on r.org_id = p.org_id and r.id = p.rule_id
        left join asset_proposal_acceptances ac on ac.org_id = p.org_id and ac.id = p.acceptance_id
       where p.org_id = ${orgId}
         ${status === "all" ? sql`` : sql`and p.status = ${status}`}
         ${scope(sql.raw("p.subsidiary_id"), allowed)}
       order by p.posting_date desc, p.id desc
       limit 500`,
        "objects",
      ),
      businessToday(orgId),
      isFeatureEnabled(orgId, "assetComponents"),
      isFeatureEnabled(orgId, "constructionInProgress"),
      db.execute<{ id: string; name: string }>(
        sql`
      select id, name from asset_categories where org_id = ${orgId} and is_active and asset_account_id is not null order by name`,
        "objects",
      ),
      db.execute<{ id: string; label: string; subsidiary_id: string }>(
        sql`
      select id, concat_ws(' · ', asset_number, name) as label, subsidiary_id from fixed_assets
       where org_id = ${orgId} and parent_asset_id is null and status in ('draft', 'in_service', 'fully_depreciated')
         ${scope(sql.raw("subsidiary_id"), allowed)}
       order by asset_number limit 1000`,
        "objects",
      ),
      db.execute<{ id: string; label: string; subsidiary_id: string }>(
        sql`
      select id, concat_ws(' · ', asset_number, name) as label, subsidiary_id from fixed_assets
       where org_id = ${orgId} and status = 'construction' ${scope(sql.raw("subsidiary_id"), allowed)}
       order by asset_number limit 500`,
        "objects",
      ),
      db.execute<{ n: number }>(
        sql`select count(*)::int as n from asset_capitalization_rules where org_id = ${orgId} and is_active`,
        "objects",
      ),
    ]);
  const mapped: ProposalRow[] = rows.map((row) => ({
    id: row.id,
    status: row.status,
    origin: row.origin,
    postingDate: row.posting_date,
    amount: row.amount,
    currency: row.currency,
    quantity: row.quantity,
    description: row.description,
    accountLabel: row.account_label,
    vendorName: row.vendor_name,
    sourceLabel: row.source_label,
    sourceEntryId: row.source_entry_id,
    sourceDocumentId: row.source_document_id,
    ruleName: row.rule_name,
    suggestedCategoryId: row.suggested_category_id,
    subsidiaryId: row.subsidiary_id,
    subsidiaryName: row.subsidiary_name,
    resolutionReason: row.resolution_reason,
    acceptance: row.acceptance_id
      ? {
          id: row.acceptance_id,
          operation: row.operation ?? "asset",
          status: row.acceptance_status ?? "posted",
          acceptedOn: row.accepted_on ?? row.posting_date,
          reclassEntryId: row.reclass_entry_id,
          assets: row.assets ?? [],
        }
      : null,
  }));
  const selectedId = pickString(sp.proposal);
  let selected = mapped.find((row) => row.id === selectedId) ?? null;
  if (!selected && selectedId && isUuid(selectedId)) {
    // A proposal outside the current status filter still opens from a link.
    const all = await loadProposals({ ...sp, status: "all", proposal: undefined });
    selected = all.rows.find((row) => row.id === selectedId) ?? null;
  }
  return {
    title: t("proposals.title"),
    description: t("proposals.description"),
    tabs: await loadAssetWorkspaceTabs(orgId, "proposals", {
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
    status,
    rows: mapped,
    selected,
    today,
    canCapitalize: can(authz, "assets.capitalize"),
    componentsEnabled,
    cipEnabled,
    categories,
    parents: parents.map((row) => ({
      id: row.id,
      label: row.label,
      subsidiaryId: row.subsidiary_id,
    })),
    cipRecords: cipRecords.map((row) => ({
      id: row.id,
      label: row.label,
      subsidiaryId: row.subsidiary_id,
    })),
    hasRules: (rules[0]?.n ?? 0) > 0,
  };
}
