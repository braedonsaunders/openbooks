import "server-only";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import {
  provisionEditorOptions,
  readProvisionObligation,
  ProvisionError,
} from "@openbooks/engine/provisions";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
  type WidgetRef,
} from "@braedonsaunders/appkit-viewspec";
import type { ModuleHomeTab } from "../../../../components/module-home/tab-types";
import { requirePermission, can } from "../../../../lib/authz";
import { groupTabs } from "../../../../components/module-home/group-tabs";
import { isUuid, pickString } from "../../../../lib/list-params";
import { provisionDrawerLinks } from "./drawer-links";
import type { ProvisionAssessmentWorkspaceData } from "./workspace";

export interface ProvisionsData {
  title: string;
  description: string;
  newLabel: string;
  newHref: string;
  showNew: boolean;
  tabs: ModuleHomeTab[];
  workspace: ProvisionAssessmentWorkspaceData;
}

export async function loadProvisions(
  sp: Record<string, string | string[] | undefined>,
): Promise<ProvisionsData> {
  const auth = await requirePermission("gl.read");
  const t = await getTranslations("accounting.provisions");
  const canManage = can(auth, "gl.manage");
  const selected = pickString(sp.provision);
  const isNew = selected === "new";
  if (selected && !isNew && !isUuid(selected)) notFound();
  if (isNew && !canManage) notFound();
  const assessmentOpen = pickString(sp.assess) === "1";

  const [tabs, editor, detail] = await Promise.all([
    groupTabs("accounting", "/accounting/provisions", { orgId: auth.user.orgId }),
    canManage
      ? provisionEditorOptions(auth.user.orgId, auth.user.id)
          .then((options) => ({ options, error: null as string | null }))
          .catch((error) => {
            if (error instanceof ProvisionError) return { options: null, error: error.message };
            throw error;
          })
      : null,
    selected && !isNew
      ? readProvisionObligation(auth.user.orgId, auth.user.id, selected).catch((error) => {
          if (error instanceof Error && "status" in error && error.status === 404) notFound();
          throw error;
        })
      : null,
  ]);

  const options = editor?.options ?? null;
  const { newHref, newCloseHref, assessmentOpenHref, assessmentCloseHref, detailCloseHref } =
    provisionDrawerLinks(sp);

  return {
    title: t("title"),
    description: t("description"),
    newLabel: t("new"),
    newHref,
    showNew: options !== null,
    tabs,
    workspace: {
      orgId: auth.user.orgId,
      userId: auth.user.id,
      sp,
      editorError: editor?.error ?? null,
      emptyTitle: t("empty"),
      reviewHint: t("reviewHint"),
      options,
      detail,
      isNew,
      assessmentOpen: assessmentOpen && !isNew,
      newHref,
      newCloseHref,
      assessmentOpenHref,
      assessmentCloseHref,
      detailCloseHref,
    },
  };
}

const f = ref<ProvisionsData>();

export function provisionsSpec(data: ProvisionsData): PageSpec {
  const actions: WidgetRef[] = [];
  if (data.showNew) {
    actions.push(
      widget("link-button", {
        href: f("newHref"),
        label: f("newLabel"),
        iconKey: "plus",
      }),
    );
  }
  actions.push(widget("module-home-tabs", { tabs: f("tabs") }));
  return page({
    route: "/accounting/provisions",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions,
        actionsClassName: "flex flex-wrap items-center gap-2",
      }),
    ],
    body: [widgetBlock("accounting-provisions-workspace", { data: f("workspace") })],
  });
}
