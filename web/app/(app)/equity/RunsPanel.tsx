"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, UrlDrawer } from "@openbooks/ui";
import type { CompensationRunResult, InterestRunResult } from "@openbooks/engine/equity";
import { PagedTable } from "@/components/paged-table";
import { ListFilterSelect } from "@/components/list-filter-select";
import { JournalEntryLink } from "@/components/journal-entry-link";
import { MoneyProvider, useMoney } from "@/components/money-provider";
import { joinRefusal } from "@/lib/refusal-sentence";
import { useAppAction } from "@/lib/use-app-action";
import type { RunsViewData } from "./view";
import {
  CELL,
  CommandRefusal,
  DATE_CELL,
  HEAD,
  LINK,
  NUM_CELL,
  NUM_HEAD,
  OpenReport,
  PendingActions,
  Refusal,
  listSort,
  postCommand,
  useCivilDate,
  useShares,
  withParams,
} from "./shared";

const BASE = "/equity";
const NOTICE =
  "rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200";

/** A posted run, or a run an Equity action Flow holds for approval. */
type GovernedRun<T> =
  (T & { status: "applied" }) | { status: "pending_approval"; throughDate: string };

/**
 * The periodic equity runs, operated like every period posting: pick the
 * accounting period, review what the run would post through its end, and
 * post it. The stock compensation run posts the awards' expense and releases
 * restricted stock as it vests; the note interest run accrues convertible
 * note interest. Both are close tasks of the period; their posted runs open
 * in the run history drawer (`?history=1`).
 */
export function EquityRunsPanel({ view }: { view: RunsViewData | null }) {
  if (!view) return null;
  return (
    <MoneyProvider currency={view.context.currency}>
      <RunsBody view={view} />
    </MoneyProvider>
  );
}

