"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { SlidersHorizontal } from "lucide-react";
import { Badge, EmptyState, Popover, Select, TableCell, TableRow, cn } from "@openbooks/ui";
import type { WaterfallScenario } from "@openbooks/engine/equity";
import {
  add,
  cmp,
  formatMoney as fixedPlaces,
  isZero,
  neg,
  sum,
} from "@openbooks/engine/money/money";
import { PagedTable } from "@/components/paged-table";
import { ListFilterSelect } from "@/components/list-filter-select";
import { HomePanel, HomeStatTile } from "@/components/module-home/client";
import { MoneyInput, useGroupedAmountRefusal } from "@/components/money-input";
import { MoneyProvider, useMoney } from "@/components/money-provider";
import { ApiResponseError, apiJson } from "@/lib/api-error";
import { toChartNumber } from "@/lib/chart-number";
import { formatExactPercent } from "@/lib/format";
import { formatDecimal } from "@/lib/money-format";
import { perShareFormatOptions } from "@/lib/equity-price";
import {
  cleanDecimal,
  conversionDecisions,
  currencyDecimalPlaces,
  curveSeries,
  decisionMessageKey,
  displayedAmounts,
  payoutLines,
  percentOf,
  waterfallSteps,
  type PayoutLine,
  type RecipientKey,
  type WaterfallStep,
} from "@/lib/equity-waterfall";
import { TrendChart, Waterfall } from "../analytics/_ui/charts";
import {
  EQUITY_EXIT_COLOR,
  waterfallRecipientColor,
  waterfallStepColor,
} from "@/lib/equity-colors";
import { EquityAsOfControl } from "./AsOfControl";
import type { WaterfallViewData } from "./view";
import { CELL, HEAD, NUM_CELL, NUM_HEAD, Refusal, TOTAL_ROW } from "./shared";

const DECIMAL = /^\d+(\.\d{1,4})?$/;
/** Amounts, prices and percentages stay on one line in narrow columns. */
const NUM = cn(NUM_CELL, "whitespace-nowrap");
const NUM_H = cn(NUM_HEAD, "whitespace-nowrap");

type Inputs = WaterfallViewData["inputs"];
type PayoutsBy = "class" | "holder";
type ScenarioRefusal = { message: string; remedy: string };
/** The latest answer for one set of inputs: the scenario, or the refusal that replaced it. */
type Outcome = { key: string; scenario: WaterfallScenario | null; refusal: ScenarioRefusal | null };

/** The inputs a computed scenario answers, compared by exact value rather than spelling. */
const scenarioKey = (inputs: Inputs) =>
  JSON.stringify([
    cleanDecimal(inputs.exitValue),
    cleanDecimal(inputs.transactionFees),
    inputs.unvestedAwards,
    inputs.changeOfControl,
    inputs.terminated,
  ]);

/** Keep the scenario in the URL so a reload or a shared link opens it. */
function replaceParams(values: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  window.history.replaceState(null, "", `${url.pathname}?${url.searchParams.toString()}`);
}

/** A refused request as its named refusal and remedy; a request that never got an answer names the failure. */
function refusalOf(error: unknown, failed: string, retry: string): ScenarioRefusal {
  if (!(error instanceof ApiResponseError)) return { message: failed, remedy: retry };
  const body =
    error.body !== null && typeof error.body === "object"
      ? (error.body as { error?: unknown; remedy?: unknown })
      : {};
  if (
    typeof body.error === "string" &&
    body.error.trim() !== "" &&
    typeof body.remedy === "string" &&
    body.remedy.trim() !== ""
  ) {
    return { message: body.error.trim(), remedy: body.remedy.trim() };
  }
  return { message: error.message, remedy: retry };
}

/**
 * The exit waterfall: an exit value distributed through the preference
 * stack on the as-of date, recomputed as the inputs change. It opens on the
 * latest priced round's post-money valuation with preset multiples, and
 * shows the payment cascade, each elector's choice with the amounts behind
 * it, the proceeds of every class across exit values, and the payouts by
 * class or holder. Nothing is recorded.
 */
