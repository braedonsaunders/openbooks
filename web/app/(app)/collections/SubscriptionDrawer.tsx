"use client";

import { DrawerTabStrip } from "@/components/drawer-tab-strip";
import { useSubscriptionLifecycle } from "./use-subscription-lifecycle";
import { fetchAction } from "@braedonsaunders/appkit-errors";
import { RenewalActions } from "./RenewalActions";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Badge, Button, DisclosureSection, SearchSelect } from "@openbooks/ui";
import { TransactionDrawer } from "../../../components/transaction-drawer";
import { useMoney } from "../../../components/money-provider";
import { readApiErrorMessage } from "../../../lib/api-error";
import type { SubscriptionDrawerData } from "./subscription-drawer";

function statusVariant(
  status: SubscriptionDrawerData["status"],
): "default" | "secondary" | "outline" | "destructive" | "warning" | "success" {
  if (status === "active") return "success";
  if (status === "suspended") return "destructive";
  if (status === "paused") return "warning";
  return "secondary";
}

/**
 * Minimal subscription record: status, the next bill, and who pays — with
 * the bill-to/payer overrides and the revenue contract one disclosure down.
 * Opens from a collections row, a revenue contract source link, or the
 * subscription list-drawer route; one drawer shell through loading, refusal
 * and retry.
 */
