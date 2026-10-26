"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  UrlDrawer,
} from "@openbooks/ui";
import type { RoundModelResult } from "@openbooks/engine/equity";
import { add } from "@openbooks/engine/money/money";
import { PagedTable } from "@/components/paged-table";
import { MoneyInput } from "@/components/money-input";
import { useMoney } from "@/components/money-provider";
import { perShareFormatOptions } from "@/lib/equity-price";
import { formatDecimal } from "@/lib/money-format";
import { useAppAction } from "@/lib/use-app-action";
import type { EquityContext, RoundsViewData } from "./view";
import { DateField } from "@/components/date-field";
import {
  CELL,
  CommandRefusal,
  DATE_CELL,
  Field,
  HEAD,
  LINK,
  NUM_CELL,
  NUM_HEAD,
  PendingActions,
  SegmentTabs,
  Stat,
  listSort,
  postCommand,
  toastGoverned,
  useCivilDate,
  usePercent,
  usePrice,
  useShares,
  withParams,
} from "./shared";

type RoundRow = RoundsViewData["structure"]["rounds"][number];

/**
 * Priced financing rounds of the legal entity, with the round modeller one
 * click away in its drawer (`?model=round`): a pro-forma priced round against
 * the cap table on the as-of date. Nothing the modeller shows is recorded.
 * Each round opens in its drawer (`?round=<id>`) with its basis and history;
 * approvers amend it, or void one recorded in error, through governed
 * actions. Voided rounds stay listed for history, out of every figure.
 */
