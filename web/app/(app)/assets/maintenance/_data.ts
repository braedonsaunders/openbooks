import "server-only";
import { getTranslations } from "next-intl/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  maintenanceQueue,
  type MaintenanceQueueRow,
} from "@openbooks/engine/assets/asset-maintenance";
import { can, requirePermission } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { isFeatureEnabled } from "@/lib/features";
import { isUuid, pickString } from "@/lib/list-params";
import { subsidiaryVisibleFilter } from "@/lib/subsidiaries";
import { loadAssetWorkspaceTabs } from "../tabs-loader";

export interface ScheduleDetail {
  id: string;
  assetId: string;
  assetNumber: string;
  assetName: string;
  subsidiaryId: string;
  name: string;
  description: string | null;
  intervalMonths: number | null;
  intervalUsage: string | null;
  usageUnit: string | null;
  startsOn: string;
  lastPerformedOn: string | null;
  nextDueOn: string | null;
  nextDueUsage: string | null;
  vendorPartyId: string | null;
  estimatedCost: string | null;
  leadDays: number;
  isActive: boolean;
  currentUsage: string | null;
  records: {
    id: string;
    performedOn: string;
    description: string;
    cost: string;
    treatment: "expense" | "betterment";
    usageReading: string | null;
    vendorName: string | null;
    sourceLabel: string | null;
    proposalId: string | null;
    status: "recorded" | "cancelled";
  }[];
}

export interface MaintenanceData {
  title: string;
  description: string;
  tabs: { key: string; href: string; label: string; active: boolean }[];
  currentParams: Record<string, string | string[] | undefined>;
  standing: "all" | "due" | "overdue";
  today: string;
  rows: MaintenanceQueueRow[];
  selected: ScheduleDetail | null;
  createMode: boolean;
  canMaintain: boolean;
  proposalsEnabled: boolean;
  assets: { id: string; label: string }[];
  vendors: { id: string; name: string }[];
  billLines: { id: string; label: string; subsidiaryId: string | null }[];
}

const scoped = (column: SQL, allowed: Set<string> | null) =>
  allowed ? sql`and ${column} = any(${`{${[...allowed].join(",")}}`}::uuid[])` : sql``;

