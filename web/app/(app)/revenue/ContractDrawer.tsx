"use client";

import { useState } from "react";
import { useMoney } from "@/components/money-provider";
import { useTranslations } from "next-intl";
import { DrawerTabStrip } from "../../../components/drawer-tab-strip";
import {
  Badge,
  DisclosureSection,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  UrlDrawer,
} from "@openbooks/ui";
import { add, neg, sum } from "@openbooks/engine/src/money/money.ts";
import { PrepaidBreakageButton } from './PrepaidBreakageButton'
import { CancelRecognitionButton } from "./CancelRecognitionButton";
import { ReconcileLegacyButton } from "./ReconcileLegacyButton";
import { RunRecognitionButton } from "./RunRecognitionButton";
import Link from "next/link";
import { ModifyContractButton } from "./ModifyContractButton";
import {
  financialChangeEventLabel,
  financialChangeStatusLabel,
} from "@openbooks/engine/src/platform/financial-change-labels.ts";
import type { RevenueModificationOptions, ContractPayload } from "./_lib";
import type { MoneyFormatter } from "@/lib/money-format";

const STATUS_VARIANT: Record<
  string,
  "success" | "secondary" | "warning" | "outline"
> = {
  active: "success",
  complete: "secondary",
  draft: "outline",
  cancelled: "warning",
  open: "success",
  satisfied: "secondary",
};

export function contractSummaryTotals(
  obligations: ReadonlyArray<
    Pick<ContractPayload["obligations"][number], "planned" | "recognized">
  >,
): { recognized: string; deferred: string } {
  return {
    recognized: sum(obligations.map((obligation) => obligation.recognized)),
    deferred: sum(
      obligations.map((obligation) =>
        add(obligation.planned, neg(obligation.recognized)),
      ),
    ),
  };
}

/**
 * An obligation needs attention while it has no plan, carries unverified
 * history, or prices outside its fair value range — the same conditions
 * that force its schedule disclosure open.
 */
function obligationNeedsAttention(
  obligation: Pick<
    ContractPayload["obligations"][number],
    "lines" | "legacy_unverified" | "fair_value_flag"
  >,
): boolean {
  return (
    obligation.lines.length === 0 ||
    obligation.legacy_unverified ||
    obligation.fair_value_flag !== null
  );
}

/**
 * Revenue contract detail: the billed invoices on one sub-tab, performance
 * obligations with their primary-book recognition schedules on the other.
 * Billings and schedules are separate concepts, so they never share a body:
 * the shared drawer strip switches between them and both stay mounted
 * (hidden) so in-flight work survives the switch. Inside the obligations
 * body the parent-child workflow applies: one selector list names every
 * obligation, and selecting one shows only its schedule in the focused
 * pane below — never one schedule table per obligation. Recognition is
 * driven by invoices + the Run action. Contract changes prepare a separate,
 * independently approved proposal; this drawer never edits recognized
 * history in place.
 */