export function SubscriptionDrawer({
  drawer: initialDrawer,
  closeHref,
}: {
  drawer: SubscriptionDrawerData;
  closeHref: string;
}) {
  const [drawer, setDrawer] = useState(initialDrawer);
  const [reloadFailure, setReloadFailure] = useState<string | null>(null);
  const [section, setSection] = useState("billing");
  const t = useTranslations("ar.collections.subscriptions.drawer");
  const common = useTranslations("common");
  const router = useRouter();
  const { money } = useMoney();
  async function reload() {
    window.dispatchEvent(new window.Event("openbooks:subscriptions-changed"));
    const result = await fetchAction<{ drawer: SubscriptionDrawerData }>(
      `/api/lists/subscription/drawer?subscription=${encodeURIComponent(drawer.id)}`,
    );
    if (!result.ok) {
      setReloadFailure(result.error.displayMessage(common("feedback.loadFailed")));
      return;
    }
    if (!result.data.drawer || result.data.drawer.id !== drawer.id) {
      setReloadFailure(common("feedback.loadFailed"));
      return;
    }
    setReloadFailure(null);
    setDrawer(result.data.drawer);
    router.refresh();
  }
  const amount = money(drawer.amount, { currency: drawer.currency });
  const [billTo, setBillTo] = useState<string | null>(drawer.billTo?.id ?? null);
  const [payer, setPayer] = useState<string | null>(drawer.payer?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lifecycle = useSubscriptionLifecycle(drawer, reload, reloadFailure !== null || busy);
  const options = drawer.customers.map((c) => ({ value: c.id, label: c.name }));
  const dirty =
    (billTo ?? null) !== (drawer.billTo?.id ?? null) ||
    (payer ?? null) !== (drawer.payer?.id ?? null);

  async function onSaveOverrides() {
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "updateSubscription",
          id: drawer.id,
          billToPartyId: billTo,
          payerPartyId: payer,
        }),
      });
      // The refusal reads through the shared helper so message, remedy and
      // code render instead of a bare fallback.
      if (!res.ok) {
        throw new Error(await readApiErrorMessage(res, t("overrides.saveFailed")));
      }
      toast.success(t("overrides.saved"));
      await reload();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t("overrides.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const actions = (
    <>
      {lifecycle.actions}
      {drawer.contract ? (
        <Button variant="outline" asChild>
          <Link href={`/revenue?contract=${encodeURIComponent(drawer.contract.id)}`}>
            {drawer.contract.number}
          </Link>
        </Button>
      ) : null}
      {drawer.lastInvoice ? (
        <Button variant="outline" asChild>
          <Link href={`/ar/invoices?doc=${encodeURIComponent(drawer.lastInvoice.id)}`}>
            {drawer.lastInvoice.number}
          </Link>
        </Button>
      ) : null}
    </>
  );

  return (
    <TransactionDrawer
      closeHref={closeHref}
      recordId={drawer.id}
      title={
        <span className="flex items-center gap-2.5">
          <span>{drawer.planName}</span>
          <Badge variant={statusVariant(drawer.status)}>{t(`status.${drawer.status}`)}</Badge>
        </span>
      }
      description={[
        drawer.customer.name,
        t("every", { count: drawer.intervalCount, unit: drawer.interval }),
      ]
        .filter(Boolean)
        .join(" · ")}
      actions={actions}
      detailTabs={[]}
    >
      {reloadFailure ? (
        <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
          <p>{reloadFailure}</p>
          <Button variant="outline" onClick={() => void reload()}>
            {common("actions.retry")}
          </Button>
        </div>
      ) : null}
      {lifecycle.refusal ? (
        <p role="alert" className="text-sm text-destructive">
          {lifecycle.refusal}
        </p>
      ) : null}
      {lifecycle.panel}
      <div className="space-y-2">
        <p className="tabular-nums text-lg font-semibold">
          {amount}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            / {t("every", { count: drawer.intervalCount, unit: drawer.interval })}
          </span>
        </p>
        <p className="text-sm text-muted-foreground">
          {t("nextBill", { date: drawer.nextBillOn })}
        </p>
        {drawer.lastError ? <p className="text-sm text-destructive">{drawer.lastError}</p> : null}
      </div>
      {drawer.canManage && drawer.renewalEnabled ? (
        <DrawerTabStrip
          tabs={[
            { key: "billing", label: t("billing.title") },
            { key: "renewals", label: "Renewals" },
          ]}
          activeKey={section}
          onSelect={setSection}
          ariaLabel="Subscription details"
        />
      ) : null}
      {drawer.canManage && drawer.renewalEnabled ? (
        <div hidden={section !== "renewals"}>
          <RenewalActions
            subscriptionId={drawer.id}
            initialDocument={drawer.renewalDocument ?? null}
            canAccept={drawer.canAcceptRenewal ?? false}
          />
        </div>
      ) : null}
      <div hidden={section !== "billing"}>
        <DisclosureSection title={t("billing.title")} summary={t("billing.summary")}>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t("billing.customer")}</dt>
              <dd>{drawer.customer.name}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t("billing.autoPost")}</dt>
              <dd>{drawer.autoPost ? common("labels.yes") : common("labels.no")}</dd>
            </div>
          </dl>
          {drawer.canManage ? (
            <div className="mt-3 space-y-3">
              <p className="text-sm text-muted-foreground">{t("overrides.hint")}</p>
              <div className="space-y-1">
                <span className="text-sm text-muted-foreground">{t("overrides.billTo")}</span>
                <SearchSelect
                  searchable
                  clearable
                  value={billTo ?? ""}
                  onChange={(value) => setBillTo(value || null)}
                  options={options}
                  placeholder={t("billing.sameAsCustomer")}
                />
              </div>
              <div className="space-y-1">
                <span className="text-sm text-muted-foreground">{t("overrides.payer")}</span>
                <SearchSelect
                  searchable
                  clearable
                  value={payer ?? ""}
                  onChange={(value) => setPayer(value || null)}
                  options={options}
                  placeholder={t("billing.sameAsCustomer")}
                />
              </div>
              {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
              <Button
                variant="outline"
                disabled={!dirty || busy || lifecycle.busy || reloadFailure !== null}
                onClick={onSaveOverrides}
              >
                {t("overrides.save")}
              </Button>
            </div>
          ) : (
            <dl className="mt-2 space-y-1.5 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t("billing.billTo")}</dt>
                <dd>{drawer.billTo ? drawer.billTo.name : t("billing.sameAsCustomer")}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t("billing.payer")}</dt>
                <dd>{drawer.payer ? drawer.payer.name : t("billing.sameAsCustomer")}</dd>
              </div>
            </dl>
          )}
        </DisclosureSection>
      </div>
    </TransactionDrawer>
  );
}
