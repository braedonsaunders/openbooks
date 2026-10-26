import "server-only";
import { getTranslations } from "next-intl/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  insuredValueComparison,
  type InsuredValueRow,
} from "@openbooks/engine/assets/asset-insurance";
import { can, requirePermission } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { isUuid, pickString } from "@/lib/list-params";
import { subsidiaryVisibleFilter } from "@/lib/subsidiaries";
import { loadAssetWorkspaceTabs } from "../tabs-loader";

export interface PolicyRow {
  id: string;
  policyNumber: string;
  insurerPartyId: string;
  insurerName: string;
  subsidiaryId: string;
  subsidiaryName: string;
  description: string | null;
  coverageStartsOn: string;
  coverageEndsOn: string;
  premium: string;
  deductible: string;
  currency: string;
  renewalLeadDays: number;
  status: "active" | "cancelled";
  updatedAt: string;
  covered: number;
  insuredTotal: string;
  renewed: boolean;
}

export interface PolicyDetail extends PolicyRow {
  coverages: {
    assetId: string;
    assetNumber: string;
    assetName: string;
    insuredValue: string;
    replacementValue: string | null;
  }[];
}

export interface InsuranceData {
  title: string;
  description: string;
  tabs: { key: string; href: string; label: string; active: boolean }[];
  currentParams: Record<string, string | string[] | undefined>;
  tab: "policies" | "values";
  today: string;
  rows: PolicyRow[];
  comparison: InsuredValueRow[];
  selected: PolicyDetail | null;
  createMode: boolean;
  canMaintain: boolean;
  subsidiaries: { id: string; name: string }[];
  insurers: { id: string; name: string }[];
  assets: { id: string; label: string; subsidiaryId: string }[];
}

const scoped = (column: SQL, allowed: Set<string> | null) =>
  allowed ? sql`and ${column} = any(${`{${[...allowed].join(",")}}`}::uuid[])` : sql``;