export function ContractDrawer({
  payload,
  canRun,
  modificationOptions,
  closeHref = "/revenue",
}: {
  payload: ContractPayload;
  canRun: boolean;
  modificationOptions?: RevenueModificationOptions;
  closeHref?: string;
}) {
  const { money } = useMoney();
  const t = useTranslations("revenue");
  const tCommon = useTranslations("common");
  const c = payload.contract;
  const totals = contractSummaryTotals(payload.obligations);
  // Billings vs obligations+schedules: separate concepts, separate bodies.
  // Client-local like the drawer rail: switching never navigates.
  const [section, setSection] = useState<"overview" | "obligations">("overview");
  // Obligations follow the parent-child workflow: the selector names each
  // obligation once, and only the selected obligation renders its schedule.
  // Attention-worthy obligations (no plan, unverified history, out-of-range
  // allocation) win the default selection so the queue surfaces itself.
  const [selectedObligationId, setSelectedObligationId] = useState<string | null>(null);
  const selectedObligation =
    payload.obligations.find((o) => o.id === selectedObligationId) ??
    payload.obligations.find((o) => obligationNeedsAttention(o)) ??
    payload.obligations[0] ??
    null;

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{c.contract_number}</span>
          <Badge variant={STATUS_VARIANT[c.status] ?? "secondary"}>
            {t(`status.${c.status}`)}
          </Badge>
        </span>
      }
      description={c.customer}
    >
      <div className="space-y-6 p-1">
        {/* -- everyday: what this contract covers and where it stands, in
            plain words. Posting detail lives one level down. */}
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{t(`scope.${c.scope}`)}</Badge>
            {c.source?.href ? (
              <Link
                className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
                href={c.source.href}
              >
                {c.source.label}
              </Link>
            ) : c.source ? (
              <span className="text-sm font-medium">{c.source.label}</span>
            ) : null}
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {coverageLine(t, c, payload)}
          </p>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {positionLine(t, money, payload)}
          </p>
        </section>

        {/* -- summary ------------------------------------------------- */}
        <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label={t("labels.total")}
            value={money(c.total_transaction_price)}
          />
          <Stat
            label={t("drawer.obligations")}
            value={String(payload.obligations.length)}
          />
          <Stat
            label={t("labels.recognized")}
            value={money(totals.recognized)}
          />
          <Stat label={t("labels.deferred")} value={money(totals.deferred)} />
        </section>

        <DrawerTabStrip
          tabs={[
            { key: "overview", label: t("drawer.contractTabs.overview") },
            { key: "obligations", label: t("drawer.obligations") },
          ]}
          activeKey={section}
          onSelect={(key) => setSection(key as "overview" | "obligations")}
          ariaLabel={t("drawer.contractTabs.ariaLabel")}
        />
        <div hidden={section !== "overview"} className="space-y-6">
        {/* -- configure: every billing posted against this contract ------ */}
        {payload.billings.length > 0 ? (
          <section className="space-y-2">
            <h3 className="font-semibold">{t("drawer.billingsTitle")}</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("drawer.billingInvoice")}</TableHead>
                  <TableHead>{t("drawer.billedOn")}</TableHead>
                  <TableHead className="text-right">
                    {t("drawer.billedAmount")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payload.billings.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <Link
                        className="underline"
                        href={`/ar/invoices?doc=${b.id}`}
                      >
                        {b.document_number}
                      </Link>
                    </TableCell>
                    <TableCell>{b.billed_on}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(b.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        ) : null}

        {/* -- cancellation: the dedicated workflow the invoice-void refusal
            points at. Only an active invoice-sourced contract names a live
            invoice to cancel; project contracts and finished contracts offer
            nothing here. */}
        {canRun && c.status === "active" && c.sourceInvoiceId ? (
          <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t("cancel.drawerHint")}
            </p>
            <CancelRecognitionButton
              documentId={c.sourceInvoiceId}
              invoiceNumber={c.sourceInvoiceNumber ?? c.contract_number}
            />
          </section>
        ) : null}

        {canRun &&
        modificationOptions &&
        ["active", "complete"].includes(c.status) ? (
          <ModifyContractButton
            payload={payload}
            options={modificationOptions}
          />
        ) : null}
        {canRun && payload.prepaidGrants?.length ? <PrepaidBreakageButton grants={payload.prepaidGrants} /> : null}
        {payload.changes?.length ? (
          <section className="space-y-2">
            <h3 className="font-semibold">{t("drawer.eventsTitle")}</h3>
            {payload.changes.map((change) => (
              <p key={change.id}>
                <Link
                  className="underline"
                  href={`/accounting/changes?change=${change.id}`}
                >
                  {change.effective_on} · {financialChangeEventLabel(change.operation)} ·{" "}
                  {financialChangeStatusLabel(change.status)}
                </Link>
              </p>
            ))}
          </section>
        ) : null}
        </div>
        <div hidden={section !== "obligations"} className="space-y-4">
        {/* -- parent: one obligation selector. A list of buttons, never a
            table, so the body holds exactly one concept table at a time. */}
        <section aria-label={t("drawer.obligations")} className="space-y-2">
          <ul className="space-y-2">
            {payload.obligations.map((o) => {
              const selected = selectedObligation?.id === o.id;
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedObligationId(o.id)}
                    aria-current={selected ? "true" : undefined}
                    className={`flex w-full flex-wrap items-center gap-2 rounded-lg border p-3 text-left ${
                      selected
                        ? "border-teal-600 dark:border-teal-400"
                        : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"
                    }`}
                  >
                    <span className="font-semibold">{o.description}</span>
                    <Badge variant={STATUS_VARIANT[o.status] ?? "secondary"}>
                      {t(`obligationStatus.${o.status}`)}
                    </Badge>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {t(`method.${o.method}`)} · {money(o.allocated_price)}
                    </span>
                    {o.legacy_unverified ? (
                      <Badge variant="warning">
                        {t("drawer.legacyUnverified")}
                      </Badge>
                    ) : null}
                    {o.fair_value_flag ? (
                      <Badge variant="warning">
                        {t("drawer.fairValueOutOfRange", {
                          low:
                            o.fair_value_low != null
                              ? money(o.fair_value_low)
                              : "—",
                          high:
                            o.fair_value_high != null
                              ? money(o.fair_value_high)
                              : "—",
                        })}
                      </Badge>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
        {/* -- focused child: only the selected obligation's schedule ------- */}
        {selectedObligation ? (
          <section
            aria-label={selectedObligation.description}
            className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{selectedObligation.description}</span>
                <Badge variant={STATUS_VARIANT[selectedObligation.status] ?? "secondary"}>
                  {t(`obligationStatus.${selectedObligation.status}`)}
                </Badge>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {t(`method.${selectedObligation.method}`)} · {money(selectedObligation.allocated_price)}
                </span>
                {selectedObligation.legacy_unverified ? (
                  <Badge variant="warning">
                    {t("drawer.legacyUnverified")}
                  </Badge>
                ) : null}
                {selectedObligation.fair_value_flag ? (
                  <Badge variant="warning">
                    {t("drawer.fairValueOutOfRange", {
                      low:
                        selectedObligation.fair_value_low != null
                          ? money(selectedObligation.fair_value_low)
                          : "—",
                      high:
                        selectedObligation.fair_value_high != null
                          ? money(selectedObligation.fair_value_high)
                          : "—",
                    })}
                  </Badge>
                ) : null}
              </div>
              {canRun ? (
                <RunRecognitionButton obligationId={selectedObligation.id} obligationDescription={selectedObligation.description} />
              ) : null}
              {canRun && selectedObligation.legacy_unverified ? (
                <ReconcileLegacyButton obligationId={selectedObligation.id} />
              ) : null}
            </div>
            {/* -- advanced: period-by-period posting detail, collapsed with
                its position summarized. Forced open while it needs
                attention (no plan, unverified history, out-of-range
                allocation). */}
            <DisclosureSection
              title={t("drawer.scheduleTitle")}
              summary={t("drawer.scheduleSummary", {
                periods: selectedObligation.lines.length,
                recognized: money(selectedObligation.recognized),
                planned: money(selectedObligation.planned),
              })}
              forceOpen={obligationNeedsAttention(selectedObligation)}
            >
              {selectedObligation.lines.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t("drawer.noSchedule")}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("drawer.period")}</TableHead>
                      <TableHead className="text-right">
                        {t("drawer.planned")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("drawer.recognized")}
                      </TableHead>
                      <TableHead>{tCommon("labels.status")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedObligation.lines.map((l, i) => (
                      <TableRow key={i}>
                        <TableCell>{l.period_name}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(l.planned_amount)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {l.journal_entry_id ? money(l.recognized_amount) : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={l.journal_entry_id ? "success" : "outline"}
                          >
                            {l.superseded_by_change_id
                              ? t("drawer.supersededStatus")
                              : l.reversal_journal_entry_id
                                ? t("drawer.reversedStatus")
                                : l.journal_entry_id
                                  ? t("drawer.postedStatus")
                                  : t("drawer.plannedStatus")}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </DisclosureSection>
          </section>
        ) : null}
        </div>
      </div>
    </UrlDrawer>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

type Translator = ReturnType<typeof useTranslations>;
type MoneyFormat = MoneyFormatter["money"];

/** Everyday coverage: which agreement this contract bills, in plain words. */
function coverageLine(
  t: Translator,
  c: ContractPayload["contract"],
  payload: ContractPayload,
): string {
  if (c.scope === "order" && c.source) {
    return payload.billings.length === 0
      ? t("coverage.orderShell", { source: c.source.label })
      : t("coverage.order", {
          source: c.source.label,
          count: payload.billings.length,
        });
  }
  if (c.scope === "subscription" && c.source) {
    return payload.billings.length === 0
      ? t("coverage.subscriptionShell", { source: c.source.label })
      : t("coverage.subscription", {
          source: c.source.label,
          count: payload.billings.length,
        });
  }
  return t("coverage.invoice", {
    source: c.sourceInvoiceNumber ?? c.contract_number,
  });
}

/** Everyday position: billed against recognized, with the side named. */
function positionLine(
  t: Translator,
  money: MoneyFormat,
  payload: ContractPayload,
): string {
  const position = payload.position;
  if (position.side === "settled") return t("position.settled");
  if (position.side === "liability") {
    return t("position.liability", {
      billed: money(position.billed),
      recognized: money(position.recognized),
      net: money(position.net),
    });
  }
  return t("position.asset", {
    billed: money(position.billed),
    recognized: money(position.recognized),
    net: money(
      position.net.startsWith("-") ? position.net.slice(1) : position.net,
    ),
  });
}
