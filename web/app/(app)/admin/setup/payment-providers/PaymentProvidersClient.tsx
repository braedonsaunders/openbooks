"use client";

import {
  Table as SharedTable,
  TableHeader as SharedTableHeader,
  TableRow as SharedTableRow,
  TableHead as SharedTableHead,
  TableBody as SharedTableBody,
  TableCell as SharedTableCell,
} from "@openbooks/ui";
import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Button,
  Card,
  CardContent,
  Input,
  Label,
  PageHeader,
  Select,
  UrlDrawer,
} from "@openbooks/ui";
import { fetchAction, type ActionError } from "@braedonsaunders/appkit-errors";

import { useAppAction } from "../../../../../lib/use-app-action";
import { useBusinessToday } from "../../../../../components/business-date-provider";
import { ListPageLayout } from "@/components/page-layout";
import { MoneyInput } from "@/components/money-input";
import { StripeBillingImport } from "./StripeBillingImport";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ModuleHomeTabs } from "@/components/module-home/tabs";
import { ProcessorReceiptPolicies } from "./ProcessorReceiptPolicies";
import { DateField } from "@/components/date-field";
import type {
  AutomationProviderKey,
  PaymentAutomationConfig,
  PaymentProviderAccount,
  PaymentProviderConfig,
  PaymentProviderSetupData,
  PaymentSurchargeRule,
  ProviderKey,
} from "@/lib/setup/payment-providers-types";
import {
  resolvePaymentProviderView,
  surchargeRuleDrawerHrefs,
} from "@/lib/setup/payment-provider-navigation";

type Config = PaymentProviderConfig;
type AutomationConfig = PaymentAutomationConfig;
type Account = PaymentProviderAccount;
type Rule = PaymentSurchargeRule;
type Data = PaymentProviderSetupData & {
  view?: "checkout" | "settlement" | "surcharge" | "processor_receipts";
};

const PROVIDERS: { key: ProviderKey; label: string; merchantAccount?: boolean }[] = [
  { key: "stripe", label: "Stripe" },
  { key: "adyen", label: "Adyen", merchantAccount: true },
  { key: "gocardless", label: "GoCardless (bank debit)" },
];

const AUTOMATION_PROVIDERS: {
  key: AutomationProviderKey;
  nameKey: string;
  descriptionKey: string;
  channelsNote: boolean;
}[] = [
  {
    key: "paypal",
    nameKey: "paypalName",
    descriptionKey: "paypalDescription",
    channelsNote: false,
  },
  {
    key: "shopify_payments",
    nameKey: "shopifyName",
    descriptionKey: "shopifyDescription",
    channelsNote: true,
  },
  {
    key: "square",
    nameKey: "squareName",
    descriptionKey: "squareDescription",
    channelsNote: false,
  },
];

