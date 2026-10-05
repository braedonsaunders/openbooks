"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
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
import { DrawerTabStrip } from "../../../../components/drawer-tab-strip";
import { useMoney } from "@/components/money-provider";
import type { ContractCostAssetPayload } from "./view";
import { ImpairAssetButton } from "./ImpairAssetButton";
import { LinkAssetButton } from "./LinkAssetButton";

const STATUS_VARIANT: Record<string, "success" | "secondary" | "warning" | "outline" | "destructive"> = {
  active: "success",
  fully_amortized: "secondary",
  impaired: "destructive",
  expensed: "outline",
};

/**
 * Capitalized cost detail: facts, the amortization schedule (planned vs
 * posted, with per-period entry links), and the journal trail on its own
 * sibling tab — never stacked. Linking and impairment act here, in
 * context, and return to this drawer.
 */
export function ContractCostDrawer({
  payload,
  canManage,
  canApprove,
  contracts,
  policy,
  baseCurrency,
  closeHref = "/revenue/contract-costs",
}: {
  payload: ContractCostAssetPayload;
  canManage: boolean;
  canApprove: boolean;
  contracts: { id: string; number: string; customer: string }[];
  policy: { basis: string } | null;
  baseCurrency: string;
  closeHref?: string;
}) {
  const t = useTranslations("contractCosts");
  const { money } = useMoney();
  const a = payload.asset;
  // The schedule and the journal trail are separate concepts with separate
  // bodies. Client-local like the drawer rail: switching never navigates,
  // and both stay mounted so link and impair actions keep their context.
  const [panel, setPanel] = useState<"schedule" | "journal">("schedule");
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{a.contractNumber ?? t("drawer.unlinked")}</span>
          <Badge variant={STATUS_VARIANT[a.status] ?? "secondary"}>
            {t(`status.${a.status}`)}
          </Badge>
        </span>
      }
      description={a.customer ?? t(`costType.${a.costType}`)}
    >
      <div className="space-y-6 p-1">
        <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label={t("drawer.capitalized")} value={money(a.amount, { currency: a.currency })} />
          <Stat label={t("drawer.carrying")} value={money(a.carrying, { currency: a.currency })} />
          <Stat label={t("drawer.window")} value={`${a.amortStartOn} → ${a.amortEndOn}`} />
          <Stat label={t("drawer.method")} value={t(`method.${a.method}`)} />
        </section>

        {canManage && !a.contractId && a.status === "active" && (
          <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <p className="text-xs text-slate-500 dark:text-slate-400">{t("drawer.linkHint")}</p>
            <LinkAssetButton assetId={a.id} contracts={contracts} />
          </section>
        )}
        {canApprove && a.status === "active" && (
          <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <p className="text-xs text-slate-500 dark:text-slate-400">{t("drawer.impairHint")}</p>
            <ImpairAssetButton assetId={a.id} currency={a.currency} carrying={a.carrying} />
          </section>
        )}

        <DrawerTabStrip
          tabs={[
            { key: "schedule", label: t("drawer.scheduleTitle") },
            { key: "journal", label: t("drawer.entriesTitle") },
          ]}
          activeKey={panel}
          onSelect={(key) => setPanel(key)}
          ariaLabel={a.contractNumber ?? t("drawer.unlinked")}
        />
        <div hidden={panel !== "schedule"} className="space-y-2">
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("drawer.scheduleTitle")}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("drawer.month")}</TableHead>
                <TableHead>{t("drawer.period")}</TableHead>
                <TableHead className="text-right">{t("drawer.planned")}</TableHead>
                <TableHead className="text-right">{t("drawer.posted")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payload.schedule.map((line) => (
                <TableRow key={line.month}>
                  <TableCell className="font-mono">{line.month}</TableCell>
                  <TableCell>{line.periodName ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(line.amount, { currency: a.currency })}
                  </TableCell>
                  <TableCell className="text-right">
                    {line.posted && line.entryId ? (
                      <Link
                        href={`/accounting/journal?entry=${line.entryId}`}
                        className="font-medium text-teal-700 dark:text-teal-300"
                      >
                        {t("drawer.viewEntry")}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
        </div>
        <div hidden={panel !== "journal"} className="space-y-2">
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("drawer.entriesTitle")}</h3>
          <ul className="space-y-1">
            {payload.entries.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-slate-600 dark:text-slate-400">
                  {t(`event.${entry.origin}`)} · {entry.postingDate} · {entry.periodName}
                </span>
                <Link
                  href={`/accounting/journal?entry=${entry.id}`}
                  className="font-medium text-teal-700 dark:text-teal-300"
                >
                  {t("drawer.viewEntry")}
                </Link>
              </li>
            ))}
          </ul>
        </section>
        </div>

        <DisclosureSection title={t("drawer.advancedTitle")} summary={t("drawer.advancedSummary")}>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-slate-500">{t("drawer.salesRep")}</dt>
            <dd>{a.salesRep ?? "—"}</dd>
            <dt className="text-slate-500">{t("drawer.capitalizedOn")}</dt>
            <dd className="font-mono">{a.capitalizedOn}</dd>
            <dt className="text-slate-500">{t("drawer.policyBasis")}</dt>
            <dd>{policy ? t(`policy.basis.${policy.basis}`) : "—"}</dd>
            <dt className="text-slate-500">{t("drawer.baseCurrency")}</dt>
            <dd className="font-mono">{baseCurrency}</dd>
          </dl>
        </DisclosureSection>
      </div>
    </UrlDrawer>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
