import "server-only";

import { randomUUID } from "node:crypto";
import { getLocale, getTranslations } from "next-intl/server";
import { periodDisplayLabel } from "@openbooks/engine/periods/period-policy";
import {
  page,
  pageHeader,
  ref,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { listPeriodReopenRequests } from "../../../../lib/application/close";
import { applicationContextFromSession } from "../../../../lib/application/context";
import { requirePermission } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";
import { parseReopenRequestListState, REOPEN_REQUEST_FILTERS } from "./list-state";

const BASE = "/accounting/reopen-requests";
const STATUS_LABEL_VALUES = [
  ...REOPEN_REQUEST_FILTERS,
  "withdrawn",
  "expired",
  "reclosed",
] as const;
type ReopenRequestRow = Awaited<ReturnType<typeof listPeriodReopenRequests>>["requests"][number];

export interface ReopenRequestsWorkspaceData {
  orgId: string;
  userId: string;
  sp: Record<string, string | string[] | undefined>;
  rows: ReopenRequestRow[];
  selected: ReopenRequestRow | null;
  total: number;
  page: number;
  perPage: number;
  status: string | undefined;
  scopedApprover: boolean;
  title: string;
  description: string;
  empty: string;
  scopedMessage: string;
  columnLabels: {
    period: string;
    scope: string;
    modules: string;
    reason: string;
    requestedBy: string;
    status: string;
  };
  statusOptions: { value: string; label: string }[];
  statusLabels: Record<string, string>;
  allLabel: string;
  statusLabel: string;
}

export interface ReopenRequestsData {
  workspace: ReopenRequestsWorkspaceData;
}

export async function loadReopenRequests(
  sp: Record<string, string | string[] | undefined>,
): Promise<ReopenRequestsData> {
  const authz = await requirePermission("close.reopen");
  const t = await getTranslations("accounting.reopenRequests");
  const scopedApprover = authz.allowedSubsidiaryIds !== null;
  const context = applicationContextFromSession(authz, "api", randomUUID());
  const { status, page: pageNumber, perPage, offset } = parseReopenRequestListState(sp);
  const selectedId = Array.isArray(sp.request) ? undefined : sp.request;
  const [result, selectedResult] = scopedApprover
    ? [null, null]
    : await Promise.all([
        listPeriodReopenRequests(context, { status, limit: perPage, offset }),
        selectedId && isUuid(selectedId)
          ? listPeriodReopenRequests(context, { requestId: selectedId, limit: 1 })
          : Promise.resolve(null),
      ]);
  const [common, locale] = await Promise.all([getTranslations("common"), getLocale()]);
  // Every request names its period the way the close list labels it.
  const labelled = (row: ReopenRequestRow): ReopenRequestRow => ({
    ...row,
    period: periodDisplayLabel(row.periodRef, locale),
  });
  const selected = selectedResult?.requests[0];
  return {
    workspace: {
      orgId: authz.user.orgId,
      userId: authz.user.id,
      sp,
      rows: (result?.requests ?? []).map(labelled),
      selected: selected ? labelled(selected) : null,
      total: result?.total ?? 0,
      page: pageNumber,
      perPage,
      status,
      scopedApprover,
      title: t("title"),
      description: t("description"),
      empty: t("empty"),
      scopedMessage: t("scopedApprover"),
      columnLabels: {
        period: t("columns.period"),
        scope: t("columns.scope"),
        modules: t("columns.modules"),
        reason: t("columns.reason"),
        requestedBy: t("columns.requestedBy"),
        status: t("columns.status"),
      },
      statusOptions: REOPEN_REQUEST_FILTERS.map((value) => ({
        value,
        label: t(`status.${value}`),
      })),
      statusLabels: Object.fromEntries(
        STATUS_LABEL_VALUES.map((value) => [value, t(`status.${value}`)]),
      ),
      allLabel: common("labels.all"),
      statusLabel: t("columns.status"),
    },
  };
}

const f = ref<ReopenRequestsData>();

export function reopenRequestsSpec(data: ReopenRequestsData): PageSpec {
  return page({
    route: "/accounting/reopen-requests",
    layout: "list",
    header: [
      pageHeader({ title: f("workspace.title"), description: f("workspace.description") }),
      widgetBlock("filter-chips", {
        basePath: BASE,
        currentParams: data.workspace.sp,
        paramKey: "status",
        label: data.workspace.statusLabel,
        allLabel: data.workspace.allLabel,
        options: data.workspace.statusOptions,
        pageParamKey: "page",
      }),
    ],
    body: [widgetBlock("accounting-reopen-requests-workspace", { data: f("workspace") })],
  });
}
