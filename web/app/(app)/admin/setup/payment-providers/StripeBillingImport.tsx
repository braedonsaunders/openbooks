"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Badge,
  Button,
  DisclosureSection,
  Input,
  Label,
  SearchSelect,
  Select,
  Table as SharedTable,
  TableBody as SharedTableBody,
  TableCell as SharedTableCell,
  TableHead as SharedTableHead,
  TableHeader as SharedTableHeader,
  TableRow as SharedTableRow,
} from "@openbooks/ui";
import { fetchAction, type ActionError } from "@braedonsaunders/appkit-errors";
import { useAppAction } from "../../../../../lib/use-app-action";
import { useBusinessToday } from "../../../../../components/business-date-provider";
import { confirmDialog } from "../../../../../lib/confirm";
import { promptDialog } from "../../../../../lib/prompt";

type UnlinkedCustomer = {
  stripeId: string;
  email: string | null;
  emailMatch: boolean;
  suggestedCustomerId: string | null;
  suggestedCustomerName: string | null;
};

type RunRefusal = {
  objectType: string;
  stripeId: string;
  code: string;
  message: string;
  remedy: string;
};

type RunSummary = {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  stripeAccount: string | null;
  created: { meters: number; prices: number; records: number; replayed: number };
  linked: number;
  skipped: number;
  unlinked: number;
  refusals: number;
  refusalDetails: RunRefusal[];
  errorMessage: string | null;
};

type SkipRow = {
  id: string;
  stripeAccount: string;
  objectType: "customer" | "subscription";
  stripeId: string;
  reason: string | null;
};

type Overview = {
  schedule: "off" | "hourly" | "daily";
  lastRun: RunSummary | null;
  runs: RunSummary[];
  unlinked: UnlinkedCustomer[];
  skipped: SkipRow[];
};

type CustomerOption = { id: string; name: string; email: string | null };
type SubscriptionOption = { id: string; customerName: string; planName: string; status: string };

function weekAgo(today: string): string {
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 7);
  return date.toISOString().slice(0, 10);
}

function runBadgeVariant(status: string): "success" | "warning" | "destructive" | "secondary" {
  if (status === "ok") return "success";
  if (status === "ok_with_errors") return "warning";
  if (status === "failed") return "destructive";
  return "secondary";
}

function RunStatus({ status }: { status: string }) {
  const t = useTranslations("admin.setup.paymentProviders");
  const label = status === "ok" ? t("billingImport.statusOk")
    : status === "ok_with_errors" ? t("billingImport.statusOkWithErrors")
    : status === "failed" ? t("billingImport.statusFailed")
    : t("billingImport.statusRunning");
  return <Badge variant={runBadgeVariant(status)}>{label}</Badge>;
}

/**
 * Stripe Billing import: everyday state plus the next import, the schedule
 * and run log one level down, and the unlinked triage queue with one-click
 * remedies inside a collapsed section that summarizes itself.
 */
