"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Play, Plus, RefreshCw } from "lucide-react";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { PagedTable, type PagedColumn } from "../../../../components/paged-table";
import { ListPageLayout } from "../../../../components/page-layout";
import {
  Badge,
  Button,
  DisclosureSection,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Select,
  UrlDrawer,
} from "@openbooks/ui";
import { DateField } from "../../../../components/date-field";
import {
  billingAcceptConfig,
  canRerunBillingImport,
  suggestedBillingMappings,
} from "@/lib/billing-history-mapping";
import {
  formatObjectCounts,
  shouldOpenImportWizard,
  BILLING_IMPORT_COUNT_KEYS,
  type BillingImportCounts,
} from "./presentation";

// --- shapes (mirror the API responses) -----------------------------------------

type Counts = BillingImportCounts;

interface AttentionItem {
  kind: "plan" | "currency" | "tax_code" | "customer";
  externalRef: string;
  label: string;
  suggestion: { nativeId: string | null; label: string } | null;
  remedy: string;
}

interface Difference {
  kind: "mrr" | "open_ar" | "deferred_revenue";
  ref: string;
  sourceMajor: string;
  openbooksMajor: string;
  explanation: string;
}

interface ImportRun {
  id: string;
  provider: string;
  externalAccount: string;
  mode: string;
  status: string;
  counts: Counts | null;
  lastError: string | null;
  updatedAt: string;
}

interface Preflight {
  counts: Counts;
  attention: AttentionItem[];
  ready: boolean;
}

interface MappingOptions {
  plans: { value: string; label: string }[];
  customers: { value: string; label: string }[];
  incomeAccounts: { value: string; label: string }[];
  clearingAccounts: { value: string; label: string }[];
  taxCodes: { value: string; label: string }[];
}

type Step = "connect" | "preflight" | "result";

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "outline" | "destructive" | "warning" | "success"
> = {
  complete: "success",
  running: "default",
  ready: "secondary",
  preflight: "secondary",
  draft: "secondary",
  reconciling: "warning",
  failed: "destructive",
};

const PROVIDERS = ["chargebee", "recurly", "maxio", "zuora"] as const;
const ATTENTION_KINDS = ["plan", "currency", "tax_code", "customer"] as const;
const DIFFERENCE_KINDS = ["mrr", "open_ar", "deferred_revenue"] as const;
const STATUSES = [
  "draft",
  "preflight",
  "ready",
  "running",
  "reconciling",
  "complete",
  "failed",
] as const;
type EnumTranslationKey =
  | `providers.${(typeof PROVIDERS)[number]}`
  | `statuses.${(typeof STATUSES)[number]}`
  | `attentionKinds.${(typeof ATTENTION_KINDS)[number]}`
  | `differenceKinds.${(typeof DIFFERENCE_KINDS)[number]}`;

async function postJson(url: string, body: unknown, fallback: string): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback));
  return res.json();
}

