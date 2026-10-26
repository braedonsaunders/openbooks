import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { cmp } from "@openbooks/engine/money/money";
import { propertyManagementWorkspace } from "@openbooks/engine/property/management";
import {
  page,
  pageHeader,
  ref,
  grid,
  statTile,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { getMoneyFormatter } from "../../../lib/money-server";
import { can, requirePermission } from "../../../lib/authz";
import { mergeHref, pickString } from "../../../lib/list-params";
import { loadFieldDefs } from "../../../lib/custom-fields";
import {
  AmbiguousListViewDefaultError,
  resolveFormLayout,
  resolveListView,
} from "../../../lib/customization/resolve";
import { isFeatureEnabled } from "../../../lib/features";
import { taxCodeOptions } from "../../../lib/documents.ts";
import { requirePropertyManagementFeature } from "../../../lib/property-management-gate";
import { formatGroupedMoney, sumByCurrency } from "./portfolio-money";
import type { PropertyWorkspace } from "./types";
import type { ModuleHomeTab } from "../../../components/module-home/tab-types";
import type { CustomFieldDefClient } from "../../../components/custom-field-inputs";
import type { Option } from "./workspace-ui";

/**
 * Property management, split into a loader and a spec.
 *
 * The loader resolves the authorized portfolio and its currency-grouped KPIs
 * before rendering. One client island owns the active table and URL-backed
 * record drawers, preserving list focus and drafts while mutations refresh
 * the server snapshot. The header owns the module tabs and active action;
 * each render shows a single tab body.
 *
 * Loader work copied verbatim from page.tsx: the `ar.read` gate, the
 * `propertyManagement` feature gate (redirects to /admin/setup/features when
 * off — the layout's `notFound` gate agrees when it runs first), the
 * subsidiary scope probes, the `managed_properties` field-def load, the
 * property form-layout + list-view resolution, the `fixedAssets` /
 * `multiCurrency` probes, and the nine option queries in order. The five
 * permission flags are loader-computed booleans; Authz, org id and user id
 * never cross the spec. The client only submits mutations and cannot widen
 * the loader's organization or subsidiary scope.
 */

export interface PropertyManagementData {
  title: string;
  description: string;
  customization: {
    layout: unknown;
    forms: Array<{ id: string; name: string }>;
    currentFormId: string | null;
    fieldDefs: CustomFieldDefClient[];
    listView: unknown;
  };
  options: {
    subsidiaries: Option[];
    locations: Option[];
    tenants: Option[];
    incomeAccounts: Option[];
    expenseAccounts: Option[];
    liabilityAccounts: Option[];
    bankAccounts: Option[];
    assets: Option[];
    openInvoices: Option[];
    taxCodes: Option[];
  };
  workspace: PropertyWorkspace | null;
  activeTab: "properties" | "rentRoll" | "cam" | "depositReconciliation";
  tabs: ModuleHomeTab[];
  newPropertyHref: string;
  newCamHref: string;
  newPropertyLabel: string;
  newCamLabel: string;
  metrics: {
    occupiedUnitsLabel: string;
    occupiedUnitsValue: string;
    activeLeasesSub: string;
    monthlyBaseRentLabel: string;
    monthlyBaseRentValue: string;
    monthlyBaseRentSub: string;
    rentPastDueLabel: string;
    rentPastDueValue: string;
    rentPastDueSub: string;
    rentPastDueTone: "negative" | undefined;
    depositsHeldLabel: string;
    depositsHeldValue: string;
    depositsHeldSub: string;
  } | null;
  permissions: {
    manage: boolean;
    bill: boolean;
    account: boolean;
    bulk: boolean;
    customize: boolean;
  };
  fixedAssetsEnabled: boolean;
  multiCurrency: boolean;
  /** Named overlapping-default refusal; empty-state renders this, never a digest. */
  listViewRefusal: string | null;
  hasContent: boolean;
}

export async function loadPropertyManagement(
  sp: Record<string, string | string[] | undefined>,
): Promise<PropertyManagementData> {
  const authz = await requirePermission("ar.read");
  await requirePropertyManagementFeature(authz.user.orgId);
  const orgId = authz.user.orgId;
  const tabNames = ["properties", "rentRoll", "cam", "depositReconciliation"] as const;
  const requestedTab = pickString(sp.tab);
  const activeTab = tabNames.includes(requestedTab as (typeof tabNames)[number])
    ? (requestedTab as (typeof tabNames)[number])
    : "properties";
  const allowed = authz.allowedSubsidiaryIds ? [...authz.allowedSubsidiaryIds] : null;
  const subsidiaryScope =
    allowed === null ? sql`` : sql`and subsidiary_id = any(${`{${allowed.join(",")}}`}::uuid[])`;
  const documentSubsidiaryScope =
    allowed === null ? sql`` : sql`and d.subsidiary_id = any(${`{${allowed.join(",")}}`}::uuid[])`;
  const fieldDefs = await loadFieldDefs("managed_properties");
  const [resolvedForm, resolvedViewResult, fixedAssetsEnabled, multiCurrency] = await Promise.all([
    resolveFormLayout({
      orgId,
      userId: authz.user.id,
      recordType: "property",
      userRoles: authz.user.roles.map(({ key }) => key),
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
    }).then(
      (view) => ({ ok: true as const, view }),
      (error: unknown) => {
        // Next.js error.tsx sanitizes thrown messages to a digest. Carry the
        // named remedy as loader data so the spec can render it in-page.
        if (error instanceof AmbiguousListViewDefaultError) return { ok: false as const, error };
        throw error;
      },
    ),
    isFeatureEnabled(orgId, "fixedAssets"),
    isFeatureEnabled(orgId, "multiCurrency"),
  ]);
  if (!resolvedViewResult.ok) {
    const t = await getTranslations("entities.propertyManagement.workspace");
    return {
      title: t("title"),
      description: resolvedViewResult.error.message,
      listViewRefusal: resolvedViewResult.error.message,
      hasContent: false,
      customization: {
        layout: resolvedForm.layout,
        forms: resolvedForm.available.map(({ id, name }) => ({ id, name })),
        currentFormId: resolvedForm.row?.id ?? null,
        fieldDefs: fieldDefs as unknown as CustomFieldDefClient[],
        listView: null,
      },
      options: {
        subsidiaries: [],
        locations: [],
        tenants: [],
        incomeAccounts: [],
        expenseAccounts: [],
        liabilityAccounts: [],
        bankAccounts: [],
        assets: [],
        openInvoices: [],
        taxCodes: [],
      },
      workspace: null,
      activeTab,
      tabs: [],
      newPropertyHref: "",
      newCamHref: "",
      newPropertyLabel: t("newProperty"),
      newCamLabel: t("newCamPool"),
      metrics: null,
      permissions: {
        manage: can(authz, "ar.create"),
        bill: can(authz, "ar.create"),
        account: can(authz, "gl.post"),
        bulk: authz.allowedSubsidiaryIds === null,
        customize: can(authz, "admin.customization.manage"),
      },
      fixedAssetsEnabled,
      multiCurrency,
    };
  }
  const resolvedView = resolvedViewResult.view;
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
    taxCodes,
    workspace,
  ] = await Promise.all([
    db.execute<Option>(
      multiCurrency
        ? sql`select id,name,base_currency as currency from subsidiaries where org_id=${orgId} and is_active ${allowed === null ? sql`` : sql`and id = any(${`{${allowed.join(",")}}`}::uuid[])`} order by name`
        : sql`select id,name from subsidiaries where org_id=${orgId} and is_active ${allowed === null ? sql`` : sql`and id = any(${`{${allowed.join(",")}}`}::uuid[])`} order by name`,
      "objects",
    ),
    db.execute<Option>(
      sql`select id,concat_ws(' · ',code,name) as name from locations where org_id=${orgId} and is_active order by code,name`,
      "objects",
    ),
    db.execute<Option>(
      sql`select p.id,p.display_name as name from parties p join customer_roles c on c.party_id=p.id and c.org_id=p.org_id where p.org_id=${orgId} and p.is_active and c.is_active order by p.display_name`,
      "objects",
    ),
    db.execute<Option>(
      sql`select id,concat_ws(' · ',number,name) as name from accounts where org_id=${orgId} and is_active and not is_summary and type in ('income','income_other') order by number nulls last`,
      "objects",
    ),
    db.execute<Option>(
      sql`select id,concat_ws(' · ',number,name) as name from accounts where org_id=${orgId} and is_active and not is_summary and type in ('expense','cogs') order by number nulls last`,
      "objects",
    ),
    db.execute<Option>(
      sql`select id,concat_ws(' · ',number,name) as name from accounts where org_id=${orgId} and is_active and not is_summary and type='liability_current_other' order by number nulls last`,
      "objects",
    ),
    db.execute<Option>(
      sql`select id,concat_ws(' · ',number,name) as name from accounts where org_id=${orgId} and is_active and not is_summary and type='asset_bank' order by number nulls last`,
      "objects",
    ),
    fixedAssetsEnabled
      ? db.execute<Option>(
          sql`select id,concat_ws(' · ',asset_number,name) as name from fixed_assets where org_id=${orgId} and status not in ('disposed','written_off') ${subsidiaryScope} order by asset_number`,
          "objects",
        )
      : Promise.resolve([]),
    db.execute<Option>(
      sql`select d.id,d.party_id as "partyId",concat_ws(' · ',d.document_number,d.document_date::text) as name,d.open_balance as "openBalance" from documents d where d.org_id=${orgId} and d.kind='customer_invoice' and d.status='posted' and coalesce(d.open_balance,0)>0 ${documentSubsidiaryScope} order by d.document_date desc`,
      "objects",
    ),
    // Active tax codes for the lease-charge picker: billing honours the
    // charge's tax code, so the UI must be able to set one.
    taxCodeOptions(orgId).then((rows) =>
      rows.map((row) => ({
        id: String(row.id),
        name: [row.code, row.name].filter((part) => !!part).join(" · ") || String(row.id),
      })),
    ),
    propertyManagementWorkspace(orgId, authz.allowedSubsidiaryIds),
  ]);
  const [t, locale, moneyFormatter] = await Promise.all([
    getTranslations("entities.propertyManagement.workspace"),
    getLocale(),
    getMoneyFormatter(orgId),
  ]);
  const activeLeases = workspace.leases.filter((lease) =>
    ["active", "notice"].includes(lease.status),
  );
  const activeLeaseIds = new Set(activeLeases.map((lease) => lease.id));
  const leaseCurrency = new Map(workspace.leases.map((lease) => [lease.id, lease.currency]));
  const currencyForLease = (leaseId: string): string => {
    const currency = leaseCurrency.get(leaseId);
    if (!currency)
      throw new Error("A lease currency is required to total property management amounts.");
    return currency;
  };
  const monthlyBaseRent = sumByCurrency(
    workspace.charges
      .filter(
        (charge) =>
          activeLeaseIds.has(charge.leaseId) &&
          charge.chargeType === "base_rent" &&
          charge.effectiveFrom <= workspace.overdueAsOf &&
          (!charge.effectiveTo || charge.effectiveTo >= workspace.overdueAsOf),
      )
      .map((charge) => ({
        currency: currencyForLease(charge.leaseId),
        amount: charge.amount,
      })),
  );
  const rentPastDue = sumByCurrency(
    workspace.overdueByLease.map((row) => ({
      currency: currencyForLease(row.leaseId),
      amount: row.balance,
    })),
  );
  const depositsHeld = sumByCurrency(
    workspace.leases.map((lease) => ({
      currency: lease.currency,
      amount: lease.depositBalance ?? "0",
    })),
  );
  const count = new Intl.NumberFormat(locale);
  const tabs: ModuleHomeTab[] = tabNames.map((key) => ({
    href: mergeHref("/property-management", sp, {
      tab: key,
      property: null,
      propertyTab: null,
      unit: null,
      lease: null,
      cam: null,
      camAction: null,
    }),
    label: t(`tabs.${key}`),
    active: activeTab === key,
  }));
  return {
    title: t("title"),
    description: t("description"),
    customization: {
      layout: resolvedForm.layout,
      forms: resolvedForm.available.map(({ id, name }) => ({ id, name })),
      currentFormId: resolvedForm.row?.id ?? null,
      fieldDefs: fieldDefs as unknown as CustomFieldDefClient[],
      listView: resolvedView.view,
    },
    options: {
      subsidiaries,
      locations,
      tenants,
      incomeAccounts,
      expenseAccounts,
      liabilityAccounts,
      bankAccounts,
      assets,
      openInvoices,
      taxCodes,
    },
    workspace,
    activeTab,
    tabs,
    newPropertyHref: mergeHref("/property-management", sp, {
      tab: "properties",
      property: "new",
      propertyTab: null,
      unit: null,
      lease: null,
      cam: null,
      camAction: null,
    }),
    newCamHref: mergeHref("/property-management", sp, {
      tab: "cam",
      property: null,
      propertyTab: null,
      unit: null,
      lease: null,
      cam: "new",
      camAction: null,
    }),
    newPropertyLabel: t("newProperty"),
    newCamLabel: t("newCamPool"),
    metrics: {
      occupiedUnitsLabel: t("metrics.occupiedUnits"),
      occupiedUnitsValue: `${count.format(workspace.units.filter((unit) => unit.status === "occupied").length)} / ${count.format(workspace.units.length)}`,
      activeLeasesSub: t("metrics.activeLeasesHint", { count: activeLeases.length }),
      monthlyBaseRentLabel: t("metrics.monthlyBaseRent"),
      monthlyBaseRentValue: monthlyBaseRent.length
        ? formatGroupedMoney(monthlyBaseRent, moneyFormatter.money)
        : moneyFormatter.money("0"),
      monthlyBaseRentSub: t("metrics.currentChargesHint"),
      rentPastDueLabel: t("metrics.rentPastDue"),
      rentPastDueValue: rentPastDue.length
        ? formatGroupedMoney(rentPastDue, moneyFormatter.money)
        : moneyFormatter.money("0"),
      rentPastDueSub: t("metrics.agingHint"),
      rentPastDueTone: rentPastDue.some((part) => cmp(part.total, "0") > 0)
        ? "negative"
        : undefined,
      depositsHeldLabel: t("metrics.depositsHeld"),
      depositsHeldValue: depositsHeld.length
        ? formatGroupedMoney(depositsHeld, moneyFormatter.money)
        : moneyFormatter.money("0"),
      depositsHeldSub: t("metrics.depositLiabilityHint"),
    },
    permissions: {
      manage: can(authz, "ar.create"),
      bill: can(authz, "ar.create"),
      account: can(authz, "gl.post"),
      bulk: authz.allowedSubsidiaryIds === null,
      customize: can(authz, "admin.customization.manage"),
    },
    fixedAssetsEnabled,
    multiCurrency,
    listViewRefusal: null,
    hasContent: true,
  };
}

