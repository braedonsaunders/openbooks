"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { Badge, EmptyState } from "@openbooks/ui";
import { DisclosureSection } from "@openbooks/ui";
import { KpiStrip } from "@/components/kpi-strip";
import { ListDrawerLink } from "@/components/list-drawer-link";
import { useMoney } from "@/components/money-provider";
import type { ContractCostAttentionRow } from "./view";

/**
 * Contract costs everyday view: the asset balance, this period's
 * amortization, and the needs-attention queue with one-click remedies.
 * Policy detail sits advanced and collapsed; the list below carries the
 * assets themselves.
 */
export function ContractCostWorkspace({
  data,
}: {
  data: {
    assetBalance: string;
    periodAmortized: string;
    baseCurrency: string;
    attention: ContractCostAttentionRow[];
    canManage: boolean;
    policy: {
      basis: string;
      practicalExpedient: boolean;
      customerLifeMonths: number | null;
    } | null;
  };
}) {
  const t = useTranslations("contractCosts");
  const { money } = useMoney();
  const unlinked = data.attention.filter((item) => item.kind === "unlinked");
  const churned = data.attention.filter((item) => item.kind === "churned");
  return (
    <div className="space-y-4">
      <KpiStrip
        items={[
          { label: t("workspace.assetBalance"), value: money(data.assetBalance, { currency: data.baseCurrency }) },
          { label: t("workspace.periodAmortization"), value: money(data.periodAmortized, { currency: data.baseCurrency }) },
          {
            label: t("workspace.unlinked"),
            value: String(unlinked.length),
            tone: unlinked.length > 0 ? "bad" : undefined,
          },
          {
            label: t("workspace.churned"),
            value: String(churned.length),
            tone: churned.length > 0 ? "bad" : undefined,
          },
        ]}
      />
      {data.attention.length === 0 ? (
        <EmptyState
          title={t("queue.emptyTitle")}
          description={t("queue.emptyDescription")}
        />
      ) : (
        <section aria-label={t("queue.title")} className="space-y-2">
          {data.attention.map((item) => (
            <div
              key={item.assetId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
            >
              <div className="flex items-center gap-2.5">
                <Badge variant={item.kind === "unlinked" ? "warning" : "destructive"}>
                  {t(`queue.kind.${item.kind}`)}
                </Badge>
                <span className="text-sm">
                  {item.kind === "unlinked"
                    ? t("queue.unlinkedHint", { date: item.capitalizedOn })
                    : t("queue.churnedHint", {
                        contract: item.contractNumber ?? "",
                        amount: money(item.carrying, { currency: data.baseCurrency }),
                      })}
                </span>
              </div>
              <ListDrawerLink href={`/revenue/contract-costs?asset=${item.assetId}`}>
                {t(item.kind === "unlinked" ? "queue.linkNow" : "queue.reviewNow")}
              </ListDrawerLink>
            </div>
          ))}
        </section>
      )}
      <DisclosureSection title={t("workspace.policyTitle")} summary={t("workspace.policySummary")}>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {data.policy
            ? t("workspace.policyDetail", {
                basis: t(`policy.basis.${data.policy.basis}`),
                expedient: t(`common.${data.policy.practicalExpedient ? "on" : "off"}`),
                life: data.policy.customerLifeMonths ?? t("common.derived"),
              })
            : t("workspace.noPolicy")}
        </p>
        <Link
          href="/admin/setup?setupTab=contract-cost-policy"
          className="text-sm font-medium text-teal-700 dark:text-teal-300"
        >
          {t("workspace.openPolicy")}
        </Link>
      </DisclosureSection>
    </div>
  );
}