export function EquityRoundsPanel({ view }: { view: RoundsViewData | null }) {
  const t = useTranslations("equity");
  const shares = useShares();
  const date = useCivilDate();
  const price = usePrice();
  const { money } = useMoney();
  if (!view) return null;
  const classCodes = new Map(view.structure.classes.map((row) => [row.id, row.code]));
  const voided = new Map(view.structure.voidedRounds.map((row) => [row.id, row]));
  const rows: (RoundRow & { voidedOn: string | null })[] = [
    ...view.structure.rounds.map((row) => ({ ...row, voidedOn: null })),
    ...view.structure.voidedRounds.map((row) => ({
      id: row.id,
      name: row.name,
      shareClassId: "",
      closedOn: row.closedOn,
      pricePerShare: row.pricePerShare,
      preMoneyValuation: row.preMoneyValuation,
      currency: row.currency,
      raised: "0.0000",
      sharesIssued: "0",
      preMoneyBasisReason: null,
      fullyDilutedBefore: "0",
      impliedPreMoney: "0.0000",
      preMoneyDrift: null,
      conversionDrift: [],
      liveSecurities: [],
      amendments: [],
      voidedOn: row.voidedOn,
    })),
  ];
  const selected = view.structure.rounds.find((row) => row.id === view.roundId) ?? null;
  const selectedVoid = view.roundId ? (voided.get(view.roundId) ?? null) : null;
  return (
    <div className="space-y-3">
      <PendingActions
        context={view.context}
        filter={(request) =>
          request.action === "round_amendment" || request.action === "round_void"
        }
      />
      <PagedTable
        prepared
        searchable
        source="equity_rounds"
        rows={rows}
        rowClassName={(row) => (row.voidedOn ? "text-slate-400 dark:text-slate-500" : undefined)}
        rowKey={(row) => row.id}
        empty={t("rounds.empty")}
        emptyFiltered={t("rounds.emptyFiltered")}
        urlState={{
          pageKey: "page",
          page: view.context.list.page,
          searchKey: "q",
          query: view.context.list.query,
        }}
        {...listSort(view.context)}
        toolbarAfter={
          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={view.modelHref}>{t("rounds.model")}</Link>
            </Button>
          </div>
        }
        columns={[
          {
            key: "name",
            header: <>{t("rounds.columns.name")}</>,
            headerClassName: HEAD,
            className: `${CELL} font-medium`,
            search: (row) => row.name,
            sortKey: "name",
            sortValue: (row) => row.name,
            cell: (row) => (
              <span className="flex items-center gap-2">
                <Link
                  className={LINK}
                  href={
                    withParams("/equity", view.context.params, {
                      view: "rounds",
                      round: row.id,
                      model: undefined,
                    }) as never
                  }
                >
                  {row.name}
                </Link>
                {row.voidedOn && <Badge variant="outline">{t("rounds.voidedBadge")}</Badge>}
                {(row.preMoneyDrift || row.conversionDrift.length > 0) && (
                  <Badge variant="warning">{t("rounds.driftBadge")}</Badge>
                )}
              </span>
            ),
          },
          {
            key: "class",
            header: <>{t("rounds.columns.class")}</>,
            headerClassName: HEAD,
            className: `${CELL} font-mono`,
            cell: (row) => <>{classCodes.get(row.shareClassId) ?? "—"}</>,
            search: (row) => classCodes.get(row.shareClassId) ?? "",
            sortKey: "class",
            sortValue: (row) => classCodes.get(row.shareClassId) ?? null,
          },
          {
            key: "closed",
            header: <>{t("rounds.columns.closedOn")}</>,
            headerClassName: HEAD,
            className: DATE_CELL,
            cell: (row) => <>{date(row.closedOn)}</>,
            sortKey: "closed",
            sortValue: (row) => row.closedOn,
          },
          {
            key: "price",
            header: <>{t("rounds.columns.price")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <>{price(row.pricePerShare, row.currency)}</>,
            sortKey: "price",
            sortType: "decimal",
            sortValue: (row) => row.pricePerShare,
          },
          {
            key: "preMoney",
            header: <>{t("rounds.columns.preMoney")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <>{money(row.preMoneyValuation, { currency: row.currency })}</>,
            sortKey: "preMoney",
            sortType: "decimal",
            sortValue: (row) => row.preMoneyValuation,
          },
          {
            key: "raised",
            header: <>{t("rounds.columns.raised")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => (
              <>{row.voidedOn ? "—" : money(row.raised, { currency: row.currency })}</>
            ),
            sortKey: "raised",
            sortType: "decimal",
            sortValue: (row) => (row.voidedOn ? null : row.raised),
          },
          {
            key: "postMoney",
            header: <>{t("rounds.columns.postMoney")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) =>
              row.voidedOn ? (
                <>—</>
              ) : (
                <strong>
                  {money(add(row.preMoneyValuation, row.raised), { currency: row.currency })}
                </strong>
              ),
          },
          {
            key: "shares",
            header: <>{t("rounds.columns.shares")}</>,
            headerClassName: NUM_HEAD,
            className: NUM_CELL,
            cell: (row) => <>{row.voidedOn ? "—" : shares(row.sharesIssued)}</>,
          },
        ]}
      />
      {view.modelOpen && (
        <RoundModelDrawer context={view.context} closeHref={view.modelCloseHref} />
      )}
      {selected && (
        <RoundDrawer
          round={selected}
          context={view.context}
          classCode={classCodes.get(selected.shareClassId) ?? ""}
          closeHref={view.roundCloseHref}
        />
      )}
      {selectedVoid && (
        <UrlDrawer
          open
          openKey={selectedVoid.id}
          closeHref={view.roundCloseHref}
          title={selectedVoid.name}
          description={t("rounds.voidedDescription", { date: date(selectedVoid.voidedOn) })}
        >
          <div className="space-y-2 p-4 text-sm">
            <p>{t("rounds.voidedReason", { reason: selectedVoid.reason })}</p>
          </div>
        </UrlDrawer>
      )}
    </div>
  );
}

/**
 * One round: its terms and the basis of its pre-money valuation, the
 * amendments recorded to it, and, for approvers, its governed amendment or
 * void. A round in which live securities stand keeps its price and date and
 * cannot be voided; the drawer names those securities.
 */
function RoundDrawer({
  round,
  context,
  classCode,
  closeHref,
}: {
  round: RoundRow;
  context: EquityContext;
  classCode: string;
  closeHref: string;
}) {
  const t = useTranslations("equity");
  const router = useRouter();
  const shares = useShares();
  const date = useCivilDate();
  const price = usePrice();
  const { money, locale } = useMoney();
  const { busy, refusal, execute, clearRefusal } = useAppAction();
  const [mode, setModeState] = useState<"amend" | "void">("amend");
  // A refusal answers the action it was given for; another action starts clean.
  const setMode = (next: "amend" | "void") => {
    setModeState(next);
    clearRefusal();
  };
  const [form, setForm] = useState({
    effectiveOn: context.asOf,
    name: round.name,
    pricePerShare: "",
    preMoneyValuation: "",
    preMoneyBasisReason: "",
    reason: "",
  });
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const locked = round.liveSecurities.length > 0;
  const failed = t("rounds.actionFailed");
  async function submit() {
    const idempotencyKey = `${round.id}:${mode}:${crypto.randomUUID()}`;
    const body =
      mode === "void"
        ? { effectiveOn: form.effectiveOn, reason: form.reason, idempotencyKey }
        : {
            effectiveOn: form.effectiveOn,
            reason: form.reason,
            idempotencyKey,
            name: form.name.trim() && form.name.trim() !== round.name ? form.name.trim() : null,
            pricePerShare: form.pricePerShare.trim() || null,
            preMoneyValuation: form.preMoneyValuation.trim() || null,
            preMoneyBasisReason: form.preMoneyBasisReason.trim() || null,
          };
    await execute(
      () =>
        postCommand(
          `/api/equity/rounds/${round.id}/${mode === "void" ? "void" : "amendments"}`,
          body,
          failed,
        ),
      {
        fallbackMessage: failed,
        onOk: (result) => {
          toastGoverned(
            result,
            mode === "void" ? t("rounds.voided") : t("rounds.amended"),
            t("approval.submitted"),
          );
          router.push(closeHref as never);
          router.refresh();
        },
      },
    );
  }
  const changes =
    form.name.trim() !== round.name ||
    form.pricePerShare.trim() !== "" ||
    form.preMoneyValuation.trim() !== "" ||
    form.preMoneyBasisReason.trim() !== "";
  const ready =
    form.effectiveOn && form.reason.trim().length >= 5 && (mode === "void" ? !locked : changes);
  return (
    <UrlDrawer
      open
      openKey={round.id}
      size="xl"
      closeHref={closeHref}
      title={round.name}
      description={t("rounds.drawerDescription", { code: classCode, date: date(round.closedOn) })}
    >
      <div className="space-y-5 p-4">
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label={t("rounds.columns.price")}
            value={price(round.pricePerShare, round.currency)}
          />
          <Stat
            label={t("rounds.columns.preMoney")}
            value={money(round.preMoneyValuation, { currency: round.currency })}
          />
          <Stat
            label={t("rounds.impliedPreMoney")}
            value={money(round.impliedPreMoney, { currency: round.currency })}
          />
          <Stat label={t("rounds.fullyDilutedBefore")} value={shares(round.fullyDilutedBefore)} />
        </section>
        {round.preMoneyBasisReason && (
          <p className="text-sm">
            {t("rounds.basisReason", { reason: round.preMoneyBasisReason })}
          </p>
        )}
        {round.preMoneyDrift && (
          <p
            role="status"
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            {t("rounds.preMoneyDrift", {
              preMoney: money(round.preMoneyValuation, { currency: round.currency }),
              implied: money(round.preMoneyDrift.impliedPreMoney, { currency: round.currency }),
              shares: shares(round.preMoneyDrift.fullyDilutedBefore),
            })}{" "}
            {context.canManage
              ? t("rounds.preMoneyDriftRemedy", {
                  implied: money(round.preMoneyDrift.impliedPreMoney, { currency: round.currency }),
                })
              : t("rounds.preMoneyDriftReadOnly")}
          </p>
        )}
        {/* Conversions into the round that its current measurement prices differently, reported with the pre-money drift. */}
        {round.conversionDrift.length > 0 && (
          <div
            role="status"
            className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <ul className="space-y-0.5">
              {round.conversionDrift.map((row) => (
                <li key={row.securityId}>
                  {t.rich("rounds.conversionDrift", {
                    number: row.securityNumber,
                    recorded: price(row.recordedPrice, round.currency),
                    standing: price(row.standingPrice, round.currency),
                    link: (chunks) => (
                      <Link
                        className={`font-mono ${LINK}`}
                        href={
                          withParams("/equity", context.params, {
                            view: "securities",
                            security: row.securityId,
                            round: undefined,
                          }) as never
                        }
                      >
                        {chunks}
                      </Link>
                    ),
                  })}
                </li>
              ))}
            </ul>
            <p>{t("rounds.conversionDriftHint")}</p>
          </div>
        )}
        {locked && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("rounds.lockedBy", { count: round.liveSecurities.length })}{" "}
            {round.liveSecurities.map((row, index) => (
              <span key={row.id}>
                {index > 0 && ", "}
                <Link
                  className={`font-mono ${LINK}`}
                  href={
                    withParams("/equity", context.params, {
                      view: "securities",
                      security: row.id,
                      round: undefined,
                    }) as never
                  }
                >
                  {row.securityNumber}
                </Link>
              </span>
            ))}
          </p>
        )}
        {round.amendments.length > 0 && (
          <section className="space-y-2" aria-label={t("rounds.historyTitle")}>
            <h3 className="text-sm font-semibold">{t("rounds.historyTitle")}</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("fields.effectiveOn")}</TableHead>
                  <TableHead>{t("rounds.change")}</TableHead>
                  <TableHead>{t("fields.reason")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {round.amendments.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {date(row.effectiveOn)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {[
                        row.name ? t("rounds.changedName", { name: row.name }) : null,
                        row.pricePerShare
                          ? t("rounds.changedPrice", {
                              price: price(row.pricePerShare, round.currency),
                            })
                          : null,
                        row.preMoneyValuation
                          ? t("rounds.changedPreMoney", {
                              amount: money(row.preMoneyValuation, { currency: round.currency }),
                            })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || t("rounds.changedBasis")}
                    </TableCell>
                    <TableCell className="text-sm">{row.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        )}
        {context.canManage && (
          <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <SegmentTabs
              value={mode}
              onChange={setMode}
              label={t("rounds.actions")}
              tabs={[
                { key: "amend", label: t("rounds.amend") },
                { key: "void", label: t("rounds.void") },
              ]}
            />
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {mode === "amend"
                ? t("rounds.amendHelp")
                : locked
                  ? t("rounds.voidLocked")
                  : t("rounds.voidHelp")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("fields.effectiveOn")}>
                <DateField
                  value={form.effectiveOn}
                  onChange={(value) => set("effectiveOn")(value)}
                />
              </Field>
              {mode === "amend" && (
                <>
                  <Field label={t("fields.name")}>
                    <Input value={form.name} onChange={(e) => set("name")(e.target.value)} />
                  </Field>
                  <Field
                    label={t("fields.pricePerShare")}
                    hint={locked ? t("rounds.priceLocked") : undefined}
                  >
                    <MoneyInput
                      grouped
                      maxScale={10}
                      field={t("fields.pricePerShare")}
                      ariaLabel={t("fields.pricePerShare")}
                      value={form.pricePerShare}
                      disabled={locked}
                      placeholder={formatDecimal(
                        locale,
                        round.pricePerShare,
                        perShareFormatOptions(round.pricePerShare),
                      )}
                      onChange={set("pricePerShare")}
                    />
                  </Field>
                  <Field label={t("fields.preMoneyValuation")}>
                    <MoneyInput
                      grouped
                      field={t("fields.preMoneyValuation")}
                      ariaLabel={t("fields.preMoneyValuation")}
                      value={form.preMoneyValuation}
                      placeholder={formatDecimal(locale, round.preMoneyValuation, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                      onChange={set("preMoneyValuation")}
                    />
                  </Field>
                </>
              )}
            </div>
            {mode === "amend" && (
              <Field label={t("fields.preMoneyBasisReason")} hint={t("new.preMoneyBasisHint")}>
                <Textarea
                  rows={2}
                  value={form.preMoneyBasisReason}
                  onChange={(e) => set("preMoneyBasisReason")(e.target.value)}
                />
              </Field>
            )}
            <Field label={t("fields.reason")}>
              <Textarea
                rows={2}
                value={form.reason}
                onChange={(e) => set("reason")(e.target.value)}
              />
            </Field>
            <CommandRefusal refusal={refusal} fallback={failed} />
            <div className="flex justify-end">
              <Button
                onClick={submit}
                disabled={busy || !ready}
                variant={mode === "void" ? "destructive" : "default"}
              >
                {mode === "void" ? t("rounds.void") : t("rounds.amend")}
              </Button>
            </div>
          </section>
        )}
      </div>
    </UrlDrawer>
  );
}

/** Pro-forma priced round: nothing is recorded; the model reads the cap table on the as-of date. */
function RoundModelDrawer({ context, closeHref }: { context: EquityContext; closeHref: string }) {
  const t = useTranslations("equity");
  const shares = useShares();
  const price = usePrice();
  const percentText = usePercent();
  const { money } = useMoney();
  const { busy, refusal, execute } = useAppAction();
  const [form, setForm] = useState({
    preMoneyValuation: "",
    investment: "",
    targetPoolPercent: "",
  });
  const [result, setResult] = useState<{
    result: RoundModelResult;
    parties: Record<string, string>;
  } | null>(null);
  async function run() {
    // A refused model shows its refusal in place of the previous result,
    // never a stale result beside it.
    setResult(null);
    await execute(
      () =>
        postCommand<{ result: RoundModelResult; parties: Record<string, string> }>(
          "/api/equity/models/round",
          {
            subsidiaryId: context.subsidiaryId,
            asOf: context.asOf,
            preMoneyValuation: form.preMoneyValuation,
            investment: form.investment,
            targetPoolPercent: form.targetPoolPercent || null,
          },
          t("model.failed"),
        ),
      {
        fallbackMessage: t("model.failed"),
        onOk: (next) => setResult(next),
      },
    );
  }
  const r = result?.result;
  const label = (key: string) =>
    key === "new_investors"
      ? t("model.newInvestors")
      : key === "pool"
        ? t("model.pool")
        : key === "anti_dilution"
          ? t("model.antiDilution")
          : (result?.parties[key] ?? key);
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="xl"
      title={t("rounds.model")}
      description={t("model.description")}
    >
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t("model.preMoney")}>
            <MoneyInput
              grouped
              field={t("model.preMoney")}
              ariaLabel={t("model.preMoney")}
              value={form.preMoneyValuation}
              onChange={(value) => setForm({ ...form, preMoneyValuation: value })}
            />
          </Field>
          <Field label={t("model.investment")}>
            <MoneyInput
              grouped
              field={t("model.investment")}
              ariaLabel={t("model.investment")}
              value={form.investment}
              onChange={(value) => setForm({ ...form, investment: value })}
            />
          </Field>
          <Field label={t("model.targetPool")}>
            <Input
              inputMode="decimal"
              value={form.targetPoolPercent}
              onChange={(e) => setForm({ ...form, targetPoolPercent: e.target.value })}
              placeholder="10"
            />
          </Field>
          <Button onClick={run} disabled={busy || !form.preMoneyValuation || !form.investment}>
            {t("model.run")}
          </Button>
        </div>
        <CommandRefusal refusal={refusal} fallback={t("model.failed")} />
        {r ? (
          <>
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t("model.price")} value={price(r.pricePerShare, context.currency)} />
              <Stat
                label={t("model.postMoney")}
                value={money(r.postMoneyValuation, { currency: context.currency })}
              />
              <Stat
                label={t("model.investorShares")}
                value={t("model.sharesOfFullyDiluted", {
                  shares: shares(r.investorShares),
                  percent: percentText(r.investorPercent),
                })}
              />
              <Stat label={t("model.fullyDilutedAfter")} value={shares(r.fullyDilutedAfter)} />
              <Stat label={t("model.conversionShares")} value={shares(r.conversionShares)} />
              <Stat
                label={t("model.poolTopUp")}
                value={t("model.newShares", {
                  shares: shares(r.poolTopUp),
                  sharesCount: Number(r.poolTopUp),
                })}
              />
              <Stat
                label={t("model.poolAfter")}
                value={t("model.percentOfFullyDiluted", {
                  percent: percentText(r.poolPercentAfter),
                })}
              />
              <Stat label={t("model.antiDilutionShares")} value={shares(r.antiDilutionShares)} />
              <Stat
                label={t("model.cashRounding")}
                value={money(r.investorCashRounding, { currency: context.currency })}
              />
            </section>
            <PagedTable
              prepared
              source="equity_round_model"
              rows={r.dilution}
              rowKey={(row) => row.key}
              empty={t("model.empty")}
              searchable={false}
              columns={[
                {
                  key: "holder",
                  header: <>{t("model.columns.holder")}</>,
                  headerClassName: HEAD,
                  className: CELL,
                  cell: (row) => <>{label(row.key)}</>,
                },
                {
                  key: "before",
                  header: <>{t("model.columns.sharesBefore")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  cell: (row) => <>{shares(row.sharesBefore)}</>,
                },
                {
                  key: "percentBefore",
                  header: <>{t("model.columns.percentBefore")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  cell: (row) => <>{percentText(row.percentBefore)}</>,
                },
                {
                  key: "after",
                  header: <>{t("model.columns.sharesAfter")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  cell: (row) => <>{shares(row.sharesAfter)}</>,
                },
                {
                  key: "percentAfter",
                  header: <>{t("model.columns.percentAfter")}</>,
                  headerClassName: NUM_HEAD,
                  className: NUM_CELL,
                  cell: (row) => <>{percentText(row.percentAfter)}</>,
                },
              ]}
            />
            {r.conversions.length > 0 && (
              <PagedTable
                prepared
                source="equity_round_model_conversions"
                rows={r.conversions}
                rowKey={(row) => row.securityId}
                empty={t("model.empty")}
                searchable={false}
                columns={[
                  {
                    key: "holder",
                    header: <>{t("model.columns.holder")}</>,
                    headerClassName: HEAD,
                    className: CELL,
                    cell: (row) => (
                      <>{row.holderPartyId ? (result?.parties[row.holderPartyId] ?? "—") : "—"}</>
                    ),
                  },
                  {
                    key: "amount",
                    header: <>{t("model.columns.amount")}</>,
                    headerClassName: NUM_HEAD,
                    className: NUM_CELL,
                    cell: (row) => <>{money(row.amount, { currency: context.currency })}</>,
                  },
                  {
                    key: "pricedBy",
                    header: <>{t("model.columns.pricedBy")}</>,
                    headerClassName: HEAD,
                    className: CELL,
                    cell: (row) => <>{t(`model.pricedBy.${row.pricedBy}`)}</>,
                  },
                  {
                    key: "price",
                    header: <>{t("model.columns.price")}</>,
                    headerClassName: NUM_HEAD,
                    className: NUM_CELL,
                    cell: (row) => <>{price(row.price, context.currency)}</>,
                  },
                  {
                    key: "shares",
                    header: <>{t("model.columns.shares")}</>,
                    headerClassName: NUM_HEAD,
                    className: NUM_CELL,
                    cell: (row) => <>{shares(row.shares)}</>,
                  },
                ]}
              />
            )}
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-400 dark:border-slate-800 dark:text-slate-500">
            {t("model.prompt")}
          </p>
        )}
      </div>
    </UrlDrawer>
  );
}