export function PaymentProvidersClient({
  initialData,
}: {
  initialData: PaymentProviderSetupData & {
    view: "checkout" | "settlement" | "surcharge" | "processor_receipts";
  };
}) {
  const t = useTranslations("admin.setup.paymentProviders");
  const tFunding = useTranslations("processorReceipts");
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const ruleDrawerOpen = searchParams.get("rule") === "new";
  const requestedView = searchParams.get("view");
  const view = resolvePaymentProviderView(requestedView, initialData.view, ruleDrawerOpen);
  const { closeHref: closeRuleHref, newHref: newRuleHref } = surchargeRuleDrawerHrefs(
    pathname,
    searchParams.toString(),
  );
  const tc = useTranslations("common");
  const [data, setData] = useState<Data>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, execute } = useAppAction();

  // The unrestricted-scope remedy survives the lifecycle conversion: the
  // failure keeps the server's machine-readable code, so map it to the
  // localized copy instead of rendering the raw server string.
  const actionFailureMessage = useCallback(
    (failure: ActionError, fallback: string) => {
      if (
        failure.code === "unrestricted_scope_required" ||
        failure.serverMessage === "requires unrestricted subsidiary access"
      ) {
        return t("errors.unrestrictedScope");
      }
      return failure.displayMessage(fallback);
    },
    [t],
  );

  const load = useCallback(async () => {
    const result = await fetchAction<Data>("/api/admin/setup/payment-providers");
    if (result.ok) {
      setData(result.data);
      setError(null);
    } else {
      setError(actionFailureMessage(result.error, t("errors.loadFailed")));
    }
  }, [actionFailureMessage, t]);

  async function post(body: Record<string, unknown>) {
    setError(null);
    setNotice(null);
    let saved = false;
    const fallbackMessage = tc("feedback.somethingWentWrong");
    await execute(
      () =>
        fetchAction("/api/admin/setup/payment-providers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      {
        fallbackMessage,
        onOk: () => {
          saved = true;
          setNotice(t("saved"));
        },
        onRefused: (failure) => setError(actionFailureMessage(failure, fallbackMessage)),
      },
    );
    if (saved) await load();
    return saved;
  }

  // Settlement-automation saves travel through the settlements configuration
  // endpoint (banking domain), not the acceptance endpoint above: the two
  // cards own only policy and posting accounts, never hosted checkout.
  async function postSettlement(body: Record<string, unknown>) {
    setError(null);
    setNotice(null);
    let saved = false;
    const fallbackMessage = tc("feedback.somethingWentWrong");
    await execute(
      () =>
        fetchAction("/api/psp/settlements", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      {
        fallbackMessage,
        onOk: () => {
          saved = true;
          setNotice(t("saved"));
        },
        onRefused: (failure) => setError(actionFailureMessage(failure, fallbackMessage)),
      },
    );
    if (saved) await load();
    return saved;
  }

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t("title")}
          description={view === "processor_receipts" ? tFunding("description") : t("description")}
          actions={
            view === "surcharge" ? (
              <Button asChild>
                <Link href={newRuleHref}>{t("addRule")}</Link>
              </Button>
            ) : undefined
          }
        />
      }
    >
      <div className="space-y-5">
        <ModuleHomeTabs
          placement="local"
          tabs={[
            ...(data.featureEnabled
              ? [
                  { label: tFunding("providersTab"), href: pathname, active: view === "checkout" },
                  {
                    label: t("automationTitle"),
                    href: `${pathname}?view=settlement`,
                    active: view === "settlement",
                  },
                  {
                    label: t("surchargeRules"),
                    href: `${pathname}?view=surcharge`,
                    active: view === "surcharge",
                  },
                ]
              : []),
            ...(data.bankingEnabled
              ? [
                  {
                    label: tFunding("accountsTab"),
                    href: `${pathname}?view=processor_receipts`,
                    active: view === "processor_receipts",
                  },
                ]
              : []),
          ]}
        />
        {error ? (
          <div className="flex items-center justify-between gap-3" role="alert">
            <p className="text-sm text-red-600">{error}</p>
            <Button variant="outline" onClick={() => void load()}>
              {tc("actions.retry")}
            </Button>
          </div>
        ) : null}
        {notice ? <p className="text-sm text-teal-700 dark:text-teal-400">{notice}</p> : null}
        {view === "processor_receipts" ? <ProcessorReceiptPolicies /> : null}
        {view === "checkout" ? (
          <div className="space-y-5">
            {PROVIDERS.map((p) => (
              <ProviderCard
                key={p.key}
                provider={p}
                config={data.configs.find((c) => c.provider === p.key)}
                bankAccounts={data.bankAccounts}
                postingAccounts={data.postingAccounts}
                rules={data.surchargeRules.filter((r) => r.isActive)}
                onSave={post}
                busy={busy}
                t={t}
              />
            ))}
          </div>
        ) : null}

        {view === "settlement" ? (
          <div className="space-y-5">
            {AUTOMATION_PROVIDERS.map((p) => (
              <AutomationProviderCard
                key={p.key}
                providerKey={p.key}
                config={data.automationConfigs.find((c) => c.provider === p.key)}
                postingAccounts={data.postingAccounts}
                onSave={postSettlement}
                busy={busy}
                t={t}
              />
            ))}
          </div>
        ) : null}

        {view === "surcharge" ? (
          <SurchargeRules
            rules={data.surchargeRules}
            incomeAccounts={data.incomeAccounts}
            onSave={post}
            busy={busy}
            t={t}
            open={ruleDrawerOpen}
            closeHref={closeRuleHref}
            onClose={() => router.replace(closeRuleHref)}
          />
        ) : null}
      </div>
    </ListPageLayout>
  );
}

