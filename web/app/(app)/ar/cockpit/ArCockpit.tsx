"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Wallet,
  TriangleAlert,
  CalendarClock,
  Timer,
  ListOrdered,
  CalendarRange,
  Users,
  ListChecks,
  SlidersHorizontal,
} from "lucide-react";
import { money, moneyCompact } from "../../../../lib/format";
import type { ArPosition } from "../../../../lib/cash/ar-position";
import {
  StatTile,
  CockpitPanel,
  AgingBars,
  ScheduleBars,
} from "../../../../components/cockpit/ui";
import {
  CashWeekFlyout,
  type CategoryFlow,
} from "../../analytics/_ui/CashWeekFlyout";
import { ArCollectionsInfoDrawer } from "./ArCollectionsInfoDrawer";
import { CollectionsWorklist } from "./CollectionsWorklist";
import { SearchInput } from "../../../../components/search-input";
import { FilterChips } from "../../../../components/filter-bar";
import { Pagination } from "../../../../components/pagination";

const CUSTOMERS_PER_PAGE = 6;

/**
 * Accounts-Receivable control center — the AP cockpit's mirror, fit-to-height.
 * Vitals up top, the collections worklist filling the height (most-overdue
 * chase list → /receipts collection-run builder), aging + cash-in schedule +
 * customer breakdown beside it. All off the shared cash engine, so numbers
 * agree with the forecast and the other cockpits to the penny.
 */