export function StripeBillingImport() {
  const t = useTranslations("admin.setup.paymentProviders");
  const tc = useTranslations("common");
  const today = useBusinessToday();
  const { busy, execute } = useAppAction();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [since, setSince] = useState(() => weekAgo(today));
  const [until, setUntil] = useState(today);
  const [customers, setCustomers] = useState<CustomerOption[] | null>(null);
  const [subscriptions, setSubscriptions] = useState<SubscriptionOption[] | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});

  const failureMessage = useCallback((failure: ActionError, fallback: string) => failure.displayMessage(fallback), []);

  const load = useCallback(async () => {
    const result = await fetchAction<Overview>("/api/usage/stripe-billing/overview");
    if (result.ok) {
      setOverview(result.data);
      setError(null);
    } else {
      setError(result.error.displayMessage(t("billingImport.loadFailed")));
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function refresh() {
    await load();
  }

  async function runImport() {
    const confirmed = await confirmDialog({
      title: t("billingImport.confirmTitle"),
      message: t("billingImport.confirmMessage", { since, until }),
      confirmLabel: t("billingImport.runImport"),
    });
    if (!confirmed) return;
    await execute(() => fetchAction("/api/usage/stripe-billing/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ since, until }),
    }), {
      fallbackMessage: tc("feedback.somethingWentWrong"),
      onOk: () => {
        toast.success(t("billingImport.imported"));
        void refresh();
      },
      onRefused: (failure) => setError(failureMessage(failure, tc("feedback.somethingWentWrong"))),
    });
  }

  async function saveSchedule(cadence: "off" | "hourly" | "daily") {
    await execute(() => fetchAction("/api/usage/stripe-billing/schedule", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cadence }),
    }), {
      fallbackMessage: tc("feedback.somethingWentWrong"),
      onOk: () => {
        toast.success(t("billingImport.scheduleSaved"));
        void refresh();
      },
      onRefused: (failure) => setError(failureMessage(failure, tc("feedback.somethingWentWrong"))),
    });
  }

  async function link(objectType: "customer" | "subscription", stripeId: string, nativeId: string) {
    if (!nativeId) return;
    await execute(() => fetchAction("/api/usage/stripe-billing/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectType, stripeId, nativeId }),
    }), {
      fallbackMessage: tc("feedback.somethingWentWrong"),
      onOk: () => {
        toast.success(t("billingImport.linked"));
        void refresh();
      },
      onRefused: (failure) => setError(failureMessage(failure, tc("feedback.somethingWentWrong"))),
    });
  }

  async function skip(objectType: "customer" | "subscription", stripeId: string) {
    const reason = await promptDialog({
      title: t("billingImport.skipTitle"),
      message: t("billingImport.skipMessage", { stripeId }),
      label: t("billingImport.skipReason"),
      confirmLabel: t("billingImport.skip"),
      cancelLabel: tc("actions.cancel"),
    });
    if (reason === null) return;
    const stripeAccount = overview?.lastRun?.stripeAccount;
    if (!stripeAccount) {
      setError(t("billingImport.skipNeedsRun"));
      return;
    }
    await execute(() => fetchAction("/api/usage/stripe-billing/skips", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectType, stripeId, stripeAccount, reason: reason || null }),
    }), {
      fallbackMessage: tc("feedback.somethingWentWrong"),
      onOk: () => {
        toast.success(t("billingImport.skipped"));
        void refresh();
      },
      onRefused: (failure) => setError(failureMessage(failure, tc("feedback.somethingWentWrong"))),
    });
  }

  async function unskip(row: SkipRow) {
    await execute(() => fetchAction("/api/usage/stripe-billing/skips", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectType: row.objectType, stripeId: row.stripeId, stripeAccount: row.stripeAccount }),
    }), {
      fallbackMessage: tc("feedback.somethingWentWrong"),
      onOk: () => {
        toast.success(t("billingImport.unskipped"));
        void refresh();
      },
      onRefused: (failure) => setError(failureMessage(failure, tc("feedback.somethingWentWrong"))),
    });
  }

  async function createAndLink(entry: UnlinkedCustomer) {
    const name = await promptDialog({
      title: t("billingImport.createCustomerTitle"),
      message: t("billingImport.createCustomerMessage", { email: entry.email ?? entry.stripeId }),
      label: t("billingImport.createCustomerName"),
      confirmLabel: t("billingImport.createAndLink"),
      cancelLabel: tc("actions.cancel"),
    });
    if (!name) return;
    const idempotencyKey = crypto.randomUUID();
    const created = await fetchAction<{ id: string }>("/api/parties", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ kind: "customer", displayName: name, email: entry.email, roles: { customer: {} } }),
    });
    if (!created.ok) {
      setError(created.error.displayMessage(t("billingImport.createFailed")));
      return;
    }
    await link("customer", entry.stripeId, created.data.id);
  }

  async function ensurePickers() {
    if (customers === null) {
      const result = await fetchAction<{ customers: CustomerOption[] }>("/api/usage/stripe-billing/customers");
      if (result.ok) setCustomers(result.data.customers);
    }
    if (subscriptions === null) {
      const result = await fetchAction<{ subscriptions: Array<{ id: string; customerName: string; planName: string; status: string }> }>("/api/subscriptions");
      if (result.ok) {
        setSubscriptions(result.data.subscriptions.map((s) => ({
          id: s.id, customerName: s.customerName, planName: s.planName, status: s.status,
        })));
      }
    }
  }

  if (!overview) {
    return loading
      ? <p className="text-sm text-slate-500">…</p>
      : (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-red-600">{error ?? tc("feedback.somethingWentWrong")}</p>
          <Button variant="outline" onClick={() => { setLoading(true); void load(); }}>{tc("actions.retry")}</Button>
        </div>
      );
  }

  const lastRun = overview.lastRun;
  const attention = overview.unlinked.length + overview.skipped.length;
  const subRefusals = lastRun?.refusalDetails.filter((r) => r.code === "stripe_subscription_unlinked") ?? [];

  return (
    <div className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-800">
      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white">{t("billingImport.title")}</h3>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t("billingImport.description")}</p>
      </div>
      {error ? <p className="text-sm text-red-600" role="alert">{error}</p> : null}

      {lastRun ? (
        <p className="text-sm text-slate-700 dark:text-slate-300">
          {t("billingImport.lastRun", {
            date: lastRun.startedAt.slice(0, 10),
            records: lastRun.created.records,
            customers: lastRun.seen.customers,
            prices: lastRun.created.prices,
          })}
          {" "}
          <RunStatus status={lastRun.status} />
          {overview.unlinked.length > 0 ? (
            <span className="ml-2 text-amber-700 dark:text-amber-400">
              {t("billingImport.needsLinking", { count: overview.unlinked.length })}
            </span>
          ) : null}
        </p>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-300 p-4 dark:border-slate-700">
          <p className="text-sm font-medium text-slate-900 dark:text-white">{t("billingImport.neverRun")}</p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t("billingImport.neverRunDetail")}</p>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label>{t("billingImport.since")}</Label>
          <Input type="date" value={since} max={until} onChange={(e) => setSince(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>{t("billingImport.until")}</Label>
          <Input type="date" value={until} min={since} max={today} onChange={(e) => setUntil(e.target.value)} />
        </div>
        <Button disabled={busy} onClick={() => void runImport()}>
          {t("billingImport.runImport")}
        </Button>
      </div>
      <p className="text-xs text-slate-400 dark:text-slate-500">{t("billingImport.noInvoices")}</p>

      <div className="space-y-1.5">
        <Label>{t("billingImport.schedule")}</Label>
        <Select value={overview.schedule} disabled={busy} onChange={(e) => void saveSchedule(e.target.value as "off" | "hourly" | "daily")}>
          <option value="off">{t("billingImport.scheduleOff")}</option>
          <option value="hourly">{t("billingImport.scheduleHourly")}</option>
          <option value="daily">{t("billingImport.scheduleDaily")}</option>
        </Select>
      </div>

      {overview.runs.length > 0 ? (
        <SharedTable>
          <SharedTableHeader>
            <SharedTableRow>
              <SharedTableHead>{t("billingImport.runStarted")}</SharedTableHead>
              <SharedTableHead>{t("billingImport.runStatus")}</SharedTableHead>
              <SharedTableHead>{t("billingImport.runCreated")}</SharedTableHead>
              <SharedTableHead>{t("billingImport.runAttention")}</SharedTableHead>
            </SharedTableRow>
          </SharedTableHeader>
          <SharedTableBody>
            {overview.runs.map((run) => (
              <SharedTableRow key={run.id}>
                <SharedTableCell>{run.startedAt.slice(0, 16).replace("T", " ")}</SharedTableCell>
                <SharedTableCell><RunStatus status={run.status} /></SharedTableCell>
                <SharedTableCell>
                  {t("billingImport.runCreatedDetail", {
                    records: run.created.records,
                    prices: run.created.prices,
                    linked: run.linked,
                  })}
                </SharedTableCell>
                <SharedTableCell>
                  {run.unlinked + run.skipped + run.refusals === 0
                    ? "—"
                    : t("billingImport.runAttentionDetail", {
                      unlinked: run.unlinked,
                      skipped: run.skipped,
                      refusals: run.refusals,
                    })}
                </SharedTableCell>
              </SharedTableRow>
            ))}
          </SharedTableBody>
        </SharedTable>
      ) : null}

      <DisclosureSection
        title={t("billingImport.needsAttention")}
        summary={attention + subRefusals.length === 0 ? t("billingImport.allClear") : t("billingImport.attentionSummary", { count: attention + subRefusals.length })}
        forceOpen={attention + subRefusals.length > 0}
        onOpenChange={(open) => { if (open) void ensurePickers(); }}
      >
        <div className="space-y-3">
          {overview.unlinked.map((entry) => (
            <div key={entry.stripeId} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-sm font-medium text-slate-900 dark:text-white">
                {entry.stripeId}
                {entry.email ? <span className="ml-2 font-normal text-slate-500">{entry.email}</span> : null}
              </p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {entry.emailMatch && entry.suggestedCustomerName
                  ? t("billingImport.suggestion", { name: entry.suggestedCustomerName })
                  : t("billingImport.noSuggestion")}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {entry.emailMatch && entry.suggestedCustomerId ? (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void link("customer", entry.stripeId, entry.suggestedCustomerId!)}>
                    {t("billingImport.linkSuggested", { name: entry.suggestedCustomerName ?? "" })}
                  </Button>
                ) : null}
                <SearchSelect
                  value={picks[entry.stripeId] ?? ""}
                  onChange={(value) => setPicks((prev) => ({ ...prev, [entry.stripeId]: value }))}
                  options={(customers ?? []).map((c) => ({ value: c.id, label: c.email ? `${c.name} · ${c.email}` : c.name }))}
                  placeholder={t("billingImport.chooseCustomer")}
                  sheetTitle={t("billingImport.chooseCustomer")}
                  ariaLabel={t("billingImport.chooseCustomer")}
                  className="w-64"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !(picks[entry.stripeId] ?? "")}
                  onClick={() => void link("customer", entry.stripeId, picks[entry.stripeId] ?? "")}
                >
                  {t("billingImport.link")}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void createAndLink(entry)}>
                  {t("billingImport.createCustomer")}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void skip("customer", entry.stripeId)}>
                  {t("billingImport.skip")}
                </Button>
              </div>
            </div>
          ))}
          {subRefusals.map((refusal) => (
            <div key={refusal.stripeId} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-sm font-medium text-slate-900 dark:text-white">{refusal.stripeId}</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{refusal.message}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <SearchSelect
                  value={picks[refusal.stripeId] ?? ""}
                  onChange={(value) => setPicks((prev) => ({ ...prev, [refusal.stripeId]: value }))}
                  options={(subscriptions ?? []).map((s) => ({
                    value: s.id,
                    label: `${s.customerName} · ${s.planName} (${s.status})`,
                  }))}
                  placeholder={t("billingImport.chooseSubscription")}
                  sheetTitle={t("billingImport.chooseSubscription")}
                  ariaLabel={t("billingImport.chooseSubscription")}
                  className="w-64"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !(picks[refusal.stripeId] ?? "")}
                  onClick={() => void link("subscription", refusal.stripeId, picks[refusal.stripeId] ?? "")}
                >
                  {t("billingImport.link")}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void skip("subscription", refusal.stripeId)}>
                  {t("billingImport.skip")}
                </Button>
              </div>
            </div>
          ))}
          {overview.skipped.map((row) => (
            <div key={row.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-sm text-slate-700 dark:text-slate-300">
                {row.stripeId}
                <span className="ml-2 text-slate-500">
                  {t("billingImport.skippedDetail", { reason: row.reason ?? t("billingImport.noReason") })}
                </span>
              </p>
              <div className="mt-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void unskip(row)}>
                  {t("billingImport.unskip")}
                </Button>
              </div>
            </div>
          ))}
          {attention + subRefusals.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t("billingImport.allClear")}</p>
          ) : null}
        </div>
      </DisclosureSection>
    </div>
  );
}