function ProviderCard({
  provider,
  config,
  bankAccounts,
  postingAccounts,
  rules,
  onSave,
  busy,
  t,
}: {
  provider: { key: ProviderKey; label: string; merchantAccount?: boolean };
  config: Config | undefined;
  bankAccounts: Account[];
  postingAccounts: Account[];
  rules: Rule[];
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
  busy: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const [enabled, setEnabled] = useState(config?.acceptanceEnabled ?? false);
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [publishableKey, setPublishableKey] = useState(config?.publishableKey ?? "");
  const [merchantAccount, setMerchantAccount] = useState(
    typeof config?.settings?.merchantAccount === "string" ? config.settings.merchantAccount : "",
  );
  const [bankAccountId, setBankAccountId] = useState(config?.defaultBankAccountId ?? "");
  const [surchargeRuleId, setSurchargeRuleId] = useState(config?.surchargeRuleId ?? "");
  const [disputedFundsAccountId, setDisputedFundsAccountId] = useState(
    config?.defaultDisputedFundsAccountId ?? "",
  );
  const [chargebackLossAccountId, setChargebackLossAccountId] = useState(
    config?.defaultChargebackLossAccountId ?? "",
  );
  const [disputeFeeAccountId, setDisputeFeeAccountId] = useState(
    config?.defaultDisputeFeeAccountId ?? "",
  );
  const tc = useTranslations("common");
  const { busy: testing, execute } = useAppAction();
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/payments/webhooks/${provider.key}`
      : `/api/payments/webhooks/${provider.key}`;

  async function test() {
    setTestResult(null);
    const fallbackMessage = tc("feedback.somethingWentWrong");
    await execute(
      () =>
        fetchAction<{ ok: boolean; detail: string }>("/api/admin/setup/payment-providers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "test", provider: provider.key }),
        }),
      {
        fallbackMessage,
        onOk: setTestResult,
        onRefused: (failure) =>
          setTestResult({ ok: false, detail: failure.displayMessage(fallbackMessage) }),
      },
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900 dark:text-white">{provider.label}</h2>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("enableAcceptance")}
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t("apiKey")}</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={config?.hasSecrets ? t("secretConfigured") : ""}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("webhookSecret")}</Label>
            <Input
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder={config?.hasSecrets ? t("secretConfigured") : ""}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("publishableKey")}</Label>
            <Input value={publishableKey} onChange={(e) => setPublishableKey(e.target.value)} />
          </div>
          {provider.merchantAccount ? (
            <div className="space-y-1.5">
              <Label>{t("merchantAccount")}</Label>
              <Input value={merchantAccount} onChange={(e) => setMerchantAccount(e.target.value)} />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label>{t("receiptBankAccount")}</Label>
            <Select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
              <option value="">—</option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.number ? `${a.number} · ` : ""}
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("surchargeRule")}</Label>
            <Select value={surchargeRuleId} onChange={(e) => setSurchargeRuleId(e.target.value)}>
              <option value="">{t("noSurcharge")}</option>
              {rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </div>
          <AutomationFields
            disputedFundsAccountId={disputedFundsAccountId}
            onDisputedFundsChange={setDisputedFundsAccountId}
            chargebackLossAccountId={chargebackLossAccountId}
            onChargebackLossChange={setChargebackLossAccountId}
            disputeFeeAccountId={disputeFeeAccountId}
            onDisputeFeeChange={setDisputeFeeAccountId}
            postingAccounts={postingAccounts}
            t={t}
          />
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t("webhookUrl")}</Label>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
                {webhookUrl}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(webhookUrl).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? t("copied") : t("copy")}
              </Button>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500">{t("webhookHint")}</p>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={testing || !config?.hasSecrets}
              onClick={() => void test()}
            >
              {testing ? t("testing") : t("testConnection")}
            </Button>
            {testResult ? (
              <span
                className={`text-xs ${testResult.ok ? "text-teal-700 dark:text-teal-400" : "text-red-600 dark:text-red-400"}`}
              >
                {testResult.ok ? `✓ ${testResult.detail}` : `✗ ${testResult.detail}`}
              </span>
            ) : null}
          </div>
          <Button
            disabled={busy}
            onClick={() =>
              void onSave({
                provider: provider.key,
                isEnabled: true,
                acceptanceEnabled: enabled,
                defaultBankAccountId: bankAccountId || null,
                publishableKey: publishableKey || null,
                surchargeRuleId: surchargeRuleId || null,
                defaultDisputedFundsAccountId: disputedFundsAccountId || null,
                defaultChargebackLossAccountId: chargebackLossAccountId || null,
                defaultDisputeFeeAccountId: disputeFeeAccountId || null,
                settings: provider.merchantAccount ? { merchantAccount } : {},
                apiKey: apiKey || null,
                webhookSecret: webhookSecret || null,
              })
            }
          >
            {t("save")}
          </Button>
        </div>
        {provider.key === "stripe" && config?.hasSecrets ? <StripeBillingImport /> : null}
      </CardContent>
    </Card>
  );
}

/**
 * The refunds-and-disputes half of a provider card, shared by hosted-checkout
 * providers and automation-only ones: the three posting
 * accounts the automation journals through. Plain language first — the
 * accounting role follows each label as secondary text.
 */
function AutomationFields({
  disputedFundsAccountId,
  onDisputedFundsChange,
  chargebackLossAccountId,
  onChargebackLossChange,
  disputeFeeAccountId,
  onDisputeFeeChange,
  postingAccounts,
  t,
}: {
  disputedFundsAccountId: string;
  onDisputedFundsChange: (value: string) => void;
  chargebackLossAccountId: string;
  onChargebackLossChange: (value: string) => void;
  disputeFeeAccountId: string;
  onDisputeFeeChange: (value: string) => void;
  postingAccounts: Account[];
  t: ReturnType<typeof useTranslations>;
}) {
  const pickers = [
    {
      label: t("disputedFundsAccount"),
      hint: t("disputedFundsHint"),
      value: disputedFundsAccountId,
      onChange: onDisputedFundsChange,
    },
    {
      label: t("chargebackLossAccount"),
      hint: t("chargebackLossHint"),
      value: chargebackLossAccountId,
      onChange: onChargebackLossChange,
    },
    {
      label: t("disputeFeeAccount"),
      hint: t("disputeFeeHint"),
      value: disputeFeeAccountId,
      onChange: onDisputeFeeChange,
    },
  ] as const;
  return (
    <>
      <div className="border-t border-slate-100 pt-4 sm:col-span-2 dark:border-slate-800">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
          {t("automationTitle")}
        </h3>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t("automationHint")}</p>
      </div>
      {pickers.map((picker) => (
        <div key={picker.label} className="space-y-1.5">
          <Label>{picker.label}</Label>
          <Select value={picker.value} onChange={(e) => picker.onChange(e.target.value)}>
            <option value="">—</option>
            {postingAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.number ? `${a.number} · ` : ""}
                {a.name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-slate-400 dark:text-slate-500">{picker.hint}</p>
        </div>
      ))}
    </>
  );
}

/**
 * PayPal, Shopify Payments and Square never take hosted checkout: no keys, no
 * surcharge rules, no webhook URL. Their card owns the settlement-automation
 * half only — enablement, review policy and dispute posting accounts.
 * Shopify settles through the Channels workspace; this card only prepares
 * what its payouts post into.
 */
function AutomationProviderCard({
  providerKey,
  config,
  postingAccounts,
  onSave,
  busy,
  t,
}: {
  providerKey: AutomationProviderKey;
  config: AutomationConfig | undefined;
  postingAccounts: Account[];
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
  busy: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const [automationEnabled, setAutomationEnabled] = useState(config?.isEnabled ?? false);
  const [disputedFundsAccountId, setDisputedFundsAccountId] = useState(
    config?.defaultDisputedFundsAccountId ?? "",
  );
  const [chargebackLossAccountId, setChargebackLossAccountId] = useState(
    config?.defaultChargebackLossAccountId ?? "",
  );
  const [disputeFeeAccountId, setDisputeFeeAccountId] = useState(
    config?.defaultDisputeFeeAccountId ?? "",
  );
  const name = t(
    providerKey === "paypal"
      ? "paypalName"
      : providerKey === "square"
        ? "squareName"
        : "shopifyName",
  );
  const description = t(
    providerKey === "paypal"
      ? "paypalDescription"
      : providerKey === "square"
        ? "squareDescription"
        : "shopifyDescription",
  );

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900 dark:text-white">{name}</h2>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={automationEnabled}
              onChange={(e) => setAutomationEnabled(e.target.checked)}
            />
            {t("enableAutomation")}
          </label>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">{description}</p>
        {providerKey === "shopify_payments" ? (
          <p className="text-xs text-slate-400 dark:text-slate-500">{t("shopifyChannelsNote")}</p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <AutomationFields
            disputedFundsAccountId={disputedFundsAccountId}
            onDisputedFundsChange={setDisputedFundsAccountId}
            chargebackLossAccountId={chargebackLossAccountId}
            onChargebackLossChange={setChargebackLossAccountId}
            disputeFeeAccountId={disputeFeeAccountId}
            onDisputeFeeChange={setDisputeFeeAccountId}
            postingAccounts={postingAccounts}
            t={t}
          />
        </div>
        <div className="flex justify-end">
          <Button
            disabled={busy}
            onClick={() =>
              void onSave({
                action: "saveConfig",
                provider: providerKey,
                isEnabled: automationEnabled,
                defaultDisputedFundsAccountId: disputedFundsAccountId || null,
                defaultChargebackLossAccountId: chargebackLossAccountId || null,
                defaultDisputeFeeAccountId: disputeFeeAccountId || null,
              })
            }
          >
            {t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SurchargeRules({
  rules,
  incomeAccounts,
  onSave,
  busy,
  t,
  open,
  closeHref,
  onClose,
}: {
  rules: Rule[];
  incomeAccounts: Account[];
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
  busy: boolean;
  t: ReturnType<typeof useTranslations>;
  open: boolean;
  closeHref: string;
  onClose: () => void;
}) {
  const tc = useTranslations("common");
  const [name, setName] = useState("");
  const [calculation, setCalculation] = useState("percent");
  const [percent, setPercent] = useState("");
  const [fixedAmount, setFixedAmount] = useState("");
  const [capAmount, setCapAmount] = useState("");
  const [feeIncomeAccountId, setFeeIncomeAccountId] = useState("");
  const [provider, setProvider] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("all");
  const [effectiveFrom, setEffectiveFrom] = useState(useBusinessToday());

  async function add() {
    const ok = await onSave({
      action: "saveRule",
      name,
      calculation,
      percent: percent || null,
      fixedAmount: fixedAmount || null,
      capAmount: capAmount || null,
      feeIncomeAccountId,
      provider: provider || null,
      paymentMethod,
      effectiveFrom,
    });
    if (ok) {
      setName("");
      setPercent("");
      setFixedAmount("");
      setCapAmount("");
      onClose();
    }
  }

  return (
    <>
      <Card>
        <CardContent className="space-y-4 p-5">
          <div>
            <h2 className="font-semibold text-slate-900 dark:text-white">{t("surchargeRules")}</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {t("surchargeHint")}
            </p>
          </div>
          <SharedTable className="w-full text-sm">
            <SharedTableHeader>
              <SharedTableRow className="text-left text-xs text-slate-500">
                <SharedTableHead className="py-1">{t("ruleName")}</SharedTableHead>
                <SharedTableHead>{t("ruleCalc")}</SharedTableHead>
                <SharedTableHead>{t("ruleProvider")}</SharedTableHead>
                <SharedTableHead>{t("ruleEffective")}</SharedTableHead>
                <SharedTableHead />
              </SharedTableRow>
            </SharedTableHeader>
            <SharedTableBody>
              {rules.map((r) => (
                <SharedTableRow
                  key={r.id}
                  className="border-t border-slate-100 dark:border-slate-800"
                >
                  <SharedTableCell className="py-1.5">{r.name}</SharedTableCell>
                  <SharedTableCell className="tabular-nums">
                    {r.calculation === "percent"
                      ? `${r.percent}%`
                      : r.calculation === "fixed"
                        ? r.fixedAmount
                        : `${r.percent}% + ${r.fixedAmount}`}
                    {r.capAmount ? ` (≤ ${r.capAmount})` : ""}
                  </SharedTableCell>
                  <SharedTableCell>{r.provider ?? t("allProviders")}</SharedTableCell>
                  <SharedTableCell className="tabular-nums">
                    {r.effectiveFrom}
                    {r.effectiveTo ? ` → ${r.effectiveTo}` : ""}
                  </SharedTableCell>
                  <SharedTableCell className="text-right">
                    {r.isActive ? (
                      <button
                        type="button"
                        className="text-xs text-red-600 hover:underline"
                        disabled={busy}
                        onClick={() => void onSave({ action: "deleteRule", id: r.id })}
                      >
                        {t("deactivate")}
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">{t("inactive")}</span>
                    )}
                  </SharedTableCell>
                </SharedTableRow>
              ))}
            </SharedTableBody>
          </SharedTable>
        </CardContent>
      </Card>
      <UrlDrawer
        open={open}
        closeHref={closeHref}
        title={t("addRule")}
        size="lg"
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button asChild variant="outline">
              <Link href={closeHref}>{tc("actions.cancel")}</Link>
            </Button>
            <Button
              onClick={() => void add()}
              disabled={busy || !name.trim() || !feeIncomeAccountId}
            >
              {t("addRule")}
            </Button>
          </div>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t("ruleName")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("ruleCalc")}</Label>
            <Select value={calculation} onChange={(e) => setCalculation(e.target.value)}>
              <option value="percent">{t("calcPercent")}</option>
              <option value="fixed">{t("calcFixed")}</option>
              <option value="percent_plus_fixed">{t("calcBoth")}</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("feeIncomeAccount")}</Label>
            <Select
              value={feeIncomeAccountId}
              onChange={(e) => setFeeIncomeAccountId(e.target.value)}
            >
              <option value="">—</option>
              {incomeAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.number ? `${a.number} · ` : ""}
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          {calculation !== "fixed" ? (
            <div className="space-y-1.5">
              <Label>{t("percent")}</Label>
              <MoneyInput
                value={percent}
                onChange={setPercent}
                field={t("percent")}
                noun="a percentage"
                placeholder="2.9"
                required
              />
            </div>
          ) : null}
          {calculation !== "percent" ? (
            <div className="space-y-1.5">
              <Label>{t("fixed")}</Label>
              <MoneyInput
                value={fixedAmount}
                onChange={setFixedAmount}
                field={t("fixed")}
                placeholder="0.30"
                required
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label>{t("cap")}</Label>
            <MoneyInput
              value={capAmount}
              onChange={setCapAmount}
              field={t("cap")}
              placeholder="—"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("ruleProvider")}</Label>
            <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="">{t("allProviders")}</option>
              <option value="stripe">Stripe</option>
              <option value="adyen">Adyen</option>
              <option value="gocardless">GoCardless</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("paymentMethod")}</Label>
            <Select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
              <option value="all">{t("methodAll")}</option>
              <option value="card">{t("methodCard")}</option>
              <option value="bank_debit">{t("methodBankDebit")}</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("effectiveFrom")}</Label>
            <DateField value={effectiveFrom} onChange={(value) => setEffectiveFrom(value)} />
          </div>
        </div>
      </UrlDrawer>
    </>
  );
}
