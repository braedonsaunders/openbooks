"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  Badge,
  Button,
  Input,
  SearchSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@openbooks/ui";
import { DrawerTabStrip } from "@/components/drawer-tab-strip";
import { JournalEntryLink } from "@/components/journal-entry-link";
import { useMoney } from "@/components/money-provider";
import { formatDecimal } from "@/lib/money-format";
import { useAppAction } from "@/lib/use-app-action";
import type { RecordEventResult } from "@openbooks/engine/equity";
import type { SecurityDrawerData, SecurityDrawerRefusal } from "./view";
import { AsyncUrlDrawer } from "@/components/async-url-drawer";
import { joinRefusal } from "@/lib/refusal-sentence";
import {
  CommandRefusal,
  Field,
  LINK,
  PendingActions,
  STATUS_VARIANT,
  SegmentTabs,
  Stat,
  postCommand,
  toastGoverned,
  useCivilDate,
  useDecimal,
  usePercent,
  usePrice,
  useShares,
  withParams,
} from "./shared";
import { DateField } from "@/components/date-field";

type ActionKind =
  | "exercise"
  | "settle"
  | "forfeit"
  | "expire"
  | "cancel"
  | "transfer"
  | "convert"
  | "repurchase"
  | "void"
  | "repay"
  | "election_83b";
type Panel = "overview" | "vesting" | "history" | "mfn" | "actions";

/**
 * The events each kind admits (equity.manage). Voids, repurchases and the
 * repayment or cancellation of a SAFE or note are governed: an Equity
 * action Flow may hold them for approval.
 */
const ACTIONS: Record<string, ActionKind[]> = {
  option: ["exercise", "forfeit", "expire", "cancel", "void"],
  rsu: ["settle", "forfeit", "cancel", "void"],
  warrant: ["exercise", "expire", "cancel", "transfer", "void"],
  share: ["transfer", "convert", "election_83b", "repurchase", "void"],
  safe: ["convert", "repay", "cancel", "void"],
  note: ["convert", "repay", "cancel", "void"],
};
const NEEDS_REASON: ActionKind[] = ["forfeit", "expire", "cancel", "repurchase", "void"];

const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/**
 * One security: its terms, its state on the as-of date, its vesting
 * schedule, its history with the journal entries it posted, its MFN terms
 * for an MFN SAFE, and the events it admits for the reader's duties.
 * Overview, vesting, history, MFN and actions are sibling tabs; one body
 * shows at a time. A recorded forfeiture, expiry, cancellation, repurchase,
 * repayment or 83(b) election can be reversed from the history. Governed
 * actions an Equity action Flow holds for approval are listed above the
 * tabs until decided.
 */
/** The requested identity owns one shell through refusal, retry and detail. */
export function SecurityDrawer(drawer: SecurityDrawerData | SecurityDrawerRefusal) {
  const t = useTranslations("equity");
  const common = useTranslations("common");
  const router = useRouter();
  const refusal = "refusal" in drawer ? drawer : null;
  const loaded = "detail" in drawer ? drawer : null;
  const s = loaded?.detail.security;
  const status =
    loaded?.detail.state?.status ?? loaded?.detail.convertible?.status ?? "outstanding";
  const election = loaded?.detail.election83b;
  return (
    <AsyncUrlDrawer
      open
      openKey={refusal?.securityId ?? String(s?.id)}
      closeHref={drawer.closeHref}
      size="2xl"
      pending={false}
      error={refusal ? joinRefusal(refusal.refusal.message, refusal.refusal.remedy) : null}
      onRetry={() => router.refresh()}
      title={
        s ? (
          <span className="flex items-center gap-2.5">
            <span className="font-mono">{String(s.security_number)}</span>
            <Badge variant={STATUS_VARIANT[status] ?? "secondary"}>{t(`status.${status}`)}</Badge>
            {election && (
              <Badge
                variant={
                  election.state === "filed"
                    ? "success"
                    : election.state === "open"
                      ? "warning"
                      : "outline"
                }
              >
                {t(`election83b.${election.state}`)}
              </Badge>
            )}
          </span>
        ) : (
          common("feedback.loadFailed")
        )
      }
      description={
        s && loaded ? `${t(`kind.${String(s.kind)}`)} · ${loaded.detail.holderName}` : undefined
      }
    >
      {loaded ? <SecurityDrawerBody {...loaded} /> : null}
    </AsyncUrlDrawer>
  );
}

