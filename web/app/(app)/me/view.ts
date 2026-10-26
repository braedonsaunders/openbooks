import "server-only";

import { registeredListTable } from "../../../lib/list/prepared-spec";
import { getTranslations } from "next-intl/server";
import {
  badge,
  column,
  grid,
  field as item,
  page,
  pageHeader,
  panel,
  link,
  ref,
  statTile,
  text,
  textBlock,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { requirePermission } from "../../../lib/authz";
import { requireFeatureEnabled } from "../../../lib/feature-gates";
import { loadOrRefuse } from "../../../lib/load-or-refuse";
import { SelfServiceError } from "@openbooks/engine/hrm/self-service/actor";
import type { MePaySection } from "../../../lib/hrm/ai-rails";
import { loadMeOverview, type MeOverviewData } from "../../../lib/hrm/self-service";

/**
 * Me overview — the person's workspace landing. Employment summary,
 * open steps, pending requests, balances, and the extension rail (filled
 * from the self-service extension registry — reviews and benefits land
 * there, never as placeholders). Loader-resolved rows through the shared
 * registered list under house headings; the primary action is the shared
 * 'link-button' FIRST in the header, then the inline 'module-home-tabs'
 * view switch. Renders only when the hrm feature gate is on and the actor
 * holds hrm.self.read — the view 404s otherwise.
 */

const f = ref<MeOverviewData>();

export function meSpec(data: MeOverviewData): PageSpec {
  const timeBalances = data.balances.filter((balance) => balance.kind === "time");
  const leaveValue =
    timeBalances.length > 0
      ? timeBalances
          .map(
            (balance) =>
              `${balance.leaveTypeCode}: ${balance.unlimited ? data.unlimitedLabel : (balance.remaining ?? data.notAvailableLabel ?? "—")}`,
          )
          .join(" · ")
      : (data.notAvailableLabel ?? "—");
  const leaveSub = timeBalances.length > 0 ? data.timeKindLabel : data.balancesEmpty;
  const latestPay = data.payStubs?.[0];
  const latestPayValue = latestPay?.netPayText ?? data.notAvailableLabel ?? "—";
  const compensationLabel =
    data.tabs.find((tab) => tab.href === "/me/compensation")?.label ?? data.payTitle ?? "";
  return page({
    route: "/me",
    layout: "list",
    bodyClassName: "flex h-full min-h-0 flex-col",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center gap-3",
        actions: [
          widget("hrm-install-app", {}),
          widget("link-button", { href: f("profileHref"), label: f("editProfile") }),
          widget("link-button", {
            href: f("checklistsHref"),
            label: f("viewChecklists"),
            variant: "outline",
          }),
          widget("module-home-tabs", { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock(
        "empty-state",
        {
          title: data.refusal?.title ?? "",
          description: data.refusal?.message,
        },
        f("refusal"),
      ),
      {
        ...grid("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-4", [
          grid("grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5", [
            statTile({
              iconKey: "clipboard-check",
              accent: "teal",
              label: f("stepsTitle"),
              value: String(data.openStepsCount ?? data.steps?.length ?? 0),
              sub: f("viewChecklists"),
            }),
            statTile({
              iconKey: "file-clock",
              accent: "amber",
              label: f("requestsTitle"),
              value: String(data.pendingRequestsCount ?? data.requests?.length ?? 0),
              sub: f("requestsEmptyDescription"),
            }),
            statTile({
              iconKey: "calendar-days",
              accent: "sky",
              label: f("availableLeaveLabel"),
              value: leaveValue,
              sub: leaveSub,
            }),
            statTile({
              iconKey: "triangle-alert",
              accent: "violet",
              label: f("qualificationsTitle"),
              value: String(data.expiringQualificationsCount ?? data.qualifications?.length ?? 0),
              sub: f("qualificationsEmptyDescription"),
            }),
            statTile({
              iconKey: "banknote",
              accent: "emerald",
              label: data.latestNetPayLabel ?? data.payColumns?.netPay ?? data.payTitle ?? "",
              value: latestPayValue,
              sub: latestPay?.payDate ?? data.notAvailableLabel ?? "",
            }),
          ]),
          grid("grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3", [
            panel({
              title: f("stepsTitle"),
              iconKey: "list-checks",
              hint: f("stepsEmptyDescription"),
              bodyClassName: "min-h-0 overflow-y-auto p-0",
              className: "min-h-[24rem] lg:col-span-2",
              blocks: [
                registeredListTable("me_action_queue", {
                  variant: "app",
                  rows: f("actionQueueRows"),
                  rowKey: item("id"),
                  columns: [
                    column(f("stepsColumns.title"), link(item("title"), item("href"))),
                    column(f("requestsColumns.kind"), text(item("kindLabel"))),
                    column(
                      f("stepsColumns.due"),
                      text(item("dueLabel"), { className: "tabular-nums" }),
                    ),
                    column(
                      f("requestsColumns.status"),
                      badge(item("statusLabel"), { variant: item("statusVariant") }),
                    ),
                  ],
                  empty: { title: f("stepsEmpty"), description: f("stepsEmptyDescription") },
                }),
              ],
            }),
            grid("flex min-h-0 flex-col gap-5 overflow-y-auto", [
              panel({
                title: f("employmentsTitle"),
                iconKey: "briefcase",
                bodyClassName: "p-0",
                className: "shrink-0",
                blocks: [
                  widgetBlock("hrm-facts", {
                    facts: data.employmentFacts ?? [],
                    empty: data.employmentsEmpty,
                  }),
                  widgetBlock("hrm-leave-balances", {
                    balances: data.balances,
                    timeKindLabel: data.timeKindLabel,
                    valueKindLabel: data.valueKindLabel,
                    unlimitedLabel: data.unlimitedLabel,
                    serviceStartUnknownLabel: data.serviceStartUnknownLabel,
                    empty: data.balancesEmpty,
                  }),
                ],
              }),
              panel({
                title: f("payTitle"),
                iconKey: "wallet",
                bodyClassName: "space-y-3 p-4",
                className: "shrink-0",
                when: f("hasPay"),
                blocks: [
                  textBlock(
                    latestPay
                      ? `${data.payColumns?.payDate ?? ""}: ${latestPay.payDate} · ${data.payColumns?.netPay ?? ""}: ${latestPay.netPayText}`
                      : (data.payEmpty ?? ""),
                  ),
                  ...(latestPay
                    ? [
                        widgetBlock("link-button", {
                          href: latestPay.explainHref,
                          label: latestPay.explainLabel,
                          variant: "outline",
                        }),
                        widgetBlock("link-button", {
                          href: "/me/compensation",
                          label: compensationLabel,
                          variant: "outline",
                        }),
                      ]
                    : []),
                ],
              }),
              widgetBlock(
                "directory-section",
                { title: data.extensionsTitle, items: data.extensions },
                f("hasExtensions"),
              ),
            ]),
          ]),
          widgetBlock("hrm-explain-drawer", { explain: data.payExplain }, f("payExplain")),
        ]),
        when: f("hasContent"),
      },
    ],
  });
}

/**
 * Empty pay section for the refusal path: the payslip panel hides on
 * hasPay while the refusal block carries the message.
 */
const EMPTY_PAY_SECTION: MePaySection = {
  hasPay: false,
  payTitle: "",
  payStubs: [],
  payColumns: { payDate: "", gross: "", netPay: "" },
  payEmpty: "",
  payExplain: null,
};

export async function loadMePage(sp?: Record<string, string | undefined>): Promise<MeOverviewData> {
  // The page gate lives here — where the route-gate scanner reads — and the
  // loader enforces nothing twice: it takes the authorized session as input.
  const authz = await requirePermission("hrm.self.read");
  await requireFeatureEnabled(authz.user.orgId, "hrm");
  const overview = await loadMeOverview(authz);
  // Own payslips with the Explain drawer (?explain=<stubId>). The
  // stubs resolve through the same person link, so an unlinked login
  // refuses here too — convert only NO_LINK to the refusal state through
  // the shared mechanism (same as the clock); everything else still
  // throws. A refusal the overview already carries wins: it names the
  // same condition from the same link.
  const t = await getTranslations("hrm");
  const { loadMePaySection } = await import("../../../lib/hrm/ai-rails");
  const pay = await loadOrRefuse(() => loadMePaySection(authz, sp?.explain), {
    refusals: [{ error: SelfServiceError, code: "NO_LINK" }],
    title: t("me.refusedTitle"),
  });
  if (pay.ok) return { ...overview, ...pay.data };
  return { ...overview, ...EMPTY_PAY_SECTION, refusal: overview.refusal ?? pay.refusal };
}

export async function meTitle(): Promise<string> {
  const t = await getTranslations("hrm");
  return t("me.overview.title");
}