export async function loadMaintenance(
  sp: Record<string, string | string[] | undefined>,
): Promise<MaintenanceData> {
  const authz = await requirePermission("assets.read");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "assetMaintenance");
  const t = await getTranslations("assets");
  const allowed = authz.allowedSubsidiaryIds;
  const scope = allowed ? [...allowed] : null;
  const requested = pickString(sp.standing);
  const standing = requested === "due" || requested === "overdue" ? requested : "all";
  const today = await businessToday(orgId);
  const [queue, proposalsEnabled, assets, vendors, billLines] = await Promise.all([
    maintenanceQueue(db, orgId, { today, allowedSubsidiaryIds: scope }),
    isFeatureEnabled(orgId, "assetProposals"),
    db.execute<{ id: string; label: string }>(
      sql`
      select id, concat_ws(' · ', asset_number, name) as label from fixed_assets
       where org_id = ${orgId} and status in ('draft', 'in_service', 'fully_depreciated', 'construction')
         ${scoped(sql`subsidiary_id`, allowed)}
       order by asset_number limit 2000`,
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
    db.execute<{ id: string; label: string; subsidiary_id: string | null }>(
      sql`
      select dl.id, concat_ws(' · ', d.document_number, coalesce(dl.description, ''), dl.amount::text) as label, d.subsidiary_id
        from document_lines dl
        join documents d on d.org_id = dl.org_id and d.id = dl.document_id
       where dl.org_id = ${orgId} and d.status = 'posted' and d.kind in ('vendor_bill', 'expense_report')
         and coalesce(d.posting_date, d.document_date) >= ${today}::date - 400
         ${allowed ? sql`and (d.subsidiary_id is null or d.subsidiary_id = any(${`{${[...allowed].join(",")}}`}::uuid[]))` : sql``}
       order by coalesce(d.posting_date, d.document_date) desc, d.document_number, dl.line_number
       limit 400`,
      "objects",
    ),
  ]);
  const rows = standing === "all" ? queue : queue.filter((row) => row.standing === standing);
  let selected: ScheduleDetail | null = null;
  const selectedId = pickString(sp.schedule);
  if (selectedId && isUuid(selectedId)) {
    const schedule = (
      await db.execute<{
        id: string;
        asset_id: string;
        asset_number: string;
        asset_name: string;
        subsidiary_id: string;
        name: string;
        description: string | null;
        interval_months: number | null;
        interval_usage: string | null;
        usage_unit: string | null;
        starts_on: string;
        last_performed_on: string | null;
        next_due_on: string | null;
        next_due_usage: string | null;
        vendor_party_id: string | null;
        estimated_cost: string | null;
        lead_days: number;
        is_active: boolean;
        current_usage: string | null;
      }>(
        sql`
      select s.id, s.asset_id, a.asset_number, a.name as asset_name, a.subsidiary_id, s.name, s.description, s.interval_months,
             s.interval_usage::text as interval_usage, s.usage_unit, s.starts_on::text as starts_on, s.last_performed_on::text as last_performed_on,
             s.next_due_on::text as next_due_on, s.next_due_usage::text as next_due_usage, s.vendor_party_id,
             s.estimated_cost::text as estimated_cost, s.lead_days, s.is_active,
             (select max(r.reading)::text from asset_usage_readings r where r.org_id = s.org_id and r.asset_id = s.asset_id and lower(r.unit) = lower(s.usage_unit)) as current_usage
        from asset_maintenance_schedules s
        join fixed_assets a on a.org_id = s.org_id and a.id = s.asset_id
       where s.org_id = ${orgId} and s.id = ${selectedId} ${scoped(sql`a.subsidiary_id`, allowed)}`,
        "objects",
      )
    )[0];
    if (schedule) {
      const records = await db.execute<{
        id: string;
        performed_on: string;
        description: string;
        cost: string;
        treatment: "expense" | "betterment";
        usage_reading: string | null;
        vendor_name: string | null;
        source_label: string | null;
        proposal_id: string | null;
        status: "recorded" | "cancelled";
      }>(
        sql`
        select r.id, r.performed_on::text as performed_on, r.description, r.cost::text as cost, r.treatment, r.usage_reading::text as usage_reading,
               v.display_name as vendor_name, d.document_number as source_label, r.proposal_id, r.status
          from asset_maintenance_records r
          left join parties v on v.org_id = r.org_id and v.id = r.vendor_party_id
          left join documents d on d.org_id = r.org_id and d.id = r.source_document_id
         where r.org_id = ${orgId} and r.asset_id = ${schedule.asset_id} and (r.schedule_id = ${schedule.id} or r.schedule_id is null)
         order by r.performed_on desc, r.created_at desc limit 200`,
        "objects",
      );
      selected = {
        id: schedule.id,
        assetId: schedule.asset_id,
        assetNumber: schedule.asset_number,
        assetName: schedule.asset_name,
        subsidiaryId: schedule.subsidiary_id,
        name: schedule.name,
        description: schedule.description,
        intervalMonths: schedule.interval_months,
        intervalUsage: schedule.interval_usage,
        usageUnit: schedule.usage_unit,
        startsOn: schedule.starts_on,
        lastPerformedOn: schedule.last_performed_on,
        nextDueOn: schedule.next_due_on,
        nextDueUsage: schedule.next_due_usage,
        vendorPartyId: schedule.vendor_party_id,
        estimatedCost: schedule.estimated_cost,
        leadDays: schedule.lead_days,
        isActive: schedule.is_active,
        currentUsage: schedule.current_usage,
        records: records.map((row) => ({
          id: row.id,
          performedOn: row.performed_on,
          description: row.description,
          cost: row.cost,
          treatment: row.treatment,
          usageReading: row.usage_reading,
          vendorName: row.vendor_name,
          sourceLabel: row.source_label,
          proposalId: row.proposal_id,
          status: row.status,
        })),
      };
    }
  }
  return {
    title: t("maintenance.title"),
    description: t("maintenance.description"),
    tabs: await loadAssetWorkspaceTabs(orgId, "maintenance", {
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
    standing,
    today,
    rows,
    selected,
    createMode: pickString(sp.schedule) === "new" && can(authz, "assets.maintain"),
    canMaintain: can(authz, "assets.maintain"),
    proposalsEnabled,
    assets,
    vendors,
    billLines: billLines.map((row) => ({
      id: row.id,
      label: row.label,
      subsidiaryId: row.subsidiary_id,
    })),
  };
}