const f = ref<PropertyManagementData>();

export function propertyManagementSpec(data: PropertyManagementData): PageSpec {
  const actions = data.listViewRefusal
    ? []
    : [
        widget("module-home-tabs", { tabs: data.tabs }),
        ...(data.activeTab === "properties" && data.permissions.manage
          ? [
              widget("link-button", {
                href: data.newPropertyHref,
                label: data.newPropertyLabel,
                iconKey: "plus",
              }),
            ]
          : []),
        ...(data.activeTab === "cam" && data.permissions.manage
          ? [
              widget("link-button", {
                href: data.newCamHref,
                label: data.newCamLabel,
                iconKey: "plus",
              }),
            ]
          : []),
        ...(data.activeTab === "rentRoll" && data.permissions.bill && data.permissions.bulk
          ? [widget("property-management-rent-actions", {})]
          : []),
      ];
  return page({
    route: "/property-management",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center gap-2",
        actions,
      }),
    ],
    body: [
      // A computed overlapping-default refusal renders with its message
      // intact — never a success workspace, never the generic error digest.
      widgetBlock(
        "empty-state",
        {
          title: data.title,
          description: data.listViewRefusal,
        },
        f("listViewRefusal"),
      ),
      ...(data.metrics
        ? [
            grid("grid grid-cols-2 gap-3 xl:grid-cols-4", [
              statTile({
                iconKey: "building",
                accent: "teal",
                label: f("metrics.occupiedUnitsLabel"),
                value: f("metrics.occupiedUnitsValue"),
                sub: f("metrics.activeLeasesSub"),
              }),
              statTile({
                iconKey: "wallet",
                accent: "emerald",
                label: f("metrics.monthlyBaseRentLabel"),
                value: f("metrics.monthlyBaseRentValue"),
                sub: f("metrics.monthlyBaseRentSub"),
              }),
              statTile({
                iconKey: "triangle-alert",
                accent: "red",
                label: f("metrics.rentPastDueLabel"),
                value: f("metrics.rentPastDueValue"),
                sub: f("metrics.rentPastDueSub"),
                tone: f("metrics.rentPastDueTone"),
              }),
              statTile({
                iconKey: "shield-check",
                accent: "violet",
                label: f("metrics.depositsHeldLabel"),
                value: f("metrics.depositsHeldValue"),
                sub: f("metrics.depositsHeldSub"),
              }),
            ]),
          ]
        : []),
      // One active table body with URL-backed detail drawers. Its rows and
      // KPI inputs arrive from the scoped server loader above.
      widgetBlock(
        "property-management-workspace",
        {
          customization: data.customization,
          options: data.options,
          permissions: data.permissions,
          fixedAssetsEnabled: data.fixedAssetsEnabled,
          multiCurrency: data.multiCurrency,
          workspace: data.workspace,
          initialTab: data.activeTab,
        },
        f("hasContent"),
      ),
    ],
  });
}
