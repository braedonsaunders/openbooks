import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { PageHeader } from "@openbooks/ui";
import { ListPageLayout } from "../../../components/page-layout";
import { can, requirePermission } from "../../../lib/authz";
import { pickString } from "../../../lib/list-params";
import { loadFieldDefs } from "../../../lib/custom-fields";
import {
  resolveFormLayout,
  resolveListView,
} from "../../../lib/customization/resolve";
import { requirePropertyManagementFeature } from "../../../lib/property-management-gate";
import { PropertyManagementWorkspace } from "./PropertyManagementWorkspace";

export const dynamic = "force-dynamic";

export default async function PropertyManagementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const authz = await requirePermission("ar.read");
  await requirePropertyManagementFeature(authz.user.orgId);
  const orgId = authz.user.orgId;
  const sp = await searchParams;
  const allowed = authz.allowedSubsidiaryIds
    ? [...authz.allowedSubsidiaryIds]
    : null;
  const subsidiaryScope =
    allowed === null
      ? sql``
      : sql`and subsidiary_id = any(${`{${allowed.join(",")}}`}::uuid[])`;
  const documentSubsidiaryScope =
    allowed === null
      ? sql``
      : sql`and d.subsidiary_id = any(${`{${allowed.join(",")}}`}::uuid[])`;
  const fieldDefs = await loadFieldDefs("managed_properties");
  const [resolvedForm, resolvedView] = await Promise.all([
    resolveFormLayout({
      orgId,
      userId: authz.user.id,
      recordType: "property",
      userRoles: [authz.user.role],
      headerDefs: fieldDefs,
      lineDefs: [],
      explicitLayoutId: pickString(sp.form),
    }),
    resolveListView({
      orgId,
      userId: authz.user.id,
      recordType: "property",
      viewId: pickString(sp.view),
      showInListDefs: fieldDefs.filter((def) => def.config.showInList),
    }),
  ]);
  const [
    subsidiaries,
    locations,
    tenants,
    incomeAccounts,
    expenseAccounts,
    liabilityAccounts,
    bankAccounts,
    assets,
    openInvoices,
  ] = await Promise.all([
    db.execute(
      sql`select id,name,base_currency as currency from subsidiaries where org_id=${orgId} and is_active ${allowed === null ? sql`` : sql`and id = any(${`{${allowed.join(",")}}`}::uuid[])`} order by name`,
    ) as any,
    db.execute(
      sql`select id,concat_ws(' · ',code,name) as name from locations where org_id=${orgId} and is_active order by code,name`,
    ) as any,
    db.execute(
      sql`select p.id,p.display_name as name from parties p join customer_roles c on c.party_id=p.id and c.org_id=p.org_id where p.org_id=${orgId} and p.is_active and c.is_active order by p.display_name`,
    ) as any,
    db.execute(
      sql`select id,concat_ws(' · ',number,name) as name from accounts where org_id=${orgId} and is_active and not is_summary and type in ('income','income_other') order by number nulls last`,
    ) as any,
    db.execute(
      sql`select id,concat_ws(' · ',number,name) as name from accounts where org_id=${orgId} and is_active and not is_summary and type in ('expense','cogs') order by number nulls last`,
    ) as any,
    db.execute(
      sql`select id,concat_ws(' · ',number,name) as name from accounts where org_id=${orgId} and is_active and not is_summary and type='liability_current_other' order by number nulls last`,
    ) as any,
    db.execute(
      sql`select id,concat_ws(' · ',number,name) as name from accounts where org_id=${orgId} and is_active and not is_summary and type='asset_bank' order by number nulls last`,
    ) as any,
    db.execute(
      sql`select id,concat_ws(' · ',asset_number,name) as name from fixed_assets where org_id=${orgId} and status not in ('disposed','written_off') ${subsidiaryScope} order by asset_number`,
    ) as any,
    db.execute(
      sql`select d.id,d.party_id as "partyId",concat_ws(' · ',d.document_number,d.document_date::text) as name,d.open_balance as "openBalance" from documents d where d.org_id=${orgId} and d.kind='customer_invoice' and d.status='posted' and coalesce(d.open_balance,0)>0 ${documentSubsidiaryScope} order by d.document_date desc`,
    ) as any,
  ]);
  return (
    <ListPageLayout
      header={
        <PageHeader
          title="Property Management"
          description="Operate properties, leases, rent, CAM reconciliations, and tenant security deposits."
        />
      }
    >
      <PropertyManagementWorkspace
        customization={{
          layout: resolvedForm.layout,
          forms: resolvedForm.available.map(({ id, name }) => ({ id, name })),
          currentFormId: resolvedForm.row?.id ?? null,
          fieldDefs: fieldDefs as any,
          listView: resolvedView.view,
        }}
        options={{
          subsidiaries: subsidiaries.rows,
          locations: locations.rows,
          tenants: tenants.rows,
          incomeAccounts: incomeAccounts.rows,
          expenseAccounts: expenseAccounts.rows,
          liabilityAccounts: liabilityAccounts.rows,
          bankAccounts: bankAccounts.rows,
          assets: assets.rows,
          openInvoices: openInvoices.rows,
        }}
        permissions={{
          manage: can(authz, "ar.create"),
          bill: can(authz, "ar.create"),
          account: can(authz, "gl.post"),
          bulk: authz.allowedSubsidiaryIds === null,
          customize: can(authz, "admin.customization.manage"),
        }}
      />
    </ListPageLayout>
  );
}