function RunsBody({ view }: { view: RunsViewData }) {
  const t = useTranslations("equity");
  const { money } = useMoney();
  const shares = useShares();
  const date = useCivilDate();
  const router = useRouter();
  const { busy, refusal, execute } = useAppAction();
  const { context } = view;
  const compensation = view.run === "compensation";
  const preview = compensation ? view.compensation : view.interest;
  const runs = compensation ? view.compensationRuns : view.interestRuns;
  const lastRunThrough = runs[0]?.throughDate ?? null;
  const alreadyRun =
    view.throughDate !== null && runs.some((run) => run.throughDate === view.throughDate);
  const backdated =
    view.throughDate !== null && lastRunThrough !== null && view.throughDate < lastRunThrough;
  const period = view.periods.find((row) => row.id === view.periodId) ?? null;

  const failed = compensation ? t("compensation.failed") : t("interest.failed");
  async function post() {
    if (!view.throughDate) return;
    const body = { subsidiaryId: context.subsidiaryId, throughDate: view.throughDate };
    await execute(
      () =>
        compensation
          ? postCommand<GovernedRun<CompensationRunResult>>(
              "/api/equity/compensation/runs",
              body,
              failed,
            )
          : postCommand<GovernedRun<InterestRunResult>>("/api/equity/interest/runs", body, failed),
      {
        fallbackMessage: failed,
        onOk: (run) => {
          const key = compensation ? "compensation" : "interest";
          toast.success(
            run.status === "pending_approval"
              ? t("approval.submitted")
              : run.replayed
                ? t(`${key}.replayed`, { date: date(run.throughDate) })
                : t(`${key}.posted`, { date: date(run.throughDate) }),
          );
          router.refresh();
        },
      },
    );
  }

  const toolbar = (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <ListFilterSelect
        basePath={BASE}
        currentParams={context.params}
        paramKey="run"
        label={t("runs.filters.run")}
        options={[
          { value: "", label: t("runs.kinds.compensation") },
          { value: "interest", label: t("runs.kinds.interest") },
        ]}
      />
      {view.periods.length > 0 && (
        <ListFilterSelect
          basePath={BASE}
          currentParams={{ ...context.params, period: view.periodId ?? undefined }}
          paramKey="period"
          label={t("runs.filters.period")}
          options={view.periods.map((row) => ({ value: row.id, label: row.label }))}
        />
      )}
      {compensation && (
        <ListFilterSelect
          basePath={BASE}
          currentParams={context.params}
          paramKey="lines"
          label={t("runs.filters.lines")}
          options={[
            { value: "", label: t("runs.lines.expense") },
            { value: "releases", label: t("compensation.releases") },
          ]}
        />
      )}
      <div className="ml-auto flex items-center gap-2">
        <OpenReport href={view.reportHref} label={t("compensation.report")} />
        <Button asChild variant="outline" size="sm">
          <Link href={view.historyHref}>{t("runs.history")}</Link>
        </Button>
        {context.canManage && view.throughDate && preview && (
          <Button
            size="sm"
            onClick={post}
            disabled={busy || alreadyRun || backdated || !preview.due || view.blocked !== null}
          >
            {compensation
              ? t("runs.postCompensation", { period: period?.label ?? date(view.throughDate) })
              : t("runs.postInterest", { period: period?.label ?? date(view.throughDate) })}
          </Button>
        )}
      </div>
    </div>
  );

  const summary = preview ? (
    <p className="text-sm text-slate-500 dark:text-slate-400">
      {t("runs.through", { date: date(view.throughDate) })} ·{" "}
      {lastRunThrough
        ? t("compensation.lastRun", { date: date(lastRunThrough) })
        : t("compensation.noRuns")}{" "}
      · {t("compensation.total")}:{" "}
      <strong>
        {money(
          compensation && view.lines === "releases"
            ? view.compensation!.releaseTotal
            : preview.total,
          { currency: preview.currency },
        )}
      </strong>
      {compensation &&
        view.lines === "expense" &&
        /[1-9]/.test(view.compensation!.catchUpTotal) &&
        ` · ${t("runs.includesCatchUp", { amount: money(view.compensation!.catchUpTotal, { currency: preview.currency }), date: date(lastRunThrough) })}`}
      {alreadyRun
        ? ` · ${t("runs.alreadyPosted")}`
        : backdated
          ? ` · ${t("runs.backdated", { date: date(lastRunThrough) })}`
          : ` · ${t("runs.closeTask")}`}{" "}
      {!alreadyRun && !backdated && period && (
        <Link className={LINK} href={period.closeHref as never}>
          {t("runs.openClose", { period: period.label })}
        </Link>
      )}
    </p>
  ) : null;

  return (
    <div className="space-y-3">
      <PendingActions
        context={context}
        filter={(request) =>
          request.action === (compensation ? "compensation_run" : "interest_run")
        }
      />
      <CommandRefusal refusal={refusal} fallback={failed} />
      {/* Recorded after the last run for the periods it measured, and why the selected period cannot post yet. */}
      {view.catchUp && (
        <p role="status" className={NOTICE}>
          {view.catchUp}
        </p>
      )}
      {view.blocked && !alreadyRun && !backdated && (
        <p role="status" className={NOTICE}>
          {joinRefusal(view.blocked.message, view.blocked.remedy)}
        </p>
      )}
      {view.periods.length === 0 ? (
        <>
          {toolbar}
          <Refusal
            refusal={{ message: t("runs.noPeriods"), remedy: t("runs.noPeriodsRemedy") }}
            action={{ href: view.periodsSetupHref, label: t("runs.setUpPeriods") }}
          />
        </>
      ) : view.refusal ? (
        <>
          {toolbar}
          <Refusal refusal={view.refusal} action={view.refusalAction} />
        </>
      ) : (
        <>
          {summary}
          {compensation && view.compensation && view.lines === "expense" && (
            <PagedTable
              prepared
              searchable
              source="equity_compensation_lines"
              rows={view.compensation.lines}
              rowKey={(row) => row.securityId}
              urlState={{
                pageKey: "page",
                page: context.list.page,
                searchKey: "q",
                query: context.list.query,
              }}
              {...listSort(context)}
              empty={t("compensation.empty")}
              emptyFiltered={t("compensation.emptyFiltered")}
              toolbarAfter={toolbar}
              columns={[
                {
                  key: "security",
                  header: <>{t("securities.columns.number")}</>,
                  headerClassName: HEAD,
                  className: CELL,
                  cell: (row) => (
                    <Link
                      className={`font-mono ${LINK}`}
                      href={withParams(BASE, context.params, {
                        view: "securities",
                        security: row.securityId,
                        run: undefined,
                        period: undefined,
                        lines: undefined,
                      })}
                    >
                      {row.securityNumber}
                    </Link>
                  ),
                  search: (row) => `${row.securityNumber} ${view.parties[row.holderPartyId] ?? ""}`,
                  sortKey: "security",
                  sortValue: (row) => row.securityNumber,
                },
                {
                  key: "kind",
                  header: <>{t("securities.columns.kind")}</>,
                  headerClassName: HEAD,
                  className: CELL,
                  cell: (row) => <>{t(`kind.${row.kind}`)}</>,
                },
                {
                  key: "holder",
                  header: <>{t("securities.columns.holder")}</>,
                  headerClassName: HEAD,
                  className: CELL,
                  cell: (row) => <>{view.parties[row.holderPartyId] ?? "—"}</>,
                  sortKey: "holder",
                  sortValue: (row) => view.parties[row.holderPartyId] ?? null,
                },
                {
                  key: "cumulative",
                  header: <>{t("compensation.columns.cumulative")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  sortKey: "cumulative",
                  sortType: "decimal",
                  sortValue: (row) => row.cumulative,
                  cell: (row) => <>{money(row.cumulative)}</>,
                },
                {
                  key: "previous",
                  header: <>{t("compensation.columns.previous")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  sortKey: "previous",
                  sortType: "decimal",
                  sortValue: (row) => row.previous,
                  cell: (row) => <>{money(row.previous)}</>,
                },
                {
                  key: "period",
                  header: <>{t("compensation.columns.period")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  sortKey: "period",
                  sortType: "decimal",
                  sortValue: (row) => row.period,
                  cell: (row) => <strong>{money(row.period)}</strong>,
                },
              ]}
            />
          )}
          {compensation && view.compensation && view.lines === "releases" && (
            <PagedTable
              prepared
              searchable
              source="equity_compensation_releases"
              rows={view.compensation.releases}
              rowKey={(row) => row.securityId}
              urlState={{
                pageKey: "page",
                page: context.list.page,
                searchKey: "q",
                query: context.list.query,
              }}
              {...listSort(context)}
              empty={t("compensation.releasesEmpty")}
              emptyFiltered={t("compensation.releasesEmptyFiltered")}
              toolbarAfter={toolbar}
              columns={[
                {
                  key: "security",
                  header: <>{t("securities.columns.number")}</>,
                  headerClassName: HEAD,
                  className: CELL,
                  cell: (row) => (
                    <Link
                      className={`font-mono ${LINK}`}
                      href={withParams(BASE, context.params, {
                        view: "securities",
                        security: row.securityId,
                        run: undefined,
                        period: undefined,
                        lines: undefined,
                      })}
                    >
                      {row.securityNumber}
                    </Link>
                  ),
                  search: (row) => `${row.securityNumber} ${view.parties[row.holderPartyId] ?? ""}`,
                  sortKey: "security",
                  sortValue: (row) => row.securityNumber,
                },
                {
                  key: "holder",
                  header: <>{t("securities.columns.holder")}</>,
                  headerClassName: HEAD,
                  className: CELL,
                  cell: (row) => <>{view.parties[row.holderPartyId] ?? "—"}</>,
                  sortKey: "holder",
                  sortValue: (row) => view.parties[row.holderPartyId] ?? null,
                },
                {
                  key: "shares",
                  header: <>{t("compensation.columns.releasedShares")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  sortKey: "shares",
                  sortType: "decimal",
                  sortValue: (row) => row.shares,
                  cell: (row) => (
                    <>
                      {shares(row.previousShares)} → {shares(row.shares)}
                    </>
                  ),
                },
                {
                  key: "deposit",
                  header: <>{t("compensation.columns.deposit")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  sortKey: "deposit",
                  sortType: "decimal",
                  sortValue: (row) => row.deposit,
                  cell: (row) => <>{money(row.deposit)}</>,
                },
                {
                  key: "reclass",
                  header: <>{t("compensation.columns.reclass")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  sortKey: "reclass",
                  sortType: "decimal",
                  sortValue: (row) => row.reclass,
                  cell: (row) => <>{money(row.reclass)}</>,
                },
                {
                  key: "par",
                  header: <>{t("compensation.columns.par")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  sortKey: "par",
                  sortType: "decimal",
                  sortValue: (row) => row.par,
                  cell: (row) => <>{money(row.par)}</>,
                },
              ]}
            />
          )}
          {!compensation && view.interest && (
            <PagedTable
              prepared
              searchable
              source="equity_interest_lines"
              rows={view.interest.lines}
              rowKey={(row) => row.securityId}
              urlState={{
                pageKey: "page",
                page: context.list.page,
                searchKey: "q",
                query: context.list.query,
              }}
              {...listSort(context)}
              empty={t("interest.empty")}
              emptyFiltered={t("interest.emptyFiltered")}
              toolbarAfter={toolbar}
              columns={[
                {
                  key: "security",
                  header: <>{t("securities.columns.number")}</>,
                  headerClassName: HEAD,
                  className: CELL,
                  cell: (row) => (
                    <Link
                      className={`font-mono ${LINK}`}
                      href={withParams(BASE, context.params, {
                        view: "securities",
                        security: row.securityId,
                        run: undefined,
                        period: undefined,
                        lines: undefined,
                      })}
                    >
                      {row.securityNumber}
                    </Link>
                  ),
                  search: (row) => `${row.securityNumber} ${view.parties[row.holderPartyId] ?? ""}`,
                  sortKey: "security",
                  sortValue: (row) => row.securityNumber,
                },
                {
                  key: "holder",
                  header: <>{t("securities.columns.holder")}</>,
                  headerClassName: HEAD,
                  className: CELL,
                  cell: (row) => <>{view.parties[row.holderPartyId] ?? "—"}</>,
                  sortKey: "holder",
                  sortValue: (row) => view.parties[row.holderPartyId] ?? null,
                },
                {
                  key: "cumulative",
                  header: <>{t("interest.columns.cumulative")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  sortKey: "cumulative",
                  sortType: "decimal",
                  sortValue: (row) => row.cumulative,
                  cell: (row) => <>{money(row.cumulative, { currency: row.currency })}</>,
                },
                {
                  key: "previous",
                  header: <>{t("interest.columns.previous")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  sortKey: "previous",
                  sortType: "decimal",
                  sortValue: (row) => row.previous,
                  cell: (row) => <>{money(row.previous, { currency: row.currency })}</>,
                },
                {
                  key: "period",
                  header: <>{t("interest.columns.period")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  sortKey: "period",
                  sortType: "decimal",
                  sortValue: (row) => row.period,
                  cell: (row) => <strong>{money(row.period, { currency: row.currency })}</strong>,
                },
                {
                  key: "functional",
                  header: <>{t("interest.columns.functional")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  sortKey: "functional",
                  sortType: "decimal",
                  sortValue: (row) => row.functional,
                  cell: (row) => <>{money(row.functional)}</>,
                },
              ]}
            />
          )}
        </>
      )}
      {view.historyOpen && <RunHistoryDrawer view={view} />}
    </div>
  );
}

/** The runs posted for the legal entity, latest first, each with the journal entry it posted. */
function RunHistoryDrawer({ view }: { view: RunsViewData }) {
  const t = useTranslations("equity");
  const { money } = useMoney();
  const date = useCivilDate();
  const compensation = view.run === "compensation";
  return (
    <UrlDrawer
      open
      openKey={view.run}
      closeHref={view.historyCloseHref}
      size="lg"
      title={compensation ? t("runs.historyTitle.compensation") : t("runs.historyTitle.interest")}
      description={t("runs.historyDescription")}
    >
      <div className="p-4">
        {compensation ? (
          <PagedTable
            prepared
            source="equity_compensation_runs"
            rows={view.compensationRuns}
            rowKey={(row) => row.id}
            empty={t("compensation.runsEmpty")}
            searchable={false}
            columns={[
              {
                key: "through",
                header: <>{t("compensation.columns.through")}</>,
                headerClassName: HEAD,
                className: DATE_CELL,
                cell: (row) => <>{date(row.throughDate)}</>,
              },
              {
                key: "total",
                header: <>{t("compensation.columns.total")}</>,
                headerClassName: NUM_HEAD,
                className: NUM_CELL,
                cell: (row) => <>{money(row.total, { currency: row.currency })}</>,
              },
              {
                key: "entry",
                header: <>{t("compensation.columns.entry")}</>,
                headerClassName: HEAD,
                className: `${CELL} font-mono`,
                cell: (row) => <RunEntry id={row.journalEntryId} number={row.entryNumber} />,
              },
              {
                key: "releaseTotal",
                header: <>{t("compensation.columns.releaseTotal")}</>,
                headerClassName: NUM_HEAD,
                className: NUM_CELL,
                cell: (row) => <>{money(row.releaseTotal, { currency: row.currency })}</>,
              },
              {
                key: "releaseEntry",
                header: <>{t("compensation.columns.releaseEntry")}</>,
                headerClassName: HEAD,
                className: `${CELL} font-mono`,
                cell: (row) => (
                  <RunEntry id={row.releaseJournalEntryId} number={row.releaseEntryNumber} />
                ),
              },
            ]}
          />
        ) : (
          <PagedTable
            prepared
            source="equity_interest_runs"
            rows={view.interestRuns}
            rowKey={(row) => row.id}
            empty={t("interest.runsEmpty")}
            searchable={false}
            columns={[
              {
                key: "through",
                header: <>{t("compensation.columns.through")}</>,
                headerClassName: HEAD,
                className: DATE_CELL,
                cell: (row) => <>{date(row.throughDate)}</>,
              },
              {
                key: "total",
                header: <>{t("compensation.columns.total")}</>,
                headerClassName: NUM_HEAD,
                className: NUM_CELL,
                cell: (row) => <>{money(row.total, { currency: row.currency })}</>,
              },
              {
                key: "entry",
                header: <>{t("compensation.columns.entry")}</>,
                headerClassName: HEAD,
                className: `${CELL} font-mono`,
                cell: (row) => <RunEntry id={row.journalEntryId} number={row.entryNumber} />,
              },
            ]}
          />
        )}
      </div>
    </UrlDrawer>
  );
}

/** A run's posted entry, opened over the page through the native journal-entry link. */
function RunEntry({ id, number }: { id: string | null; number: string | null }) {
  const t = useTranslations("equity");
  if (!id) return <>{t("compensation.noEntry")}</>;
  return (
    <JournalEntryLink className={LINK} entryId={id}>
      {number ?? t("drawer.viewEntry")}
    </JournalEntryLink>
  );
}
