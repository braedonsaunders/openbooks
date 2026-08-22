"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Card, CardContent, Input, Label, Select } from "@openbooks/ui";
import { useBusinessToday } from "../../../../../components/business-date-provider";

type ProviderKey = "stripe" | "adyen" | "gocardless";

type Config = {
  provider: ProviderKey;
  displayName: string;
  isEnabled: boolean;
  acceptanceEnabled: boolean;
  defaultBankAccountId: string | null;
  publishableKey: string | null;
  surchargeRuleId: string | null;
  settings: Record<string, unknown>;
  hasSecrets: boolean;
  lastError: string | null;
};

type Account = { id: string; number: string | null; name: string };

type Rule = {
  id: string;
  name: string;
  calculation: string;
  percent: string | null;
  fixedAmount: string | null;
  capAmount: string | null;
  feeIncomeAccountId: string;
  provider: ProviderKey | null;
  paymentMethod: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
};

type Data = {
  configs: Config[];
  bankAccounts: Account[];
  incomeAccounts: Account[];
  surchargeRules: Rule[];
};

const PROVIDERS: { key: ProviderKey; label: string; merchantAccount?: boolean }[] = [
  { key: "stripe", label: "Stripe" },
  { key: "adyen", label: "Adyen", merchantAccount: true },
  { key: "gocardless", label: "GoCardless (bank debit)" },
];

export function PaymentProvidersClient() {
  const t = useTranslations("admin.setup.paymentProviders");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/setup/payment-providers");
    if (res.ok) setData((await res.json()) as Data);
    else setError((await res.json().catch(() => ({})))?.error ?? res.statusText);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setError(null);
    setNotice(null);
    const res = await fetch("/api/admin/setup/payment-providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(json.error ?? res.statusText);
      return false;
    }
    setNotice(t("saved"));
    await load();
    return true;
  }

  if (!data) return <p className="text-sm text-slate-500">{error ?? "…"}</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900 dark:text-white">{t("title")}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t("description")}</p>
      </div>
      {error ? <p className="text-sm text-red-600" role="alert">{error}</p> : null}
      {notice ? <p className="text-sm text-teal-700 dark:text-teal-400">{notice}</p> : null}

      {PROVIDERS.map((p) => (
        <ProviderCard
          key={p.key}
          provider={p}
          config={data.configs.find((c) => c.provider === p.key)}
          bankAccounts={data.bankAccounts}
          rules={data.surchargeRules.filter((r) => r.isActive)}
          onSave={post}
          t={t}
        />
      ))}

      <SurchargeRules
        rules={data.surchargeRules}
        incomeAccounts={data.incomeAccounts}
        onSave={post}
        t={t}
      />
    </div>
  );
}

function ProviderCard({
  provider,
  config,
  bankAccounts,
  rules,
  onSave,
  t,
}: {
  provider: { key: ProviderKey; label: string; merchantAccount?: boolean };
  config: Config | undefined;
  bankAccounts: Account[];
  rules: Rule[];
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
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
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const webhookUrl = typeof window !== "undefined" ? `${window.location.origin}/api/payments/webhooks/${provider.key}` : `/api/payments/webhooks/${provider.key}`;

  async function test() {
    setTesting(true);
    setTestResult(null);
    const res = await fetch("/api/admin/setup/payment-providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "test", provider: provider.key }),
    });
    setTestResult((await res.json().catch(() => ({ ok: false, detail: res.statusText }))) as { ok: boolean; detail: string });
    setTesting(false);
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900 dark:text-white">{provider.label}</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
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
            <Button variant="outline" size="sm" disabled={testing || !config?.hasSecrets} onClick={() => void test()}>
              {testing ? t("testing") : t("testConnection")}
            </Button>
            {testResult ? (
              <span className={`text-xs ${testResult.ok ? "text-teal-700 dark:text-teal-400" : "text-red-600 dark:text-red-400"}`}>
                {testResult.ok ? `✓ ${testResult.detail}` : `✗ ${testResult.detail}`}
              </span>
            ) : null}
          </div>
          <Button
            onClick={() =>
              void onSave({
                provider: provider.key,
                isEnabled: true,
                acceptanceEnabled: enabled,
                defaultBankAccountId: bankAccountId || null,
                publishableKey: publishableKey || null,
                surchargeRuleId: surchargeRuleId || null,
                settings: provider.merchantAccount ? { merchantAccount } : {},
                apiKey: apiKey || null,
                webhookSecret: webhookSecret || null,
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
  t,
}: {
  rules: Rule[];
  incomeAccounts: Account[];
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
  t: ReturnType<typeof useTranslations>;
}) {
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
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div>
          <h2 className="font-semibold text-slate-900 dark:text-white">{t("surchargeRules")}</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t("surchargeHint")}</p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="py-1">{t("ruleName")}</th>
              <th>{t("ruleCalc")}</th>
              <th>{t("ruleProvider")}</th>
              <th>{t("ruleEffective")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1.5">{r.name}</td>
                <td className="tabular-nums">
                  {r.calculation === "percent"
                    ? `${r.percent}%`
                    : r.calculation === "fixed"
                      ? r.fixedAmount
                      : `${r.percent}% + ${r.fixedAmount}`}
                  {r.capAmount ? ` (≤ ${r.capAmount})` : ""}
                </td>
                <td>{r.provider ?? t("allProviders")}</td>
                <td className="tabular-nums">{r.effectiveFrom}{r.effectiveTo ? ` → ${r.effectiveTo}` : ""}</td>
                <td className="text-right">
                  {r.isActive ? (
                    <button
                      type="button"
                      className="text-xs text-red-600 hover:underline"
                      onClick={() => void onSave({ action: "deleteRule", id: r.id })}
                    >
                      {t("deactivate")}
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">{t("inactive")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-3 dark:border-slate-800">
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
            <Select value={feeIncomeAccountId} onChange={(e) => setFeeIncomeAccountId(e.target.value)}>
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
              <Input value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="2.9" />
            </div>
          ) : null}
          {calculation !== "percent" ? (
            <div className="space-y-1.5">
              <Label>{t("fixed")}</Label>
              <Input value={fixedAmount} onChange={(e) => setFixedAmount(e.target.value)} placeholder="0.30" />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label>{t("cap")}</Label>
            <Input value={capAmount} onChange={(e) => setCapAmount(e.target.value)} placeholder="—" />
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
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => void add()} disabled={!name || !feeIncomeAccountId}>
            {t("addRule")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
