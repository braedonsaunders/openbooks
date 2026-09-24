"use client";

import { useMoney } from "@/components/money-provider";
import { useTranslations } from "next-intl";
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  UrlDrawer,
} from "@openbooks/ui";
import { add, neg, sum } from "@openbooks/engine/src/money/money.ts";
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
 * Revenue contract detail: performance obligations and,
 * per obligation, the primary-book recognition schedule (planned vs recognized,
 * with the posted period entries). Recognition is driven by invoices + the Run
 * action. Contract changes prepare a separate, independently approved proposal;
 * this drawer never edits recognized history in place.
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
        {/* -- obligations + schedules -------------------------------- */}
        {payload.obligations.map((o) => (
          <section
            key={o.id}
            className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
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
              </div>
              {canRun ? (
                <RunRecognitionButton obligationId={o.id} obligationDescription={o.description} />
              ) : null}
              {canRun && o.legacy_unverified ? (
                <ReconcileLegacyButton obligationId={o.id} />
              ) : null}
            </div>
            {o.lines.length === 0 ? (
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
                  {o.lines.map((l, i) => (
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
          </section>
        ))}
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
