import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/database";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { DOC_KINDS } from "../../../../lib/document-kinds";
import { accountOptions, taxCodeOptions } from "../../../../lib/documents";
import { listScopedPartyOptions } from "../../../../lib/scoped-options";
import {
  isMultiSubsidiary,
  subsidiaryOptions,
  subsidiaryVisibleFilter,
} from "../../../../lib/subsidiaries";
import { ModuleView } from "@/components/viewspec/module-view";
import { page, pageHeader, widgetBlock } from "@braedonsaunders/appkit-viewspec";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("ar");
  return { title: t("list.cashDailySummary") };
}

/**
 * Daily summary entry: one form for the day's close — date, one row per
 * category/tax-code total, tenders with tips and fees, over/short — which
 * creates the cash sale as a draft through the native document path. The
 * cashier reviews and posts it from the Cash sales drawer.
 */
export default async function CashDailySummary() {
  const authz = await requirePermission("cash_sales.create");
  await requireFeatureEnabled(authz.user.orgId, "cashSales");
  const t = await getTranslations("ar");
  const scope = authz.allowedSubsidiaryIds;
  const config = DOC_KINDS.cash_sale;
  if (!config) notFound();
  const [accounts, taxCodes, tenderAccounts, subsidiaries, servers, currency, today] =
    await Promise.all([
      accountOptions(config, authz.user.orgId, authz.allowedSubsidiaryIds),
      taxCodeOptions(authz.user.orgId),
      db
        .execute<{ id: string; number: string | null; name: string | null }>(
          sql`
      select id, number, name from accounts
       where org_id = ${authz.user.orgId} and is_active and not is_summary
         and type in ('asset_bank', 'asset_current_other')
         ${subsidiaryVisibleFilter(sql`subsidiary_id`, scope, { orgWideNull: true })}
       order by number nulls last, name`,
          "objects",
        )
        .then((r) =>
          r.map((row) => ({
            value: row.id,
            label: [row.number, row.name].filter(Boolean).join(" — "),
          })),
        ),
      isMultiSubsidiary(authz.user.orgId).then(async (multi) => {
        if (!multi) return null;
        const options = await subsidiaryOptions();
        const inScope = authz.allowedSubsidiaryIds
          ? options.filter((option) => authz.allowedSubsidiaryIds!.has(option.id))
          : options;
        return inScope.map((option) => ({ value: option.id, label: option.name }));
      }),
      listScopedPartyOptions(authz.user.orgId, scope, { role: "employee", activeOnly: true }).then(
        (rows) => rows.map((row) => ({ value: row.id, label: row.display_name })),
      ),
      db
        .execute<{ base_currency: string }>(
          sql`select base_currency from orgs where id = ${authz.user.orgId}`,
          "objects",
        )
        .then((r) => r[0]?.base_currency ?? "CAD"),
      businessToday(authz.user.orgId),
    ]);
  const optionLabel = (option: {
    id: string;
    label?: string;
    number?: string;
    name?: string;
    code?: string;
  }) =>
    option.label ??
    [option.number ?? option.code, option.name].filter(Boolean).join(" — ") ??
    option.id;
  const lineAccounts = accounts.map((option) => ({ value: option.id, label: optionLabel(option) }));
  const taxCodeItems = taxCodes.map((option) => ({ value: option.id, label: optionLabel(option) }));
  const defaultTenderAccountId = tenderAccounts[0]?.value ?? null;

  const spec = page({
    route: "/cash-sales/daily-summary",
    layout: "detail",
    header: [
      pageHeader({
        title: t("list.cashDailySummary"),
        back: { href: "/cash-sales", label: t("dailySummary.back") },
      }),
    ],
    body: [
      widgetBlock("cash-daily-summary", {
        currency,
        defaultDate: today,
        accounts: lineAccounts,
        taxCodes: taxCodeItems,
        tenderAccounts,
        defaultTenderAccountId,
        serverOptions: servers,
        subsidiaries,
        defaultSubsidiaryId: subsidiaries?.[0]?.value ?? null,
      }),
    ],
  });
  return <ModuleView spec={spec} data={{}} searchParams={{}} trusted />;
}