export async function loadInsurance(
  sp: Record<string, string | string[] | undefined>,
): Promise<InsuranceData> {
  const authz = await requirePermission("assets.read");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "assetInsurance");
  const t = await getTranslations("assets");
  const allowed = authz.allowedSubsidiaryIds;
  const tab = pickString(sp.tab) === "values" ? "values" : "policies";
  const today = await businessToday(orgId);
  const [rows, comparison, subsidiaries, insurers, assets] = await Promise.all([
    db.execute<{
      id: string;
      policy_number: string;
      insurer_party_id: string;
      insurer_name: string;
      subsidiary_id: string;
      subsidiary_name: string;
      description: string | null;
      coverage_starts_on: string;
      coverage_ends_on: string;
      premium: string;
      deductible: string;
      currency: string;
      renewal_lead_days: number;
      status: "active" | "cancelled";
      updated_at: string;
      covered: number;
      insured_total: string;
      renewed: boolean;
    }>(
      sql`
      select p.id, p.policy_number, p.insurer_party_id, insurer.display_name as insurer_name, p.subsidiary_id, s.name as subsidiary_name,
             p.description, p.coverage_starts_on::text as coverage_starts_on, p.coverage_ends_on::text as coverage_ends_on,
             p.premium::text as premium, p.deductible::text as deductible, p.currency, p.renewal_lead_days, p.status,
             p.updated_at::text as updated_at,
             (select count(*)::int from asset_insurance_coverages c where c.org_id = p.org_id and c.policy_id = p.id) as covered,
             coalesce((select sum(c.insured_value) from asset_insurance_coverages c where c.org_id = p.org_id and c.policy_id = p.id), 0)::text as insured_total,
             exists (select 1 from asset_insurance_policies r where r.org_id = p.org_id and r.renews_policy_id = p.id and r.status = 'active') as renewed
        from asset_insurance_policies p
        join parties insurer on insurer.org_id = p.org_id and insurer.id = p.insurer_party_id
        join subsidiaries s on s.org_id = p.org_id and s.id = p.subsidiary_id
       where p.org_id = ${orgId} ${scoped(sql`p.subsidiary_id`, allowed)}
       order by p.status, p.coverage_ends_on, p.policy_number
       limit 500`,
      "objects",
    ),
    tab === "values"
      ? insuredValueComparison(orgId, {
          asOf: today,
          allowedSubsidiaryIds: allowed ? [...allowed] : null,
        })
      : Promise.resolve([]),
    db.execute<{ id: string; name: string }>(
      sql`
      select id, name from subsidiaries where org_id = ${orgId} and is_active and not is_elimination ${scoped(sql`id`, allowed)} order by name`,
      "objects",
    ),
    db.execute<{ id: string; name: string }>(
      sql`
      select p.id, p.display_name as name from parties p
        join vendor_roles v on v.org_id = p.org_id and v.party_id = p.id
       where p.org_id = ${orgId} and p.is_active and v.is_active
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowed, { orgWideNull: true })}
       order by p.display_name limit 1000`,
      "objects",
    ),
    db.execute<{ id: string; label: string; subsidiary_id: string }>(
      sql`
      select id, concat_ws(' · ', asset_number, name) as label, subsidiary_id from fixed_assets
       where org_id = ${orgId} and status in ('draft', 'in_service', 'fully_depreciated', 'construction')
         ${scoped(sql`subsidiary_id`, allowed)}
       order by asset_number limit 2000`,
      "objects",
    ),
  ]);
  const mapped: PolicyRow[] = rows.map((row) => ({
    id: row.id,
    policyNumber: row.policy_number,
    insurerPartyId: row.insurer_party_id,
    insurerName: row.insurer_name,
    subsidiaryId: row.subsidiary_id,
    subsidiaryName: row.subsidiary_name,
    description: row.description,
    coverageStartsOn: row.coverage_starts_on,
    coverageEndsOn: row.coverage_ends_on,
    premium: row.premium,
    deductible: row.deductible,
    currency: row.currency,
    renewalLeadDays: row.renewal_lead_days,
    status: row.status,
    updatedAt: row.updated_at,
    covered: row.covered,
    insuredTotal: row.insured_total,
    renewed: row.renewed,
  }));
  let selected: PolicyDetail | null = null;
  const selectedId = pickString(sp.policy);
  const policy =
    selectedId && isUuid(selectedId) ? mapped.find((row) => row.id === selectedId) : undefined;
  if (policy) {
    const coverages = await db.execute<{
      asset_id: string;
      asset_number: string;
      asset_name: string;
      insured_value: string;
      replacement_value: string | null;
    }>(
      sql`
      select c.asset_id, a.asset_number, a.name as asset_name, c.insured_value::text as insured_value, c.replacement_value::text as replacement_value
        from asset_insurance_coverages c
        join fixed_assets a on a.org_id = c.org_id and a.id = c.asset_id
       where c.org_id = ${orgId} and c.policy_id = ${policy.id}
       order by a.asset_number`,
      "objects",
    );
    selected = {
      ...policy,
      coverages: coverages.map((row) => ({
        assetId: row.asset_id,
        assetNumber: row.asset_number,
        assetName: row.asset_name,
        insuredValue: row.insured_value,
        replacementValue: row.replacement_value,
      })),
    };
  }
  return {
    title: t("insurance.title"),
    description: t("insurance.description"),
    tabs: await loadAssetWorkspaceTabs(orgId, "insurance", {
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
    rows: mapped,
    comparison,
    selected,
    createMode: pickString(sp.policy) === "new" && can(authz, "assets.maintain"),
    canMaintain: can(authz, "assets.maintain"),
    subsidiaries,
    insurers,
    assets: assets.map((row) => ({
      id: row.id,
      label: row.label,
      subsidiaryId: row.subsidiary_id,
    })),
  };
}
