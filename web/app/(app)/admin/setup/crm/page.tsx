import { redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Button, PageHeader } from "@openbooks/ui";
import { can, requirePermission } from "../../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../../lib/feature-gates";
import { ListPageLayout } from "../../../../../components/page-layout";
import { ModuleHomeTabs } from "../../../../../components/module-home/ui";
import { SetupEntitySection } from "../[entity]/SetupEntitySection";
import { CRM_SETUP_PAGES, crmSetupHref } from "../../../../../lib/setup/rail";
import { SETUP_ENTITY_BY_KEY } from "../../../../../lib/setup/registry";
import type { SetupEntity, SetupOption } from "../../../../../lib/setup/types";
import { mergeHref, pickString } from "../../../../../lib/list-params";
import { toSnake } from "../../../../../lib/setup/registry";

export const dynamic = "force-dynamic";

const ENTITY_BY_TAB = {
  accountStatuses: "crm-account-statuses",
  opportunityStatuses: "crm-opportunity-statuses",
  sources: "crm-lead-sources",
} as const;

type CrmSetupTab = keyof typeof ENTITY_BY_TAB;

function localizeOptions(options: SetupOption[] | undefined, translate: (key: string) => string) {
  return options?.map((option) => ({
    ...option,
    label:
      option.label ??
      (option.labelKey?.startsWith("crm.")
        ? translate(option.labelKey.slice("crm.".length))
        : option.labelKey
          ? translate(option.labelKey)
          : option.value),
  }));
}

function localizeEntity(
  entity: SetupEntity,
  tab: CrmSetupTab,
  translateCrm: (key: string) => string,
): SetupEntity {
  return {
    ...entity,
    singularTitle: translateCrm(`setup.tabs.${tab}`),
    columns: entity.columns.map((column) => ({
      ...column,
      label: column.labelKey?.startsWith("crm.")
        ? translateCrm(column.labelKey.slice("crm.".length))
        : column.label,
      options: localizeOptions(column.options, translateCrm),
    })),
    fields: entity.fields.map((field) => ({
      ...field,
      label:
        field.label ??
        (field.labelKey?.startsWith("crm.")
          ? translateCrm(field.labelKey.slice("crm.".length))
          : undefined),
      options: localizeOptions(field.options, translateCrm),
    })),
  };
}

export default async function CrmSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const requestedTab = pickString(sp.tab);
  if (requestedTab && ["teams", "quotas", "territories"].includes(requestedTab)) {
    redirect(`/crm/sales/${requestedTab}`);
  }
  const tab = CRM_SETUP_PAGES.some((page) => page.tab === requestedTab)
    ? (requestedTab as CrmSetupTab)
    : undefined;
  if (!tab) redirect(crmSetupHref(CRM_SETUP_PAGES[0].tab));

  const authz = await requirePermission("crm.setup.manage");
  await requireFeatureEnabled(authz.user.orgId, "crm");
  const entity = SETUP_ENTITY_BY_KEY.get(ENTITY_BY_TAB[tab]);
  if (!entity) redirect(crmSetupHref(CRM_SETUP_PAGES[0].tab));

  const t = await getTranslations("crm");
  const newHref = mergeHref("/admin/setup/crm", sp, { tab, row: "new" });
  const localizedEntity = localizeEntity(entity, tab, t);

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t(`setup.tabs.${tab}`)}
          description={t(`setup.descriptions.${tab}`)}
          actions={
            <Button asChild>
              <Link href={newHref}>{t(`setup.new.${tab}`)}</Link>
            </Button>
          }
        />
      }
    >
      <div className="space-y-4">
        <ModuleHomeTabs
          tabs={CRM_SETUP_PAGES.map((page) => ({
            href: crmSetupHref(page.tab),
            label: t(`setup.tabs.${page.tab}`),
            active: page.tab === tab,
          }))}
        />
        <SetupEntitySection
          entity={localizedEntity}
          orgId={authz.user.orgId}
          actorId={authz.user.id}
          searchParams={sp}
          basePath="/admin/setup/crm"
          canManage={can(authz, "crm.setup.manage")}
          allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
          renderColumn={(column, row) =>
            column.kind === "boolean"
              ? t(`setup.states.${row[toSnake(column.key)] ? "yes" : "no"}`)
              : undefined
          }
          hideHeader
        />
      </div>
    </ListPageLayout>
  );
}