export function EquityWaterfallPanel({ view }: { view: WaterfallViewData | null }) {
  if (!view) return null;
  // A new entity or date is a new book: the scenario state starts again from
  // the server's first paint. Amounts and charts read in the entity's currency.
  return (
    <MoneyProvider currency={view.context.currency}>
      <WaterfallScenarioView
        key={`${view.context.subsidiaryId}:${view.context.asOf}`}
        view={view}
      />
    </MoneyProvider>
  );
}

function WaterfallScenarioView({ view }: { view: WaterfallViewData }) {
  const t = useTranslations("equity");
  const { money, locale } = useMoney();
  const amountRefusal = useGroupedAmountRefusal();
  const { context } = view;
  const [inputs, setInputs] = useState<Inputs>(() => ({
    ...view.inputs,
    exitValue: cleanDecimal(view.inputs.exitValue),
    transactionFees: cleanDecimal(view.inputs.transactionFees),
  }));
  const [outcome, setOutcome] = useState<Outcome>(() => ({
    key: scenarioKey(view.inputs),
    scenario: view.scenario,
    refusal: view.refusal,
  }));
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const [payoutsBy, setPayoutsBy] = useState<PayoutsBy>(
    view.inputs.payoutsBy === "holder" ? "holder" : "class",
  );
  const sequence = useRef(0);

  const exitBlank = inputs.exitValue === "";
  const invalid: "exit" | "fees" | null =
    !exitBlank && !DECIMAL.test(inputs.exitValue)
      ? "exit"
      : inputs.transactionFees !== "" && !DECIMAL.test(inputs.transactionFees)
        ? "fees"
        : null;
  const valid = !exitBlank && invalid === null;
  const key = scenarioKey(inputs);
  const pending = valid && outcome.key !== key;

  useEffect(() => {
    if (!valid || outcome.key === key) {
      // Nothing to compute: an answer still in flight is for other inputs.
      sequence.current += 1;
      return;
    }
    const id = ++sequence.current;
    const timer = window.setTimeout(async () => {
      let next: Outcome;
      try {
        const scenario = await apiJson<WaterfallScenario>(
          "/api/equity/models/waterfall",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              subsidiaryId: context.subsidiaryId,
              asOf: context.asOf,
              exitValue: inputs.exitValue,
              transactionFees: inputs.transactionFees || null,
              unvestedAwards: inputs.unvestedAwards,
              changeOfControl: inputs.changeOfControl,
              terminated: inputs.terminated,
            }),
          },
          t("waterfall.failed"),
        );
        next = { key, scenario, refusal: null };
      } catch (error) {
        // A refused scenario replaces the previous one: its results no longer answer the inputs.
        next = {
          key,
          scenario: null,
          refusal: refusalOf(error, t("waterfall.failed"), t("waterfall.retry")),
        };
      }
      if (id === sequence.current) setOutcome(next);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [key, valid, outcome.key, inputs, context.subsidiaryId, context.asOf, t]);

  const update = (patch: Partial<Inputs>) => {
    const next = { ...inputs, ...patch };
    setInputs(next);
    replaceParams({
      exit: next.exitValue || null,
      fees: next.transactionFees || null,
      unvested: next.unvestedAwards === "cancel" ? "cancel" : null,
      coc: next.changeOfControl ? null : "0",
      terminated: next.terminated ? "1" : null,
    });
  };
  const choosePayouts = (next: PayoutsBy) => {
    setPayoutsBy(next);
    replaceParams({ payouts: next === "holder" ? "holder" : null });
  };
  const isPreset = (value: string) =>
    DECIMAL.test(inputs.exitValue) && cmp(value, inputs.exitValue) === 0;

  const bar = (
    <EquityAsOfControl
      control={view.asOfControl}
      compact={false}
      leading={
        <>
          <label className="flex shrink-0 items-center gap-1.5">
            <span className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
              {t("waterfall.exitValue")}
            </span>
            <MoneyInput
              grouped
              showError={false}
              field={t("waterfall.exitValue")}
              ariaLabel={t("waterfall.exitValue")}
              value={inputs.exitValue}
              invalid={invalid === "exit"}
              onChange={(value) => update({ exitValue: value.trim() })}
              className="h-8 w-40 tabular-nums"
              placeholder={formatDecimal(locale, "25000000", { maximumFractionDigits: 0 })}
            />
          </label>
          {view.presets.length > 0 && (
            <div
              className="flex shrink-0 items-center gap-1"
              role="group"
              aria-label={t("waterfall.presets", { round: view.anchor?.roundName ?? "" })}
            >
              {view.presets.map((preset) => (
                <button
                  key={preset.multiple}
                  type="button"
                  aria-pressed={isPreset(preset.value)}
                  title={money(preset.value)}
                  onClick={() => update({ exitValue: cleanDecimal(preset.value) })}
                  className={cn(
                    "h-7 rounded-full px-2.5 text-xs font-medium tabular-nums transition-colors",
                    isPreset(preset.value)
                      ? "bg-teal-600 text-white dark:bg-teal-500"
                      : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800",
                  )}
                >
                  {`${formatDecimal(locale, preset.multiple, { minimumFractionDigits: 0, maximumFractionDigits: 4 })}×`}
                </button>
              ))}
            </div>
          )}
          <label className="flex shrink-0 items-center gap-1.5">
            <span className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
              {t("waterfall.fees")}
            </span>
            <MoneyInput
              grouped
              showError={false}
              field={t("waterfall.fees")}
              ariaLabel={t("waterfall.fees")}
              value={inputs.transactionFees}
              invalid={invalid === "fees"}
              onChange={(value) => update({ transactionFees: value.trim() })}
              className="h-8 w-32 tabular-nums"
              placeholder="0"
            />
          </label>
        </>
      }
      actions={
        <>
          {pending && (
            <span className="text-xs text-slate-400" role="status">
              {t("waterfall.updating")}
            </span>
          )}
          <Popover
            open={assumptionsOpen}
            onOpenChange={setAssumptionsOpen}
            align="end"
            label={t("waterfall.assumptions")}
            trigger={
              <button
                type="button"
                onClick={() => setAssumptionsOpen((open) => !open)}
                className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                <SlidersHorizontal size={14} /> {t("waterfall.assumptions")}
              </button>
            }
          >
            <div className="w-72 space-y-3 p-3 text-sm">
              <label className="flex items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">
                  {t("waterfall.unvested")}
                </span>
                <Select
                  value={inputs.unvestedAwards}
                  onChange={(e) =>
                    update({
                      unvestedAwards: e.target.value === "cancel" ? "cancel" : "participate",
                    })
                  }
                  className="h-8 w-48"
                >
                  <option value="participate">{t("waterfall.unvestedParticipate")}</option>
                  <option value="cancel">{t("waterfall.unvestedCancel")}</option>
                </Select>
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">
                  {t("waterfall.changeOfControl")}
                </span>
                <input
                  type="checkbox"
                  checked={inputs.changeOfControl}
                  onChange={(e) => update({ changeOfControl: e.target.checked })}
                  className="h-4 w-4 accent-teal-600"
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-2">
                <span className="text-slate-500 dark:text-slate-400">
                  {t("waterfall.terminated")}
                </span>
                <input
                  type="checkbox"
                  checked={inputs.terminated}
                  onChange={(e) => update({ terminated: e.target.checked })}
                  className="h-4 w-4 accent-teal-600"
                />
              </label>
              <p className="text-xs text-slate-400 dark:text-slate-500">
                {t("waterfall.assumptionsHelp")}
              </p>
            </div>
          </Popover>
        </>
      }
    />
  );

  // The field's own reading of what was typed names the cause in the
  // viewer's notation; an amount it reads but the scenario cannot take (a
  // negative one) is refused by the waterfall's own rule.
  const inputRefusal = (field: "exit" | "fees"): ScenarioRefusal => {
    const raw = field === "exit" ? inputs.exitValue : inputs.transactionFees;
    const example = formatDecimal(locale, field === "exit" ? "25000000" : "750000", {
      maximumFractionDigits: 0,
    });
    return (
      amountRefusal(t(field === "exit" ? "waterfall.exitValue" : "waterfall.fees"), raw) ?? {
        message: t(`waterfall.invalid.${field}`),
        remedy: t(`waterfall.invalid.${field}Remedy`, { example }),
      }
    );
  };
  const prompt = (
    <EmptyState
      title={t("waterfall.promptTitle")}
      description={
        view.anchor
          ? t("waterfall.prompt")
          : t("waterfall.promptNoRound", { currency: context.currency })
      }
    />
  );
  // One body at a time: the results answer exactly the inputs shown, and a
  // refusal (from the inputs or from the computation) takes their place.
  let body: ReactNode;
  if (exitBlank) body = prompt;
  else if (invalid) body = <Refusal refusal={inputRefusal(invalid)} />;
  else if (outcome.refusal)
    body = (
      <div className={cn("transition-opacity", pending && "opacity-60")} aria-busy={pending}>
        <Refusal refusal={outcome.refusal} />
      </div>
    );
  else if (outcome.scenario)
    body = (
      <WaterfallResults
        scenario={outcome.scenario}
        classOrder={view.classOrder}
        pending={pending}
        payoutsBy={payoutsBy}
        onPayoutsBy={choosePayouts}
      />
    );
  else body = prompt;

  return (
    <div className="space-y-4">
      {bar}
      {body}
    </div>
  );
}

