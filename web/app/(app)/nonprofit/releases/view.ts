import "server-only";

import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { getFundRelease } from "@openbooks/engine/nonprofit/releases";
import { businessToday } from "@openbooks/engine/platform/business-date";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { can, requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { isUuid, pickString } from "../../../../lib/list-params";
import { nonprofitGroupTabs } from "../../../../components/module-home/group-tabs";

/**
 * The fund-release register, split into a loader and a spec.
 *
 * The fixed-asset register archetype again: the universal EntityListView
 * (`fund_release`) carries the list through the Authz-re-deriving slot, and
 * the drawer payload reads the same release row the flow adapter resolves —
 * from/to fund codes, lifecycle status, and the posted/void entry evidence.
 * That row arrives through the canonical release reader, never a parallel
 * query, so the drawer and the adapter cannot disagree about a release. The
 * approvals tab reuses the native approval actions and history, bound to
 * the adapter's `fund_release` subject kind. This page lands before any
 * release-submitting surface: drafts are submitted elsewhere, decided here.
 * A named release the reader cannot see is a stale or foreign link, so it
 * ends on the shared not-found boundary instead of an empty page.
 */

export interface ReleaseDetail {
  id: string;
  number: string;
  releaseDate: string;
  amount: string;
  purpose: string;
  satisfactionRef: string;
  status: string;
  fromCode: string;
  fromName: string;
  toCode: string;
  toName: string;
  postedEntryId: string | null;
  voidEntryId: string | null;
}

export interface ReleaseDrawerData {
  mode: "record";
  remountKey: string;
  release: ReleaseDetail;
  canManage: boolean;
  canPost: boolean;
  today: string;
  canCustomize: boolean;
  closeHref: string;
}

export interface ReleaseCreateDrawerData {
  mode: "create";
  remountKey: "new";
  funds: { id: string; code: string | null; name: string }[];
  accounts: { id: string; number: string | null; name: string }[];
  canManage: boolean;
  today: string;
  closeHref: string;
}

export type ReleaseDrawerState = ReleaseDrawerData | ReleaseCreateDrawerData;

export interface ReleasesData {
  title: string;
  description: string;
  currentParams: Record<string, string | string[] | undefined>;
  tabs: Awaited<ReturnType<typeof nonprofitGroupTabs>>;
  canManage: boolean;
  newLabel: string;
  drawer: ReleaseDrawerState | null;
}

export async function loadReleases(
  sp: Record<string, string | string[] | undefined>,
): Promise<ReleasesData> {
  const authz = await requirePermission("funds.read");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "fundAccounting");
  const t = await getTranslations("nonprofit");
  const tCommon = await getTranslations("common");
  const tabs = await nonprofitGroupTabs(authz, "/nonprofit/releases");
  const canManage = can(authz, "funds.manage");

  const base: ReleasesData = {
    title: t("releases.title"),
    description: t("releases.description"),
    currentParams: sp,
    tabs,
    canManage,
    newLabel: tCommon("actions.newRecord"),
    drawer: null,
  };

  const releaseId = pickString(sp.release);
  if (releaseId === "new" && canManage) {
    const [fundRows, accountRows, today] = await Promise.all([
      db.execute<{ id: string; code: string | null; name: string }>(
        sql`
        select f.id::text as id, sv.code, sv.name
          from funds f
          join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
         where f.org_id = ${orgId} and sv.is_active
         order by sv.code nulls last, sv.name, f.id limit 500`,
        "objects",
      ),
      db.execute<{ id: string; number: string | null; name: string }>(
        sql`
        select id::text as id, number, name from accounts
         where org_id = ${orgId} and is_active and not is_summary
           and type in ('income', 'income_other', 'equity')
         order by number nulls last, name, id limit 500`,
        "objects",
      ),
      businessToday(orgId),
    ]);
    return {
      ...base,
      drawer: {
        mode: "create",
        remountKey: "new",
        funds: fundRows,
        accounts: accountRows,
        canManage,
        today,
        closeHref: "/nonprofit/releases",
      },
    };
  }
  if (!releaseId || !isUuid(releaseId)) return base;
  const found = await getFundRelease({ orgId, releaseId });
  if (!found) notFound();
  const today = await businessToday(orgId);

  return {
    ...base,
    drawer: {
      mode: "record",
      remountKey: found.id,
      release: {
        id: found.id,
        number: found.number,
        releaseDate: found.releaseDate,
        amount: found.amount,
        purpose: found.purpose,
        satisfactionRef: found.satisfactionRef,
        status: found.status,
        fromCode: found.fromCode ?? found.fromName,
        fromName: found.fromName,
        toCode: found.toCode ?? found.toName,
        toName: found.toName,
        postedEntryId: found.postedEntryId,
        voidEntryId: found.voidEntryId,
      },
      canManage,
      canPost: can(authz, "gl.post"),
      today,
      canCustomize: can(authz, "admin.customization.manage"),
      closeHref: "/nonprofit/releases",
    },
  };
}

const f = ref<ReleasesData>();

export function releasesSpec(data: ReleasesData): PageSpec {
  return page({
    route: "/nonprofit/releases",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center justify-end gap-2",
        actions: [
          widget("module-home-tabs", { tabs: data.tabs }),
          widget(
            "link-button",
            { href: "/nonprofit/releases?release=new", label: f("newLabel"), iconKey: "plus" },
            f("canManage"),
          ),
        ],
      }),
    ],
    body: [
      {
        ...widgetBlock("entity-list-view", {
          recordType: "fund_release",
          sp: data.currentParams,
          drawer: [
            data.drawer ? { widget: "release-drawer", props: { drawer: data.drawer } } : null,
          ].filter(Boolean),
          emptyAction: null,
        }),
      },
    ],
  });
}