export function ArCockpit({
  data,
  canCollect,
}: {
  data: ArPosition;
  canCollect: boolean;
}) {
  const t = useTranslations("ar.cockpit");
  const search = useSearchParams();
  const currentParams = Object.fromEntries(search.entries());
  const [showInfo, setShowInfo] = useState(false);
  const [drillWeek, setDrillWeek] = useState<number | null>(null);

  const overduePct =
    data.outstanding > 0
      ? Math.round((data.overdue / data.outstanding) * 100)
      : 0;
  const catFlowsFor = (wi: number): CategoryFlow[] =>
    data.categories
      .map((c) => ({
        name: c.name,
        direction: c.direction,
        amount: c.weekly[wi] ?? 0,
      }))
      .filter((c) => c.amount > 0);
  const customerQuery = (search.get("customerQ") ?? "")
    .trim()
    .toLocaleLowerCase();
  const customerStatus = search.get("customerStatus");
  const customerPage = Math.max(
    1,
    Number.parseInt(search.get("customerPage") ?? "1", 10) || 1,
  );
  const filteredCustomers = data.byCustomer.filter((customer) => {
    if (
      customerQuery &&
      !customer.partyName.toLocaleLowerCase().includes(customerQuery)
    )
      return false;
    if (customerStatus === "overdue" && customer.overdue <= 0) return false;
    return true;
  });
  const visibleCustomers = filteredCustomers.slice(
    (customerPage - 1) * CUSTOMERS_PER_PAGE,
    customerPage * CUSTOMERS_PER_PAGE,
  );

  const gear = (
    <button
      type="button"
      onClick={() => setShowInfo(true)}
      title={t("configure")}
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-slate-400 transition-colors hover:text-teal-600 dark:hover:text-teal-400"
    >
      <SlidersHorizontal size={14} />
      {t("configure")}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Vitals */}
      <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile
          icon={Wallet}
          accent="sky"
          label={t("stats.openReceivables")}
          value={moneyCompact(data.outstanding)}
        />
        <StatTile
          icon={TriangleAlert}
          accent="red"
          label={t("stats.overdue")}
          value={moneyCompact(data.overdue)}
          sub={t("stats.overdueSub", {
            count: data.overdueCount,
            pct: overduePct,
          })}
          tone={data.overdue > 0 ? "negative" : "neutral"}
        />
        <StatTile
          icon={CalendarClock}
          accent="emerald"
          label={t("stats.expectedThisWeek")}
          value={moneyCompact(data.expectedThisWeek)}
          tone="positive"
        />
        <StatTile
          icon={CalendarRange}
          accent="teal"
          label={t("stats.next30")}
          value={moneyCompact(data.expectedNext30)}
        />
        <StatTile
          icon={Timer}
          accent="violet"
          label={t("stats.dso")}
          value={t("stats.days", { n: data.dso })}
          sub={t("stats.dsoSub")}
        />
      </div>

      {/* Worklist + right column — fill remaining height */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3">
        <CockpitPanel
          title={t("panels.worklist")}
          icon={ListChecks}
          actions={gear}
          bodyClassName="min-h-0 overflow-hidden p-0"
          className="min-h-0 lg:col-span-2"
        >
          <CollectionsWorklist
            entries={data.worklist.map((e) => ({
              id: e.id,
              docId: e.docId,
              docKind: e.docKind,
              partyName: e.partyName,
              amount: e.amount,
              dueDate: e.dueDate,
              predictedDate: e.predictedDate,
              daysOverdue: e.daysOverdue,
              method: e.method,
            }))}
            overdueTotal={data.overdue}
            expectedThisWeek={data.expectedThisWeek}
            canCollect={canCollect}
          />
        </CockpitPanel>

        <div className="flex min-h-0 flex-col gap-5">
          <CockpitPanel
            title={t("panels.aging")}
            icon={ListOrdered}
            hint={`${moneyCompact(data.outstanding)} · ${data.summary.pctCurrent.toFixed(0)}% ${t("current")}`}
            className="shrink-0"
          >
            <AgingBars
              buckets={data.summary.buckets}
              accent="text-sky-600 dark:text-sky-400"
            />
          </CockpitPanel>

          <CockpitPanel
            title={t("panels.schedule")}
            icon={CalendarRange}
            hint={t("panels.scheduleHint", { weeks: data.horizonWeeks })}
            className="shrink-0"
          >
            <ScheduleBars
              weeks={data.weeks.map((w) => ({
                label: w.label.split(" – ")[0]!,
                amount: w.amount,
              }))}
              barClass="bg-emerald-400 dark:bg-emerald-500"
              onSelect={(i) => setDrillWeek(i)}
            />
          </CockpitPanel>

          <CockpitPanel
            title={t("panels.byCustomer")}
            icon={Users}
            bodyClassName="min-h-0 overflow-hidden p-0"
            className="min-h-0 flex-1"
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
                <SearchInput
                  placeholder={t("customerSearch")}
                  paramKey="customerQ"
                  pageParamKey="customerPage"
                />
                <FilterChips
                  basePath="/ar"
                  currentParams={currentParams}
                  paramKey="customerStatus"
                  pageParamKey="customerPage"
                  label={t("customerStatus")}
                  options={[
                    { value: "overdue", label: t("customerOverdueOnly") },
                  ]}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {filteredCustomers.length === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">
                    {t("noReceivables")}
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white dark:bg-slate-900">
                      <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                        <th className="px-4 py-2 text-left font-medium">
                          {t("customer")}
                        </th>
                        <th className="px-3 py-2 text-right font-medium">
                          {t("overdueCol")}
                        </th>
                        <th className="px-4 py-2 text-right font-medium">
                          {t("openCol")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleCustomers.map((c) => (
                        <tr
                          key={c.partyId ?? c.partyName}
                          className="border-b border-slate-50 last:border-0 dark:border-slate-800/60"
                        >
                          <td className="px-4 py-2 text-slate-700 dark:text-slate-300">
                            {c.partyName}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {c.overdue > 0 ? (
                              <span className="text-red-600 dark:text-red-400">
                                {moneyCompact(c.overdue)}
                              </span>
                            ) : (
                              <span className="text-slate-300 dark:text-slate-600">
                                —
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">
                            {money(c.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <Pagination
                basePath="/ar"
                currentParams={currentParams}
                total={filteredCustomers.length}
                page={customerPage}
                perPage={CUSTOMERS_PER_PAGE}
                pageParamKey="customerPage"
              />
            </div>
          </CockpitPanel>
        </div>
      </div>

      {drillWeek !== null && data.timeline[drillWeek] ? (
        <CashWeekFlyout
          week={data.timeline[drillWeek]!}
          initialSide="ar"
          categoryFlows={catFlowsFor(drillWeek)}
          onClose={() => setDrillWeek(null)}
        />
      ) : null}
      {showInfo ? (
        <ArCollectionsInfoDrawer
          onClose={() => setShowInfo(false)}
          title={t("configTitle")}
          description={t("configDescription")}
          dso={data.dso}
        />
      ) : null}
    </div>
  );
}