function WaterfallResults({
  scenario,
  classOrder,
  pending,
  payoutsBy,
  onPayoutsBy,
}: {
  scenario: WaterfallScenario;
  /** Share classes in creation order: each class keeps the colour the ownership donut gives it. */
  classOrder: readonly string[];
  pending: boolean;
  payoutsBy: PayoutsBy;
  onPayoutsBy: (value: PayoutsBy) => void;
}) {
  const t = useTranslations("equity");
  const { money, moneyCompact, currency, locale } = useMoney();
  const result = scenario.result;
  const steps = useMemo(
    () => waterfallSteps(result, scenario.transactionFees),
    [result, scenario.transactionFees],
  );
  const lines = useMemo(() => payoutLines(result), [result]);
  const decisions = useMemo(() => conversionDecisions(result), [result]);
  const curve = useMemo(() => curveSeries(scenario.curve), [scenario.curve]);
  const places = currencyDecimalPlaces(currency);
  const nothingToShare = isZero(result.exitValue);

  const price = (value: string) => money(value, perShareFormatOptions(value));
  /** A two-place percentage, localized; a dash when there are no proceeds to share. */
  const percentLabel = (value: string | null) =>
    value === null || nothingToShare ? "—" : formatExactPercent(fixedPlaces(value, 2), locale, 2);
  const shareOfProceeds = (part: string) => {
    const percent = percentOf(part, result.exitValue);
    return percent === null
      ? t("waterfall.tiles.noShare")
      : t("waterfall.tiles.ofProceeds", {
          percent: formatDecimal(locale, percent, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }),
        });
  };
  const codeOf = (key: RecipientKey) =>
    key.startsWith("class:")
      ? (result.classes.find((row) => `class:${row.shareClassId}` === key)?.code ?? "")
      : "";
  const recipientLabel = (key: RecipientKey) =>
    key.startsWith("class:")
      ? codeOf(key)
      : key === "safes"
        ? t("kindPlural.safe")
        : t(`waterfall.recipients.${key as "awards" | "notes" | "unallocated"}`);
  const stepLabel = (step: WaterfallStep) => {
    switch (step.kind) {
      case "preference":
        return t("waterfall.steps.preference", { code: step.code ?? "" });
      case "participation":
        return result.classes.find(
          (row) => row.code === step.code && row.kind === "preferred" && !row.converted,
        )
          ? t("waterfall.steps.participation", { code: step.code ?? "" })
          : (step.code ?? "");
      default:
        return t(`waterfall.steps.${step.kind}`);
    }
  };

  const preferredTotal = sum(
    result.classes.filter((row) => row.kind === "preferred").map((row) => row.total),
  );
  const commonTotal = add(
    sum(result.classes.filter((row) => row.kind !== "preferred").map((row) => row.total)),
    sum(result.payouts.filter((row) => row.kind === "award").map((row) => row.amount)),
  );
  const payoutsFilter = <PayoutsFilter value={payoutsBy} onChange={onPayoutsBy} />;

  return (
    <div
      className={cn("space-y-4 transition-opacity", pending && "opacity-60")}
      aria-busy={pending}
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <HomeStatTile
          icon="wallet"
          accent="teal"
          label={t("waterfall.tiles.proceeds")}
          value={moneyCompact(result.exitValue)}
          sub={
            cmp(scenario.transactionFees, "0") > 0
              ? t("waterfall.tiles.proceedsSub", {
                  exit: moneyCompact(scenario.grossExitValue),
                  fees: moneyCompact(scenario.transactionFees),
                })
              : t("waterfall.tiles.noFees")
          }
        />
        <HomeStatTile
          icon="trending-up"
          accent="sky"
          label={t("waterfall.pricePerShare")}
          value={price(result.pricePerCommonShare)}
          sub={t("waterfall.tiles.priceSub")}
        />
        <HomeStatTile
          icon="scale"
          accent="violet"
          label={t("waterfall.tiles.preferred")}
          value={moneyCompact(preferredTotal)}
          sub={shareOfProceeds(preferredTotal)}
        />
        <HomeStatTile
          icon="users"
          accent="emerald"
          label={t("waterfall.tiles.common")}
          value={moneyCompact(commonTotal)}
          sub={shareOfProceeds(commonTotal)}
        />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <HomePanel
          title={t("waterfall.cascadeTitle")}
          icon="area-chart"
          hint={t("waterfall.cascadeHint")}
          className="lg:col-span-2"
        >
          <Waterfall
            magnitudeLabels
            height={280}
            steps={[
              {
                label: t("waterfall.steps.exit"),
                amount: scenario.grossExitValue,
                kind: "start",
                color: EQUITY_EXIT_COLOR,
              },
              ...steps.map((step) => ({
                label: stepLabel(step),
                amount: neg(step.amount),
                kind: "deduct" as const,
                color: waterfallStepColor(step, classOrder),
              })),
            ]}
          />
        </HomePanel>
        <HomePanel title={t("waterfall.decisionsTitle")} icon="scale" bodyClassName="p-0">
          {decisions.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
              {t("waterfall.noDecisions")}
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {decisions.map((decision) => {
                const converted =
                  decision.decision === "converts" || decision.decision === "safe_converts";
                const name =
                  decision.subject === "class"
                    ? decision.code
                    : (scenario.parties[decision.holderPartyId ?? ""] ?? t("kind.safe"));
                const amounts = {
                  amount: money(decision.amount),
                  entitlement: money(decision.entitlement),
                  paid: decision.paid ? money(decision.paid) : "",
                  alternative: decision.alternative ? money(decision.alternative) : "",
                  cap: decision.cap ? money(decision.cap) : "",
                };
                return (
                  <li key={decision.key} className="space-y-1 px-4 py-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          "font-medium text-slate-800 dark:text-slate-100",
                          decision.subject === "class" && "font-mono",
                        )}
                      >
                        {name}
                      </span>
                      <Badge variant={converted ? "success" : "secondary"}>
                        {converted ? t("waterfall.converts") : t("waterfall.takesPreference")}
                      </Badge>
                    </div>
                    <p className="text-slate-500 dark:text-slate-400">
                      {t(`waterfall.decisions.${decisionMessageKey(decision)}`, amounts)}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </HomePanel>
      </div>
      {curve.series.length > 0 && (
        <HomePanel
          title={t("waterfall.curveTitle")}
          icon="trending-up"
          hint={t("waterfall.curveHint")}
        >
          <TrendChart
            height={260}
            labels={curve.exitValues.map((value) => moneyCompact(value))}
            xValues={curve.exitValues.map((value) => toChartNumber(value))}
            series={curve.series.map((series) => ({
              name: recipientLabel(series.key),
              color: waterfallRecipientColor(series.key, classOrder),
              data: series.data.map((value) => toChartNumber(value)),
            }))}
          />
        </HomePanel>
      )}
      {payoutsBy === "class" ? (
        <PagedTable
          prepared
          source="equity_waterfall_classes"
          rows={lines}
          rowKey={(row) => row.key}
          empty={t("waterfall.empty")}
          searchable={false}
          toolbarAfter={payoutsFilter}
          columns={[
            {
              key: "recipient",
              header: <>{t("waterfall.columns.recipient")}</>,
              headerClassName: HEAD,
              className: CELL,
              cell: (row: PayoutLine) => (
                <span className={row.code ? "font-mono font-medium" : ""}>
                  {recipientLabel(row.key)}
                </span>
              ),
            },
            {
              key: "election",
              header: <>{t("waterfall.columns.election")}</>,
              headerClassName: HEAD,
              className: CELL,
              cell: (row: PayoutLine) => (
                <>
                  {row.converted === null
                    ? "—"
                    : row.converted
                      ? t("waterfall.converts")
                      : t("waterfall.takesPreference")}
                </>
              ),
            },
            {
              key: "preference",
              header: <>{t("waterfall.columns.preference")}</>,
              headerClassName: NUM_H,
              className: NUM,
              cell: (row: PayoutLine) => {
                const shown = displayedAmounts(row, places).preference;
                return <>{shown === null ? "—" : money(shown)}</>;
              },
            },
            {
              key: "participation",
              header: <>{t("waterfall.columns.participation")}</>,
              headerClassName: NUM_H,
              className: NUM,
              cell: (row: PayoutLine) => {
                const shown = displayedAmounts(row, places).participation;
                return <>{shown === null ? "—" : money(shown)}</>;
              },
            },
            {
              key: "total",
              header: <>{t("waterfall.columns.total")}</>,
              headerClassName: NUM_H,
              className: NUM,
              cell: (row: PayoutLine) => (
                <strong>{money(displayedAmounts(row, places).total)}</strong>
              ),
            },
            {
              key: "perShare",
              header: <>{t("waterfall.columns.perShare")}</>,
              headerClassName: NUM_H,
              className: NUM,
              cell: (row: PayoutLine) => <>{row.perShare ? price(row.perShare) : "—"}</>,
            },
            {
              key: "percent",
              header: <>{t("waterfall.columns.percent")}</>,
              headerClassName: NUM_H,
              className: NUM,
              cell: (row: PayoutLine) => <>{percentLabel(row.percent)}</>,
            },
          ]}
          footer={
            <TableRow className={TOTAL_ROW}>
              <TableCell className={CELL} colSpan={4}>
                {t("waterfall.columns.total")}
              </TableCell>
              <TableCell className={NUM}>{money(result.exitValue)}</TableCell>
              <TableCell className={NUM} />
              <TableCell className={NUM}>{percentLabel("100")}</TableCell>
            </TableRow>
          }
        />
      ) : (
        <PagedTable
          prepared
          searchable
          source="equity_waterfall_holders"
          rows={result.holders}
          rowKey={(row) => row.holderPartyId}
          empty={t("waterfall.empty")}
          emptyFiltered={t("waterfall.holdersEmptyFiltered")}
          toolbarAfter={payoutsFilter}
          columns={[
            {
              key: "holder",
              header: <>{t("capTable.columns.holder")}</>,
              headerClassName: HEAD,
              className: CELL,
              cell: (row) => <>{scenario.parties[row.holderPartyId] ?? row.holderPartyId}</>,
              search: (row) => scenario.parties[row.holderPartyId] ?? "",
            },
            {
              key: "amount",
              header: <>{t("waterfall.columns.payout")}</>,
              headerClassName: NUM_H,
              className: NUM,
              cell: (row) => <strong>{money(row.amount)}</strong>,
            },
            {
              key: "percent",
              header: <>{t("waterfall.columns.percent")}</>,
              headerClassName: NUM_H,
              className: NUM,
              cell: (row) => <>{percentLabel(row.percent)}</>,
            },
          ]}
        />
      )}
    </div>
  );
}

function PayoutsFilter({
  value,
  onChange,
}: {
  value: PayoutsBy;
  onChange: (value: PayoutsBy) => void;
}) {
  const t = useTranslations("equity");
  return (
    <ListFilterSelect
      basePath="/equity"
      currentParams={{}}
      paramKey="payouts"
      pageParamKey={null}
      label={t("waterfall.payoutsBy")}
      value={value}
      onValueChange={(next) => onChange(next === "holder" ? "holder" : "class")}
      options={[
        { value: "class", label: t("waterfall.byClass") },
        { value: "holder", label: t("waterfall.byHolder") },
      ]}
    />
  );
}