function SecurityDrawerBody({
  context,
  detail,
  releases,
  holders,
  rounds,
  commonClasses,
  considerationAccounts,
}: SecurityDrawerData) {
  const t = useTranslations("equity");
  const locale = useLocale();
  const shares = useShares();
  const date = useCivilDate();
  const price = usePrice();
  const percentText = usePercent();
  const decimal = useDecimal();
  const { money } = useMoney();
  const s = detail.security;
  const termsText = (terms: {
    valuationCap: string | null;
    discountPercent: string | null;
    safeType: string | null;
  }) =>
    [
      terms.valuationCap
        ? money(terms.valuationCap, { currency: String(s.currency) })
        : t("mfn.noCap"),
      terms.discountPercent ? percentText(terms.discountPercent) : t("mfn.noDiscount"),
      terms.safeType ? t(`safeType.${terms.safeType}`) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const kind = String(s.kind);
  const convertible = kind === "safe" || kind === "note";
  const status = detail.state?.status ?? detail.convertible?.status ?? "outstanding";
  const live = !["void", "converted", "repaid", "cancelled"].includes(status);
  const actions = live
    ? (context.canManage ? (ACTIONS[kind] ?? []) : [])
        .filter(
          (action) =>
            !(action === "convert" && kind === "share" && detail.shareClass?.kind !== "preferred"),
        )
        .filter((action) => action !== "election_83b" || detail.election83b?.state === "open")
    : [];
  const history = [
    ...detail.events.map((event) => ({ date: String(event.effective_on), event, election: null })),
    ...(detail.mfn?.elections ?? []).map((election) => ({
      date: election.effectiveOn,
      event: null,
      election,
    })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const [panel, setPanel] = useState<Panel>("overview");
  const [reversing, setReversing] = useState<{
    id: string;
    kind: string;
    effectiveOn: string;
  } | null>(null);
  const currency = String(s.currency);
  const amount = (value: unknown) => (str(value) ? money(String(value), { currency }) : "—");
  const functional = (value: unknown) =>
    str(value) ? money(String(value), { currency: detail.entity.currency }) : "—";
  const terms: [string, string][] = [
    [t("fields.holder"), detail.holderName],
    [t("fields.kind"), t(`kind.${kind}`)],
    [t("fields.issueDate"), date(String(s.issue_date))],
    ...(currency !== detail.entity.currency
      ? [
          [
            t("fields.currency"),
            `${currency} · ${t("drawer.issueRate", { rate: formatDecimal(locale, String(s.fx_rate), { maximumFractionDigits: 6 }) })}`,
          ] as [string, string],
        ]
      : []),
    ...(detail.shareClass
      ? [
          [t("fields.shareClass"), `${detail.shareClass.code} · ${detail.shareClass.name}`] as [
            string,
            string,
          ],
        ]
      : []),
    ...(detail.plan
      ? [[t("fields.plan"), `${detail.plan.code} · ${detail.plan.name}`] as [string, string]]
      : []),
    ...(detail.round ? [[t("fields.round"), detail.round.name] as [string, string]] : []),
    ...(str(s.quantity)
      ? [[t("fields.quantityIssued"), shares(String(s.quantity))] as [string, string]]
      : []),
    ...(detail.exercisePrice
      ? [[t("fields.exercisePrice"), price(detail.exercisePrice, currency)] as [string, string]]
      : []),
    ...(kind === "share" && str(s.price_per_share)
      ? [
          [t("fields.pricePerShare"), price(String(s.price_per_share), currency)] as [
            string,
            string,
          ],
        ]
      : []),
    ...(str(s.consideration_amount)
      ? [
          [
            convertible ? t("fields.principal") : t("fields.consideration"),
            amount(s.consideration_amount),
          ] as [string, string],
        ]
      : []),
    ...(str(s.option_type)
      ? [[t("fields.optionType"), t(`optionType.${String(s.option_type)}`)] as [string, string]]
      : []),
    ...(s.early_exercise === true
      ? [
          [
            t("fields.earlyExercise"),
            t(`repurchaseBasis.${String(s.unvested_repurchase_basis ?? "none")}`),
          ] as [string, string],
        ]
      : []),
    ...(str(s.expiration_date)
      ? [[t("fields.expirationDate"), date(String(s.expiration_date))] as [string, string]]
      : []),
    ...(detail.convertible?.safeType
      ? [[t("fields.safeType"), t(`safeType.${detail.convertible.safeType}`)] as [string, string]]
      : []),
    ...(s.mfn === true
      ? [
          [
            t("fields.mfn"),
            detail.convertible?.electionId ? t("drawer.mfnAdopted") : t("drawer.mfnOpen"),
          ] as [string, string],
        ]
      : []),
    ...(detail.convertible?.electionId
      ? [[t("fields.issuedTerms"), termsText(detail.convertible.issuedTerms)] as [string, string]]
      : []),
    ...(detail.convertible?.valuationCap
      ? [[t("fields.valuationCap"), amount(detail.convertible.valuationCap)] as [string, string]]
      : []),
    ...(detail.convertible?.discountPercent
      ? [
          [t("fields.discountPercent"), percentText(detail.convertible.discountPercent)] as [
            string,
            string,
          ],
        ]
      : []),
    ...(str(s.interest_rate_percent)
      ? [
          [
            t("fields.interestRatePercent"),
            `${percentText(String(s.interest_rate_percent))} · ${t(`interestBasis.${String(s.interest_basis)}`)} · ${t(`dayCount.${String(s.interest_day_count)}`)}`,
          ] as [string, string],
        ]
      : []),
    ...(str(s.maturity_date)
      ? [[t("fields.maturityDate"), date(String(s.maturity_date))] as [string, string]]
      : []),
    ...(str(s.acceleration) && s.acceleration !== "none"
      ? [
          [
            t("fields.acceleration"),
            `${t(`acceleration.${String(s.acceleration)}`)} · ${percentText(str(s.acceleration_percent))}`,
          ] as [string, string],
        ]
      : []),
    ...(str(s.valuation_method)
      ? [
          [t("fields.valuationMethod"), t(`valuationMethod.${String(s.valuation_method)}`)] as [
            string,
            string,
          ],
        ]
      : []),
    ...(str(s.valuation_share_price)
      ? [
          [
            t("fields.grantSharePrice"),
            price(String(s.valuation_share_price), detail.entity.currency),
          ] as [string, string],
        ]
      : []),
    ...(str(s.volatility_percent)
      ? [
          [t("fields.volatilityPercent"), percentText(String(s.volatility_percent))] as [
            string,
            string,
          ],
        ]
      : []),
    ...(str(s.risk_free_rate_percent)
      ? [
          [t("fields.riskFreeRatePercent"), percentText(String(s.risk_free_rate_percent))] as [
            string,
            string,
          ],
        ]
      : []),
    ...(str(s.expected_term_years)
      ? [
          [t("fields.expectedTermYears"), decimal(String(s.expected_term_years))] as [
            string,
            string,
          ],
        ]
      : []),
    ...(str(s.dividend_yield_percent)
      ? [
          [t("fields.dividendYieldPercent"), percentText(String(s.dividend_yield_percent))] as [
            string,
            string,
          ],
        ]
      : []),
    ...(str(s.fair_value_per_unit)
      ? [
          [
            t("fields.fairValuePerUnit"),
            price(String(s.fair_value_per_unit), detail.entity.currency),
          ] as [string, string],
        ]
      : []),
    ...(str(s.expense_attribution)
      ? [
          [t("fields.attribution"), t(`attribution.${String(s.expense_attribution)}`)] as [
            string,
            string,
          ],
        ]
      : []),
    ...(str(s.memo) ? [[t("fields.memo"), String(s.memo)] as [string, string]] : []),
  ];
  const election = detail.election83b;
  return (
    <div className="space-y-5 p-1">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {detail.state ? (
          <>
            <Stat label={t("drawer.outstanding")} value={shares(detail.state.outstanding)} />
            <Stat label={t("drawer.vested")} value={shares(detail.state.vestedAvailable)} />
            <Stat label={t("drawer.unvested")} value={shares(detail.state.unvested)} />
            <Stat label={t("drawer.asOf")} value={date(detail.asOf)} />
          </>
        ) : detail.convertible ? (
          <>
            <Stat label={t("fields.principal")} value={amount(detail.convertible.principal)} />
            <Stat
              label={t("drawer.outstandingPrincipal")}
              value={amount(detail.convertible.outstanding)}
            />
            <Stat
              label={t("drawer.accruedInterest")}
              value={amount(detail.convertible.accruedInterest)}
            />
            <Stat
              label={t("drawer.convertingAmount")}
              value={amount(detail.convertible.convertingAmount)}
            />
            <Stat label={t("drawer.asOf")} value={date(detail.asOf)} />
            {detail.convertible.resultingSecurityId && (
              <Stat
                label={t("drawer.convertedInto")}
                value={
                  <Link
                    className={`font-mono ${LINK}`}
                    href={withParams("/equity", context.params, {
                      view: "securities",
                      security: detail.convertible.resultingSecurityId,
                    })}
                  >
                    {detail.convertible.resultingSecurityNumber ?? ""}
                  </Link>
                }
              />
            )}
          </>
        ) : null}
        {detail.interest && (
          <Stat label={t("drawer.interestPosted")} value={amount(detail.interest.posted)} />
        )}
        {detail.earlyExercise && (
          <Stat label={t("drawer.exercisable")} value={shares(detail.earlyExercise.exercisable)} />
        )}
        {detail.restricted && (
          <>
            <Stat
              label={t("drawer.restrictedShares")}
              value={shares(detail.restricted.restrictedShares)}
            />
            <Stat
              label={t("drawer.releasedShares")}
              value={shares(detail.restricted.releasedShares)}
            />
            <Stat
              label={t("drawer.depositHeld")}
              value={functional(detail.restricted.depositHeld)}
            />
            <Stat
              label={t("drawer.depositUnvested")}
              value={functional(detail.restricted.depositUnvested)}
            />
          </>
        )}
        {election && (
          <Stat
            label={t("drawer.election83b")}
            value={
              election.state === "filed"
                ? t("election83b.filedOn", { date: date(election.filedOn) })
                : election.state === "open"
                  ? t("election83b.due", {
                      date: date(election.deadline),
                      days: election.daysLeft ?? 0,
                    })
                  : t("election83b.missedOn", { date: date(election.deadline) })
            }
          />
        )}
        {detail.compensation && (
          <>
            <Stat
              label={t("drawer.grantValue")}
              value={functional(detail.compensation.grantDateValue)}
            />
            <Stat
              label={t("drawer.expectedValue")}
              value={functional(detail.compensation.expectedAfterForfeitures)}
            />
            <Stat
              label={t("drawer.recognized")}
              value={functional(detail.compensation.recognized)}
            />
            <Stat label={t("drawer.posted")} value={functional(detail.compensation.posted)} />
          </>
        )}
      </section>
      <PendingActions context={context} filter={(request) => request.subjectId === String(s.id)} />
      {detail.convertible?.invalidConversionTerms && (
        <section className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100">
          <p className="font-semibold">
            {t("drawer.invalidConversionTitle", {
              source: detail.convertible.invalidConversionTerms.sourceSecurityNumber,
              date: date(detail.convertible.invalidConversionTerms.sourceVoidedOn),
            })}
          </p>
          <p>
            {t("drawer.invalidConversionRemedy", {
              certificate: detail.convertible.resultingSecurityNumber ?? "",
              date: date(detail.convertible.convertedOn),
            })}
          </p>
        </section>
      )}
      {detail.convertible?.conversionDrift && (
        <section
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p className="font-semibold">
            {t("drawer.conversionDriftTitle", {
              recorded: price(
                detail.convertible.conversionDrift.recordedPrice,
                detail.convertible.conversionDrift.currency,
              ),
              recordedShares: shares(detail.convertible.conversionDrift.recordedShares),
              recordedSharesCount: Number(detail.convertible.conversionDrift.recordedShares),
              standing: price(
                detail.convertible.conversionDrift.standingPrice,
                detail.convertible.conversionDrift.currency,
              ),
              standingShares: shares(detail.convertible.conversionDrift.standingShares),
              standingSharesCount: Number(detail.convertible.conversionDrift.standingShares),
            })}
          </p>
          <p>
            {t("drawer.conversionDriftRemedy", {
              certificate: detail.convertible.conversionDrift.resultingSecurityNumber ?? "",
              date: date(detail.convertible.conversionDrift.convertedOn),
            })}
          </p>
        </section>
      )}
      <DrawerTabStrip
        ariaLabel={t("drawer.tabs")}
        activeKey={panel}
        onSelect={setPanel}
        tabs={[
          { key: "overview" as const, label: t("drawer.overview") },
          {
            key: "vesting" as const,
            label: t("drawer.vesting"),
            count: detail.vesting.length,
            disabled: detail.vesting.length === 0,
          },
          { key: "history" as const, label: t("drawer.history"), count: history.length },
          ...(detail.mfn
            ? [{ key: "mfn" as const, label: t("drawer.mfn"), count: detail.mfn.candidates.length }]
            : []),
          { key: "actions" as const, label: t("drawer.actions"), disabled: actions.length === 0 },
        ]}
      />
      {panel === "overview" && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            {terms.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {detail.restricted && (
            <p className="text-sm">
              {t("drawer.restrictedFrom", {
                basis: t(`repurchaseBasis.${detail.restricted.repurchaseBasis ?? "none"}`),
              })}{" "}
              <Link
                className={`font-mono ${LINK}`}
                href={withParams("/equity", context.params, {
                  view: "securities",
                  security: detail.restricted.sourceSecurityId,
                })}
              >
                {detail.restricted.sourceSecurityNumber}
              </Link>
            </p>
          )}
          {detail.restricted && releases.length > 0 && (
            <section className="space-y-2" aria-label={t("drawer.releasesTitle")}>
              <h3 className="text-sm font-semibold">{t("drawer.releasesTitle")}</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("compensation.columns.through")}</TableHead>
                    <TableHead className="text-right">{t("drawer.releasedThisRun")}</TableHead>
                    <TableHead className="text-right">{t("drawer.releasedShares")}</TableHead>
                    <TableHead className="text-right">
                      {t("compensation.columns.deposit")}
                    </TableHead>
                    <TableHead>{t("compensation.columns.entry")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {releases.map((row) => (
                    <TableRow key={row.runId}>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {date(row.throughDate)}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        {shares(row.shares)}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        {shares(row.cumulativeShares)}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        {money(row.deposit, { currency: row.currency })}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.journalEntryId ? (
                          <JournalEntryLink className={LINK} entryId={row.journalEntryId}>
                            {row.entryNumber ?? t("drawer.viewEntry")}
                          </JournalEntryLink>
                        ) : (
                          t("compensation.noEntry")
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          )}
          {detail.source && !detail.restricted && (
            <p className="text-sm">
              {t("drawer.source")}{" "}
              <Link
                className={`font-mono ${LINK}`}
                href={withParams("/equity", context.params, {
                  view: "securities",
                  security: detail.source.id,
                })}
              >
                {detail.source.securityNumber}
              </Link>
            </p>
          )}
          {detail.resulting.length > 0 && (
            <p className="text-sm">
              {t("drawer.resulting")}{" "}
              {detail.resulting.map((row, index) => (
                <span key={row.id}>
                  {index > 0 && ", "}
                  <Link
                    className={`font-mono ${LINK}`}
                    href={withParams("/equity", context.params, {
                      view: "securities",
                      security: row.id,
                    })}
                  >
                    {row.securityNumber}
                  </Link>{" "}
                  ({row.holderName})
                </span>
              ))}
            </p>
          )}
          {str(s.journal_entry_id) && (
            <p className="text-sm">
              {t("drawer.issuanceEntry")}{" "}
              <JournalEntryLink className={LINK} entryId={String(s.journal_entry_id)}>
                {t("drawer.viewEntry")}
              </JournalEntryLink>
            </p>
          )}
        </div>
      )}
      {panel === "vesting" && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("drawer.vestDate")}</TableHead>
              <TableHead className="text-right">{t("drawer.vestQuantity")}</TableHead>
              <TableHead className="text-right">{t("drawer.vestCumulative")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.vesting.map((row) => (
              <TableRow key={row.date} className={row.date <= detail.asOf ? "" : "text-slate-500"}>
                <TableCell className="whitespace-nowrap tabular-nums">{date(row.date)}</TableCell>
                <TableCell className="text-right tabular-nums">{shares(row.quantity)}</TableCell>
                <TableCell className="text-right tabular-nums">{shares(row.cumulative)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {panel === "history" &&
        (history.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t("drawer.noEvents")}</p>
        ) : (
          <div className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("drawer.eventDate")}</TableHead>
                  <TableHead>{t("drawer.eventKind")}</TableHead>
                  <TableHead className="text-right">{t("drawer.eventQuantity")}</TableHead>
                  <TableHead className="text-right">{t("drawer.eventAmount")}</TableHead>
                  <TableHead>{t("drawer.eventEntry")}</TableHead>
                  <TableHead>{t("drawer.eventReason")}</TableHead>
                  {context.canManage && live && (
                    <TableHead>
                      <span className="sr-only">{t("capTable.columns.actions")}</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((item) =>
                  item.election ? (
                    <MfnHistoryRow
                      key={item.election.id}
                      election={item.election}
                      currency={currency}
                      params={context.params}
                      actionColumn={context.canManage && live}
                    />
                  ) : (
                    ((event: SecurityDrawerData["detail"]["events"][number]) => (
                      <TableRow
                        key={String(event.id)}
                        className={
                          str(event.reversed_by_event_id) || event.resulting_voided
                            ? "text-slate-500 line-through decoration-slate-400"
                            : ""
                        }
                      >
                        <TableCell className="whitespace-nowrap tabular-nums">
                          {date(String(event.effective_on))}
                        </TableCell>
                        <TableCell>
                          {t(`eventKind.${String(event.kind)}`)}
                          {str(event.reversed_by_event_id) && (
                            <Badge variant="outline" className="ml-2 no-underline">
                              {t("drawer.reversed")}
                            </Badge>
                          )}
                          {/* An event whose resulting security was voided is undone from the void; the void opens on that security. */}
                          {event.resulting_voided && (
                            <span className="block text-xs no-underline">
                              <Badge variant="outline" className="mr-1 no-underline">
                                {t("drawer.undone")}
                              </Badge>
                              <Link
                                className={`no-underline ${LINK}`}
                                href={withParams("/equity", context.params, {
                                  view: "securities",
                                  security: event.resulting_voided.securityId,
                                })}
                              >
                                {t("drawer.undoneByVoid", {
                                  certificate: event.resulting_voided.securityNumber,
                                  date: date(event.resulting_voided.voidedOn),
                                })}
                              </Link>
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums">
                          {str(event.quantity) ? shares(String(event.quantity)) : "—"}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums">
                          {amount(event.amount)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          <span className="flex flex-col">
                            {str(event.interest_accrual_entry_id) && (
                              <JournalEntryLink
                                className={LINK}
                                entryId={String(event.interest_accrual_entry_id)}
                              >
                                {t("drawer.accrualEntry")}
                              </JournalEntryLink>
                            )}
                            {str(event.journal_entry_id) && (
                              <JournalEntryLink
                                className={LINK}
                                entryId={String(event.journal_entry_id)}
                              >
                                {str(event.journal_entry_number) ?? t("drawer.viewEntry")}
                              </JournalEntryLink>
                            )}
                            {str(event.reversal_entry_id) && (
                              <JournalEntryLink
                                className={LINK}
                                entryId={String(event.reversal_entry_id)}
                              >
                                {str(event.reversal_entry_number) ?? t("drawer.viewEntry")}
                              </JournalEntryLink>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm">{str(event.reason) ?? ""}</TableCell>
                        {context.canManage && live && (
                          <TableCell className="text-right">
                            {event.reversible === true && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setReversing({
                                    id: String(event.id),
                                    kind: String(event.kind),
                                    effectiveOn: String(event.effective_on),
                                  })
                                }
                              >
                                {t("drawer.reverse")}
                              </Button>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    ))(item.event!)
                  ),
                )}
              </TableBody>
            </Table>
            {reversing && (
              <ReversalForm
                securityId={String(s.id)}
                target={reversing}
                asOf={context.asOf}
                onDone={() => setReversing(null)}
              />
            )}
          </div>
        ))}
      {panel === "mfn" && detail.mfn && (
        <MfnPanel
          securityId={String(s.id)}
          mfn={detail.mfn}
          asOf={context.asOf}
          canRecord={context.canManage && live}
          currency={currency}
          params={context.params}
        />
      )}
      {panel === "actions" && actions.length > 0 && (
        <ActionForm
          securityId={String(s.id)}
          convertible={convertible}
          restricted={detail.restricted !== null}
          repurchaseBasis={detail.restricted?.repurchaseBasis ?? null}
          earlyExercise={detail.earlyExercise !== null}
          actions={actions}
          asOf={context.asOf}
          holders={holders}
          rounds={rounds}
          commonClasses={commonClasses}
          considerationAccounts={considerationAccounts}
          carrying={detail.convertible?.convertingAmount ?? null}
        />
      )}
    </div>
  );
}

/** The reversal of one recorded event: its entry reverses on the date and its units or balance return. */
function ReversalForm({
  securityId,
  target,
  asOf,
  onDone,
}: {
  securityId: string;
  target: { id: string; kind: string; effectiveOn: string };
  asOf: string;
  onDone: () => void;
}) {
  const t = useTranslations("equity");
  const date = useCivilDate();
  const router = useRouter();
  const { busy, refusal, execute } = useAppAction();
  const [form, setForm] = useState({
    effectiveOn: asOf < target.effectiveOn ? target.effectiveOn : asOf,
    reason: "",
  });
  async function submit() {
    await execute(
      () =>
        postCommand<RecordEventResult>(
          `/api/equity/securities/${securityId}/events`,
          {
            kind: "reverse",
            reversesEventId: target.id,
            effectiveOn: form.effectiveOn,
            reason: form.reason,
            idempotencyKey: `${target.id}:reverse:${crypto.randomUUID()}`,
          },
          t("events.failed"),
        ),
      {
        fallbackMessage: t("events.failed"),
        onOk: (result) => {
          toastGoverned(
            result,
            t("events.reversed", { kind: t(`eventKind.${target.kind}`) }),
            t("approval.submitted"),
          );
          onDone();
          router.refresh();
        },
      },
    );
  }
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <h3 className="text-sm font-semibold">
        {t("reversal.title", {
          kind: t(`eventKind.${target.kind}`),
          date: date(target.effectiveOn),
        })}
      </h3>
      <p className="text-sm text-slate-500 dark:text-slate-400">{t("reversal.help")}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("fields.effectiveOn")}>
          <DateField
            value={form.effectiveOn}
            onChange={(value) => setForm({ ...form, effectiveOn: value })}
          />
        </Field>
      </div>
      <Field label={t("fields.reason")}>
        <Textarea
          rows={2}
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
        />
      </Field>
      <CommandRefusal refusal={refusal} fallback={t("events.failed")} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t("actions.cancel")}
        </Button>
        <Button
          variant="destructive"
          onClick={submit}
          disabled={busy || !form.effectiveOn || form.reason.trim().length < 5}
        >
          {t("drawer.reverse")}
        </Button>
      </div>
    </section>
  );
}

type MfnRecord = NonNullable<SecurityDrawerData["detail"]["mfn"]>["elections"][number];

/**
 * An election still in force, or one whose source instrument was voided
 * (whose adopted terms the SAFE can no longer convert on), is reversed
 * through the governed reversal; a reversed or superseded one is history.
 */
const REVERSIBLE_STANDINGS = new Set<MfnRecord["standing"]>(["in_force", "source_void"]);

/** The terms an MFN record leaves the SAFE with, beside those before it. */
function useMfnTerms(currency: string) {
  const t = useTranslations("equity");
  const { money } = useMoney();
  const percentText = usePercent();
  return (terms: {
    valuationCap: string | null;
    discountPercent: string | null;
    safeType: string | null;
  }) =>
    [
      terms.valuationCap ? money(terms.valuationCap, { currency }) : t("mfn.noCap"),
      terms.discountPercent ? percentText(terms.discountPercent) : t("mfn.noDiscount"),
      terms.safeType ? t(`safeType.${terms.safeType}`) : null,
    ]
      .filter(Boolean)
      .join(" · ");
}

/** An MFN election or its reversal as a row of the security's history. */
function MfnHistoryRow({
  election,
  currency,
  params,
  actionColumn,
}: {
  election: MfnRecord;
  currency: string;
  params: Record<string, string | string[] | undefined>;
  actionColumn: boolean;
}) {
  const t = useTranslations("equity");
  const date = useCivilDate();
  const terms = useMfnTerms(currency);
  return (
    <TableRow
      className={
        election.standing === "reversed" || election.standing === "source_void"
          ? "text-slate-500"
          : ""
      }
    >
      <TableCell className="whitespace-nowrap tabular-nums">{date(election.effectiveOn)}</TableCell>
      <TableCell>
        {t(`mfn.recordKind.${election.kind}`)}{" "}
        <Link
          className={`font-mono ${LINK}`}
          href={withParams("/equity", params, {
            view: "securities",
            security: election.sourceSecurityId,
          })}
        >
          {election.sourceSecurityNumber}
        </Link>
        {election.standing && election.standing !== "in_force" && (
          <Badge variant="outline" className="ml-2">
            {t(`mfn.standing.${election.standing}`)}
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right">—</TableCell>
      <TableCell className="text-sm">
        {t("mfn.termsChange", { before: terms(election.before), after: terms(election) })}
      </TableCell>
      <TableCell>—</TableCell>
      <TableCell className="text-sm">{election.reason}</TableCell>
      {actionColumn && <TableCell />}
    </TableRow>
  );
}

/** The governed reversal of an MFN election recorded in error. */
function MfnReversalForm({
  securityId,
  election,
  asOf,
  latestRecorded,
  onDone,
}: {
  securityId: string;
  election: MfnRecord;
  asOf: string;
  /** The latest MFN election or reversal recorded on the SAFE: a reversal cannot be dated before it. */
  latestRecorded: string;
  onDone: () => void;
}) {
  const t = useTranslations("equity");
  const date = useCivilDate();
  const router = useRouter();
  const { busy, refusal, execute } = useAppAction();
  const floor = latestRecorded > election.effectiveOn ? latestRecorded : election.effectiveOn;
  const [form, setForm] = useState({ effectiveOn: asOf < floor ? floor : asOf, reason: "" });
  async function submit() {
    await execute(
      () =>
        postCommand(
          `/api/equity/securities/${securityId}/mfn-elections/${election.id}/reversal`,
          {
            effectiveOn: form.effectiveOn,
            reason: form.reason,
            idempotencyKey: `${election.id}:mfn-reversal:${crypto.randomUUID()}`,
          },
          t("mfn.reverseFailed"),
        ),
      {
        fallbackMessage: t("mfn.reverseFailed"),
        onOk: (result) => {
          toastGoverned(result, t("mfn.reversed"), t("approval.submitted"));
          onDone();
          router.refresh();
        },
      },
    );
  }
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <h3 className="text-sm font-semibold">
        {t("mfn.reverseTitle", {
          source: election.sourceSecurityNumber,
          date: date(election.effectiveOn),
        })}
      </h3>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {election.standing === "source_void"
          ? t("mfn.reverseHelpSourceVoid", { source: election.sourceSecurityNumber })
          : t("mfn.reverseHelp")}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("fields.effectiveOn")}>
          <DateField
            value={form.effectiveOn}
            onChange={(value) => setForm({ ...form, effectiveOn: value })}
          />
        </Field>
      </div>
      <Field label={t("fields.reason")}>
        <Textarea
          rows={2}
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
        />
      </Field>
      <CommandRefusal refusal={refusal} fallback={t("mfn.reverseFailed")} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t("actions.cancel")}
        </Button>
        <Button
          variant="destructive"
          onClick={submit}
          disabled={busy || !form.effectiveOn || form.reason.trim().length < 5}
        >
          {t("mfn.reverse")}
        </Button>
      </div>
    </section>
  );
}

/** An MFN SAFE: later instruments whose better terms its holder may adopt, and the elections recorded. */
function MfnPanel({
  securityId,
  mfn,
  asOf,
  canRecord,
  currency,
  params,
}: {
  securityId: string;
  mfn: NonNullable<SecurityDrawerData["detail"]["mfn"]>;
  asOf: string;
  canRecord: boolean;
  currency: string;
  params: Record<string, string | string[] | undefined>;
}) {
  const t = useTranslations("equity");
  const router = useRouter();
  const { money } = useMoney();
  const date = useCivilDate();
  const percentText = usePercent();
  const [choice, setChoice] = useState<string | null>(null);
  const [reversing, setReversing] = useState<MfnRecord | null>(null);
  const terms = useMfnTerms(currency);
  const { busy, refusal, execute } = useAppAction();
  const [form, setForm] = useState({ effectiveOn: asOf, reason: "" });
  const cap = (value: string | null) => (value ? money(value, { currency }) : t("mfn.none"));
  const discount = (value: string | null) => (value ? percentText(value) : t("mfn.none"));
  async function elect() {
    if (!choice) return;
    await execute(
      () =>
        postCommand(
          `/api/equity/securities/${securityId}/mfn-elections`,
          {
            sourceSecurityId: choice,
            effectiveOn: form.effectiveOn,
            reason: form.reason,
            idempotencyKey: `${securityId}:mfn:${crypto.randomUUID()}`,
          },
          t("mfn.failed"),
        ),
      {
        fallbackMessage: t("mfn.failed"),
        onOk: (result) => {
          toastGoverned(result, t("mfn.saved"), t("approval.submitted"));
          setChoice(null);
          router.refresh();
        },
      },
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">{t("mfn.description")}</p>
      {mfn.candidates.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t("mfn.noCandidates", { date: date(asOf) })}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("securities.columns.number")}</TableHead>
              <TableHead>{t("fields.issueDate")}</TableHead>
              <TableHead className="text-right">{t("fields.valuationCap")}</TableHead>
              <TableHead className="text-right">{t("fields.discountPercent")}</TableHead>
              <TableHead>{t("fields.safeType")}</TableHead>
              <TableHead>{t("mfn.changes")}</TableHead>
              {canRecord && (
                <TableHead>
                  <span className="sr-only">{t("capTable.columns.actions")}</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {mfn.candidates.map((row) => (
              <TableRow key={row.sourceSecurityId} aria-selected={choice === row.sourceSecurityId}>
                <TableCell>
                  <Link
                    className={`font-mono ${LINK}`}
                    href={withParams("/equity", params, {
                      view: "securities",
                      security: row.sourceSecurityId,
                    })}
                  >
                    {row.securityNumber}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {date(row.issueDate)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{cap(row.valuationCap)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {discount(row.discountPercent)}
                </TableCell>
                <TableCell>{t(`safeType.${row.safeType}`)}</TableCell>
                <TableCell className="text-xs">
                  {row.improves.map((term) => (
                    <Badge key={term} variant="success" className="mr-1">
                      {t(`mfn.better.${term}`)}
                    </Badge>
                  ))}
                  {row.concedes.map((term) => (
                    <Badge key={term} variant="warning" className="mr-1">
                      {t(`mfn.worse.${term}`)}
                    </Badge>
                  ))}
                </TableCell>
                {canRecord && (
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant={choice === row.sourceSecurityId ? "default" : "ghost"}
                      onClick={() => setChoice(row.sourceSecurityId)}
                    >
                      {t("mfn.adopt")}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {choice && canRecord && (
        <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <p className="text-sm">
            {t("mfn.adoptHelp", {
              number:
                mfn.candidates.find((row) => row.sourceSecurityId === choice)?.securityNumber ?? "",
            })}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("mfn.electedOn")}>
              <DateField
                value={form.effectiveOn}
                onChange={(value) => setForm({ ...form, effectiveOn: value })}
              />
            </Field>
          </div>
          <Field label={t("fields.reason")}>
            <Textarea
              rows={2}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </Field>
          <CommandRefusal refusal={refusal} fallback={t("mfn.failed")} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setChoice(null)}>
              {t("actions.cancel")}
            </Button>
            <Button
              onClick={elect}
              disabled={busy || !form.effectiveOn || form.reason.trim().length < 5}
            >
              {t("mfn.record")}
            </Button>
          </div>
        </section>
      )}
      {mfn.elections.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("mfn.elections")}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("mfn.electedOn")}</TableHead>
                <TableHead>{t("mfn.source")}</TableHead>
                <TableHead>{t("mfn.before")}</TableHead>
                <TableHead>{t("mfn.after")}</TableHead>
                <TableHead>{t("mfn.standingTitle")}</TableHead>
                {canRecord && (
                  <TableHead>
                    <span className="sr-only">{t("capTable.columns.actions")}</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {mfn.elections.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {date(row.effectiveOn)}
                  </TableCell>
                  <TableCell>
                    {t(`mfn.recordKind.${row.kind}`)}{" "}
                    <Link
                      className={`font-mono ${LINK}`}
                      href={withParams("/equity", params, {
                        view: "securities",
                        security: row.sourceSecurityId,
                      })}
                    >
                      {row.sourceSecurityNumber}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">{terms(row.before)}</TableCell>
                  <TableCell className="text-sm">{terms(row)}</TableCell>
                  <TableCell>
                    {row.standing ? (
                      <Badge variant={row.standing === "in_force" ? "success" : "outline"}>
                        {t(`mfn.standing.${row.standing}`)}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  {canRecord && (
                    <TableCell className="text-right">
                      {row.kind === "mfn_election" && REVERSIBLE_STANDINGS.has(row.standing) && (
                        <Button size="sm" variant="ghost" onClick={() => setReversing(row)}>
                          {t("mfn.reverse")}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {reversing && (
            <MfnReversalForm
              securityId={securityId}
              election={reversing}
              asOf={asOf}
              onDone={() => setReversing(null)}
              latestRecorded={
                mfn.elections
                  .map((row) => row.effectiveOn)
                  .sort()
                  .at(-1) ?? reversing.effectiveOn
              }
            />
          )}
        </section>
      )}
    </div>
  );
}

function ActionForm({
  securityId,
  convertible,
  restricted,
  repurchaseBasis,
  earlyExercise,
  actions,
  asOf,
  holders,
  rounds,
  commonClasses,
  considerationAccounts,
  carrying,
}: {
  securityId: string;
  /** SAFEs and notes convert in a round; preferred shares convert into a common class. */
  convertible: boolean;
  /** Shares bought by early exercise: unvested shares repurchase on the grant's terms. */
  restricted: boolean;
  repurchaseBasis: string | null;
  earlyExercise: boolean;
  actions: ActionKind[];
  asOf: string;
  holders: { value: string; label: string }[];
  rounds: { value: string; label: string }[];
  commonClasses: { value: string; label: string }[];
  considerationAccounts: { value: string; label: string }[];
  /** A SAFE's or note's carrying amount on the as-of date, the default repayment. */
  carrying: string | null;
}) {
  const t = useTranslations("equity");
  const router = useRouter();
  const { money } = useMoney();
  const [action, setActionState] = useState<ActionKind>(actions[0]!);
  const { busy, refusal, execute, clearRefusal } = useAppAction();
  // A refusal answers the action it was given for; another action starts clean.
  const setAction = (next: ActionKind) => {
    setActionState(next);
    clearRefusal();
  };
  const [form, setForm] = useState({
    effectiveOn: asOf,
    quantity: "",
    amount: "",
    considerationAccountId: "",
    transfereePartyId: "",
    roundId: "",
    targetShareClassId: "",
    reason: "",
    fairMarketValuePerShare: "",
  });
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const settlingConvertible =
    convertible && (action === "repay" || action === "cancel" || action === "convert");
  const needsQuantity = !(action === "void" || action === "election_83b" || settlingConvertible);
  const restrictedRepurchase = action === "repurchase" && restricted;
  const needsReason = NEEDS_REASON.includes(action);
  async function submit() {
    const body: Record<string, unknown> = {
      kind: action,
      effectiveOn: form.effectiveOn,
      idempotencyKey: `${securityId}:${action}:${crypto.randomUUID()}`,
    };
    if (needsQuantity) body.quantity = form.quantity;
    if (needsReason || form.reason.trim()) body.reason = form.reason;
    if (
      (action === "exercise" || action === "repurchase" || action === "repay") &&
      form.considerationAccountId
    )
      body.considerationAccountId = form.considerationAccountId;
    if (action === "repurchase" && form.amount.trim()) body.amount = form.amount;
    if (action === "repurchase" && form.fairMarketValuePerShare.trim())
      body.fairMarketValuePerShare = form.fairMarketValuePerShare;
    if (action === "repay") body.amount = form.amount || carrying;
    if (action === "transfer") body.transfereePartyId = form.transfereePartyId;
    if (action === "convert") {
      if (convertible) body.roundId = form.roundId;
      else if (form.targetShareClassId) body.targetShareClassId = form.targetShareClassId;
    }
    await execute(
      () =>
        postCommand<RecordEventResult>(
          `/api/equity/securities/${securityId}/events`,
          body,
          t("events.failed"),
        ),
      {
        fallbackMessage: t("events.failed"),
        onOk: (result) => {
          toastGoverned(
            result,
            t("events.saved", { kind: t(`eventKind.${action}`) }),
            t("approval.submitted"),
          );
          router.refresh();
        },
      },
    );
  }
  const ready =
    form.effectiveOn &&
    (!needsQuantity || /^\d+$/.test(form.quantity)) &&
    (!needsReason || form.reason.trim().length >= 5) &&
    (action !== "transfer" || form.transfereePartyId) &&
    (action !== "repurchase" || restricted || form.amount) &&
    (!restrictedRepurchase ||
      repurchaseBasis !== "lower_of_cost_or_fmv" ||
      form.fairMarketValuePerShare) &&
    (action !== "repay" || ((form.amount || carrying) && form.considerationAccountId)) &&
    (action !== "convert" || !convertible || form.roundId);
  const help =
    action === "exercise" && earlyExercise
      ? "exerciseEarly"
      : restrictedRepurchase
        ? "repurchaseRestricted"
        : action === "cancel" && convertible
          ? "cancelConvertible"
          : action;
  return (
    <div className="space-y-4">
      <SegmentTabs
        value={action}
        onChange={setAction}
        label={t("drawer.actions")}
        tabs={actions.map((key) => ({ key, label: t(`eventKind.${key}`) }))}
      />
      <p className="text-sm text-slate-500 dark:text-slate-400">{t(`events.help.${help}`)}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={action === "election_83b" ? t("fields.filedOn") : t("fields.effectiveOn")}>
          <DateField value={form.effectiveOn} onChange={(value) => set("effectiveOn")(value)} />
        </Field>
        {needsQuantity && (
          <Field label={action === "convert" ? t("fields.sharesToConvert") : t("fields.quantity")}>
            <Input
              inputMode="numeric"
              value={form.quantity}
              onChange={(e) => set("quantity")(e.target.value)}
            />
          </Field>
        )}
        {action === "repurchase" && !restricted && (
          <Field label={t("fields.amountPaid")}>
            <Input
              inputMode="decimal"
              value={form.amount}
              onChange={(e) => set("amount")(e.target.value)}
            />
          </Field>
        )}
        {restrictedRepurchase && (
          <Field
            label={t("fields.fairMarketValuePerShare")}
            hint={t(`repurchaseBasis.${repurchaseBasis ?? "none"}`)}
          >
            <Input
              inputMode="decimal"
              value={form.fairMarketValuePerShare}
              onChange={(e) => set("fairMarketValuePerShare")(e.target.value)}
            />
          </Field>
        )}
        {action === "repay" && (
          <Field
            label={t("fields.amountRepaid")}
            hint={carrying ? t("events.carryingHint", { amount: money(carrying) }) : undefined}
          >
            <Input
              inputMode="decimal"
              value={form.amount}
              placeholder={carrying ?? ""}
              onChange={(e) => set("amount")(e.target.value)}
            />
          </Field>
        )}
        {(action === "exercise" || action === "repurchase" || action === "repay") && (
          <Field label={t("fields.considerationAccount")}>
            <SearchSelect
              value={form.considerationAccountId}
              options={considerationAccounts}
              onChange={(value) => set("considerationAccountId")(value ?? "")}
              ariaLabel={t("fields.considerationAccount")}
              clearable
            />
          </Field>
        )}
        {action === "transfer" && (
          <Field label={t("fields.transferee")}>
            <SearchSelect
              value={form.transfereePartyId}
              options={holders}
              onChange={(value) => set("transfereePartyId")(value ?? "")}
              ariaLabel={t("fields.transferee")}
            />
          </Field>
        )}
        {action === "convert" && convertible && (
          <Field label={t("fields.round")}>
            <SearchSelect
              value={form.roundId}
              options={rounds}
              onChange={(value) => set("roundId")(value ?? "")}
              ariaLabel={t("fields.round")}
            />
          </Field>
        )}
        {action === "convert" && !convertible && (
          <Field label={t("fields.targetClass")} hint={t("events.targetClassHint")}>
            <SearchSelect
              value={form.targetShareClassId}
              options={commonClasses}
              onChange={(value) => set("targetShareClassId")(value ?? "")}
              ariaLabel={t("fields.targetClass")}
              clearable
            />
          </Field>
        )}
      </div>
      {action !== "election_83b" && (
        <Field label={t("fields.reason")}>
          <Textarea rows={3} value={form.reason} onChange={(e) => set("reason")(e.target.value)} />
        </Field>
      )}
      <CommandRefusal refusal={refusal} fallback={t("events.failed")} />
      <div className="flex justify-end">
        <Button
          onClick={submit}
          disabled={busy || !ready}
          variant={action === "void" || action === "cancel" ? "destructive" : "default"}
        >
          {t(`eventKind.${action}`)}
        </Button>
      </div>
    </div>
  );
}