export function BillingHistoryClient() {
  const t = useTranslations("billingImport");
  const router = useRouter();
  const searchParams = useSearchParams();
  const drawerOpen = shouldOpenImportWizard(searchParams);
  const translatedEnum = (
    group: "providers" | "statuses" | "attentionKinds" | "differenceKinds",
    value: string,
    supported: readonly string[],
  ) =>
    supported.includes(value) ? t(`${group}.${value}` as EnumTranslationKey) : t("unknownValue");
  const [runs, setRuns] = useState<ImportRun[]>([]);
  const [loading, setLoading] = useState(true);
  const tCommon = useTranslations("common");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("connect");
  const [provider, setProvider] = useState("chargebee");
  const [externalAccount, setExternalAccount] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [site, setSite] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [mode, setMode] = useState<"post_historical" | "opening_balances">("post_historical");
  const [cutoverOn, setCutoverOn] = useState("");
  const [planMap, setPlanMap] = useState<Record<string, string>>({});
  const [customerMap, setCustomerMap] = useState<Record<string, string>>({});
  const [incomeAccountId, setIncomeAccountId] = useState("");
  const [clearingAccountId, setClearingAccountId] = useState("");
  const [taxCodeId, setTaxCodeId] = useState("");
  const [historyDepthMonths, setHistoryDepthMonths] = useState("");
  const [autoSync, setAutoSync] = useState(false);
  const [mappingOptions, setMappingOptions] = useState<MappingOptions | null>(null);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    counts: Counts;
    reconciliation: { ties: boolean; differences: Difference[] };
  } | null>(null);

  // Promise chains, not await-then-set: the exemplar console keeps setState
  // out of the synchronous effect path so one fetch cannot cascade renders.
  const refresh = useCallback(() => {
    return fetch("/api/billing-import/runs")
      .then(async (res) => {
        // The status is checked before the body is parsed: a refusal lands
        // in the toast, never in a JSON parse error.
        if (!res.ok) throw new Error(await readApiErrorMessage(res, t("loadFailed")));
        setRuns((await res.json()) as ImportRun[]);
        setLoadError(null);
        setLoading(false);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error && error.message ? error.message : t("loadFailed");
        setLoadError(message);
        toast.error(message);
        setLoading(false);
      });
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetWizard = useCallback(() => {
    setStep("connect");
    setRunId(null);
    setPreflight(null);
    setResult(null);
    setPlanMap({});
    setCustomerMap({});
    setIncomeAccountId("");
    setClearingAccountId("");
    setTaxCodeId("");
    setHistoryDepthMonths("");
    setAutoSync(false);
    setMappingOptions(null);
  }, []);

  const openWizardHref = "/sync/billing-history?import=new";
  const openWizard = useCallback(() => {
    resetWizard();
    router.push(openWizardHref);
  }, [resetWizard, router]);

  async function loadMappingOptions() {
    setMappingLoading(true);
    try {
      const res = await fetch("/api/billing-import/options");
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("loadFailed")));
      setMappingOptions((await res.json()) as MappingOptions);
    } catch (error) {
      setMappingOptions(null);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setMappingLoading(false);
    }
  }

  async function startPreflight() {
    setBusy(true);
    try {
      const started = (await postJson(
        "/api/billing-import/start",
        {
          provider,
          externalAccount,
          apiKey,
          site: site || undefined,
        },
        t("requestFailed"),
      )) as { runId: string; preflight: Preflight };
      setRunId(started.runId);
      setPreflight(started.preflight);
      const seeded = suggestedBillingMappings(started.preflight.attention);
      setPlanMap(seeded.planMap);
      setCustomerMap(seeded.customerMap);
      setStep("preflight");
      await loadMappingOptions();
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function acceptAndRun() {
    if (!runId) return;
    setBusy(true);
    try {
      await postJson(
        "/api/billing-import/accept",
        {
          runId,
          config: billingAcceptConfig({
            mode,
            cutoverOn,
            historyDepthMonths,
            incomeAccountId,
            clearingAccountId,
            taxCodeId,
            planMap,
            customerMap,
            autoSync,
          }),
        },
        t("requestFailed"),
      );
      const done = (await postJson(
        "/api/billing-import/import",
        { runId },
        t("requestFailed"),
      )) as {
        counts: Counts;
        reconciliation: { ties: boolean; differences: Difference[] };
      };
      setResult(done);
      setStep("result");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function rerun(id: string) {
    setBusy(true);
    try {
      await postJson("/api/billing-import/import", { runId: id }, t("requestFailed"));
      toast.success(t("rerunStarted"));
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const columns: PagedColumn<ImportRun>[] = [
    {
      key: "provider",
      header: t("provider"),
      cell: (row) => translatedEnum("providers", row.provider, PROVIDERS),
      search: (row) =>
        `${translatedEnum("providers", row.provider, PROVIDERS)} ${row.externalAccount}`,
    },
    {
      key: "account",
      header: t("account"),
      cell: (row) => row.externalAccount,
      search: (row) => row.externalAccount,
    },
    {
      key: "mode",
      header: t("mode"),
      cell: (row) =>
        t(row.mode === "opening_balances" ? "modeOpeningBalances" : "modePostHistorical"),
      search: (row) =>
        t(row.mode === "opening_balances" ? "modeOpeningBalances" : "modePostHistorical"),
    },
    {
      key: "status",
      header: t("status"),
      cell: (row) => (
        <Badge variant={STATUS_VARIANT[row.status] ?? "outline"}>
          {translatedEnum("statuses", row.status, STATUSES)}
        </Badge>
      ),
      search: (row) => translatedEnum("statuses", row.status, STATUSES),
    },
    {
      key: "counts",
      header: t("objects"),
      cell: (row) => formatObjectCounts(row.counts, (key) => t(key)),
      search: (row) => formatObjectCounts(row.counts, (key) => t(key)),
    },
    {
      key: "actions",
      header: "",
      align: "right" as const,
      cell: (row) => (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !canRerunBillingImport(row.status)}
          onClick={() => void rerun(row.id)}
        >
          <Play className="mr-1 h-3 w-3" />
          {t("rerun")}
        </Button>
      ),
    },
  ];

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t("title")}
          description={t("subtitle")}
          back={{ href: "/sync", label: t("backToSync") }}
          actions={
            <Button onClick={openWizard}>
              <Plus className="mr-1 h-4 w-4" />
              {t("newImport")}
            </Button>
          }
        />
      }
    >
      {loading ? (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : loadError ? (
        <div
          className="rounded-lg border border-red-300 p-6 text-center dark:border-red-900"
          role="alert"
        >
          <p className="text-sm text-red-700 dark:text-red-300">{loadError}</p>
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => {
              setLoading(true);
              setLoadError(null);
              void refresh();
            }}
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            {tCommon("actions.retry")}
          </Button>
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          title={t("emptyTitle")}
          description={t("emptyBody")}
          action={
            <Button onClick={openWizard}>
              <Plus className="mr-1 h-4 w-4" />
              {t("newImport")}
            </Button>
          }
        />
      ) : (
        <PagedTable
          source="billing_import_runs"
          rows={runs}
          columns={columns}
          rowKey={(row) => row.id}
          searchable
          empty={<EmptyState title={t("emptyTitle")} description={t("emptyBody")} />}
        />
      )}

      <UrlDrawer
        open={drawerOpen}
        openKey="new"
        closeHref="/sync/billing-history"
        title={t("wizardTitle")}
      >
        {step === "connect" && (
          <div className="space-y-4">
            <div>
              <Label>{t("provider")}</Label>
              <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {["chargebee", "recurly", "maxio", "zuora"].map((p) => (
                  <option key={p} value={p}>
                    {translatedEnum("providers", p, PROVIDERS)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>{t("account")}</Label>
              <Input
                value={externalAccount}
                onChange={(e) => setExternalAccount(e.target.value)}
                placeholder={t("accountPlaceholder")}
              />
            </div>
            <div>
              <Label>{t("apiKey")}</Label>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </div>
            <div>
              <Label>{t("siteOptional")}</Label>
              <Input value={site} onChange={(e) => setSite(e.target.value)} />
            </div>
            <Button
              disabled={busy || !externalAccount || !apiKey}
              onClick={() => void startPreflight()}
            >
              <RefreshCw className="mr-1 h-4 w-4" />
              {t("runPreflight")}
            </Button>
          </div>
        )}

        {step === "preflight" && preflight && (
          <div className="space-y-4">
            <div>
              <h3 className="font-medium">{t("countsTitle")}</h3>
              <ul className="mt-1 text-sm">
                {BILLING_IMPORT_COUNT_KEYS.map((k) => (
                  <li key={k}>
                    {t(`count_${k}`)}: {preflight.counts[k]}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-medium">{t("attentionTitle")}</h3>
              {preflight.attention.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("attentionEmpty")}</p>
              ) : (
                <ul className="mt-1 space-y-2">
                  {preflight.attention.map((item) => (
                    <li
                      key={`${item.kind}:${item.externalRef}`}
                      className="rounded border p-2 text-sm"
                    >
                      <Badge variant="warning">
                        {translatedEnum("attentionKinds", item.kind, ATTENTION_KINDS)}
                      </Badge>
                      <p className="mt-1">{item.label}</p>
                      {item.suggestion && (
                        <p className="text-muted-foreground">{item.suggestion.label}</p>
                      )}
                      <p className="text-muted-foreground">{item.remedy}</p>
                      {mappingOptions && item.kind === "plan" ? (
                        <div className="mt-2">
                          <Label>{t("count_plans")}</Label>
                          <Select
                            value={planMap[item.externalRef] ?? ""}
                            onChange={(event) =>
                              setPlanMap((current) => {
                                const next = { ...current };
                                if (event.target.value) next[item.externalRef] = event.target.value;
                                else delete next[item.externalRef];
                                return next;
                              })
                            }
                          >
                            <option value="">{t("automaticMapping")}</option>
                            {mappingOptions.plans.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </div>
                      ) : null}
                      {mappingOptions && item.kind === "customer" ? (
                        <div className="mt-2">
                          <Label>{t("count_customers")}</Label>
                          <Select
                            value={customerMap[item.externalRef] ?? ""}
                            onChange={(event) =>
                              setCustomerMap((current) => {
                                const next = { ...current };
                                if (event.target.value) next[item.externalRef] = event.target.value;
                                else delete next[item.externalRef];
                                return next;
                              })
                            }
                          >
                            <option value="">{t("automaticMapping")}</option>
                            {mappingOptions.customers.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {mappingLoading ? (
              <p className="text-sm text-muted-foreground">{t("loadingMappings")}</p>
            ) : null}
            {!mappingLoading && mappingOptions === null ? (
              <div className="space-y-2 rounded border border-amber-300 p-3 text-sm">
                <p>{t("mappingOptionsUnavailable")}</p>
                <Button size="sm" variant="outline" onClick={() => void loadMappingOptions()}>
                  {t("retryMappings")}
                </Button>
              </div>
            ) : null}
            <DisclosureSection title={t("advancedTitle")} summary={t("advancedSummary")}>
              <div className="space-y-4 pt-2">
                <div>
                  <Label>{t("mode")}</Label>
                  <Select
                    value={mode}
                    onChange={(e) =>
                      setMode(e.target.value as "post_historical" | "opening_balances")
                    }
                  >
                    <option value="post_historical">{t("modePostHistorical")}</option>
                    <option value="opening_balances">{t("modeOpeningBalances")}</option>
                  </Select>
                </div>
                <div>
                  <Label>{t("cutover")}</Label>
                  <DateField value={cutoverOn} onChange={(value) => setCutoverOn(value)} />
                </div>
                {mappingOptions ? (
                  <>
                    <div>
                      <Label>{t("incomeAccount")}</Label>
                      <Select
                        value={incomeAccountId}
                        onChange={(event) => setIncomeAccountId(event.target.value)}
                      >
                        <option value="">{t("noMapping")}</option>
                        {mappingOptions.incomeAccounts.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label>{t("clearingAccount")}</Label>
                      <Select
                        value={clearingAccountId}
                        onChange={(event) => setClearingAccountId(event.target.value)}
                      >
                        <option value="">{t("noMapping")}</option>
                        {mappingOptions.clearingAccounts.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label>{t("taxCode")}</Label>
                      <Select
                        value={taxCodeId}
                        onChange={(event) => setTaxCodeId(event.target.value)}
                      >
                        <option value="">{t("noMapping")}</option>
                        {mappingOptions.taxCodes.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </>
                ) : null}
                <div>
                  <Label>{t("historyDepth")}</Label>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={historyDepthMonths}
                    onChange={(event) => setHistoryDepthMonths(event.target.value)}
                  />
                </div>
                <div>
                  <Label>{t("autoSync")}</Label>
                  <Select
                    value={autoSync ? "true" : "false"}
                    onChange={(event) => setAutoSync(event.target.value === "true")}
                  >
                    <option value="false">{t("autoSyncOff")}</option>
                    <option value="true">{t("autoSyncOn")}</option>
                  </Select>
                </div>
              </div>
            </DisclosureSection>
            <Button
              disabled={
                busy ||
                mappingOptions === null ||
                mappingLoading ||
                (historyDepthMonths !== "" &&
                  (!/^\d+$/.test(historyDepthMonths) ||
                    !Number.isSafeInteger(Number(historyDepthMonths)) ||
                    Number(historyDepthMonths) <= 0))
              }
              onClick={() => void acceptAndRun()}
            >
              <Play className="mr-1 h-4 w-4" />
              {t("acceptAndImport")}
            </Button>
          </div>
        )}

        {step === "result" && result && (
          <div className="space-y-4">
            <Badge variant={result.reconciliation.ties ? "success" : "warning"}>
              {result.reconciliation.ties ? t("tiesYes") : t("tiesNo")}
            </Badge>
            {result.reconciliation.differences.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("differencesEmpty")}</p>
            ) : (
              <ul className="space-y-2">
                {result.reconciliation.differences.map((d, i) => (
                  <li key={i} className="rounded border p-2 text-sm">
                    <Badge variant="outline">
                      {translatedEnum("differenceKinds", d.kind, DIFFERENCE_KINDS)}
                    </Badge>
                    <p className="mt-1 font-medium">{d.ref}</p>
                    <p>
                      {t("sourceValue")}: {d.sourceMajor} · {t("openbooksValue")}:{" "}
                      {d.openbooksMajor}
                    </p>
                    <p className="text-muted-foreground">{d.explanation}</p>
                  </li>
                ))}
              </ul>
            )}
            <Button asChild variant="outline">
              <Link href="/sync/billing-history">{t("close")}</Link>
            </Button>
          </div>
        )}
      </UrlDrawer>
    </ListPageLayout>
  );
}
