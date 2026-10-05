"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Play, Plus, RefreshCw } from "lucide-react";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { ListTable, type ListTableColumn } from "../../../../components/list-table";
import { ListPageLayout } from "../../../../components/page-layout";
import {
  Badge,
  Button,
  DisclosureSection,
  Drawer,
  Input,
  Label,
  PageHeader,
  Select,
} from "@openbooks/ui";

// --- shapes (mirror the API responses) -----------------------------------------

interface Counts {
  customers: number;
  plans: number;
  subscriptions: number;
  invoices: number;
  creditNotes: number;
  payments: number;
  usage: number;
  coupons: number;
  revenueSchedules: number;
}

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

type Step = "connect" | "preflight" | "result";

const COUNT_KEYS: (keyof Counts)[] = [
  "customers",
  "plans",
  "subscriptions",
  "invoices",
  "creditNotes",
  "payments",
  "usage",
  "coupons",
  "revenueSchedules",
];

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive" | "warning" | "success"> = {
  completed: "success",
  running: "default",
  ready: "secondary",
  preflight: "secondary",
  failed: "destructive",
};

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
  const [runs, setRuns] = useState<ImportRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [step, setStep] = useState<Step>("connect");
  const [provider, setProvider] = useState("chargebee");
  const [externalAccount, setExternalAccount] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [site, setSite] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [mode, setMode] = useState("post_historical");
  const [cutoverOn, setCutoverOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ counts: Counts; reconciliation: { ties: boolean; differences: Difference[] } } | null>(null);

  // Promise chains, not await-then-set: the exemplar console keeps setState
  // out of the synchronous effect path so one fetch cannot cascade renders.
  const refresh = useCallback(() => {
    fetch("/api/billing-import/runs")
      .then(async (res) => {
        // The status is checked before the body is parsed: a refusal lands
        // in the toast, never in a JSON parse error.
        if (!res.ok) throw new Error(await readApiErrorMessage(res, t("loadFailed")));
        setRuns((await res.json()) as ImportRun[]);
        setLoading(false);
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
        setLoading(false);
      });
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function openWizard() {
    setStep("connect");
    setRunId(null);
    setPreflight(null);
    setResult(null);
    setDrawerOpen(true);
  }

  async function startPreflight() {
    setBusy(true);
    try {
      const started = (await postJson("/api/billing-import/start", {
        provider,
        externalAccount,
        apiKey,
        site: site || undefined,
      }, t("requestFailed"))) as { runId: string; preflight: Preflight };
      setRunId(started.runId);
      setPreflight(started.preflight);
      setStep("preflight");
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
      await postJson("/api/billing-import/accept", {
        runId,
        config: { mode, cutoverOn: cutoverOn || null },
      }, t("requestFailed"));
      const done = (await postJson("/api/billing-import/import", { runId }, t("requestFailed"))) as {
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

  const columns: ListTableColumn<ImportRun>[] = [
    { key: "provider", header: t("provider"), cell: (row) => row.provider },
    { key: "account", header: t("account"), cell: (row) => row.externalAccount },
    { key: "mode", header: t("mode"), cell: (row) => row.mode },
    {
      key: "status",
      header: t("status"),
      cell: (row) => <Badge variant={STATUS_VARIANT[row.status] ?? "outline"}>{row.status}</Badge>,
    },
    {
      key: "counts",
      header: t("objects"),
      cell: (row) => (row.counts ? COUNT_KEYS.map((k) => `${row.counts?.[k] ?? 0} ${k}`).join(" · ") : "—"),
    },
    {
      key: "actions",
      header: "",
      align: "right" as const,
      cell: (row) => (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || row.status === "running"}
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
      ) : runs.length === 0 ? (
        <div className="rounded-lg border p-8 text-center">
          <p className="font-medium">{t("emptyTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("emptyBody")}</p>
          <Button className="mt-4" onClick={openWizard}>
            <Plus className="mr-1 h-4 w-4" />
            {t("newImport")}
          </Button>
        </div>
      ) : (
        <ListTable rows={runs} columns={columns} rowKey={(row) => row.id} empty={<p className="text-sm text-muted-foreground">{t("emptyBody")}</p>} />
      )}

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title={t("wizardTitle")}>
        {step === "connect" && (
          <div className="space-y-4">
            <div>
              <Label>{t("provider")}</Label>
              <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {["chargebee", "recurly", "maxio", "zuora"].map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>{t("account")}</Label>
              <Input value={externalAccount} onChange={(e) => setExternalAccount(e.target.value)} placeholder={t("accountPlaceholder")} />
            </div>
            <div>
              <Label>{t("apiKey")}</Label>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </div>
            <div>
              <Label>{t("siteOptional")}</Label>
              <Input value={site} onChange={(e) => setSite(e.target.value)} />
            </div>
            <Button disabled={busy || !externalAccount || !apiKey} onClick={() => void startPreflight()}>
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
                {COUNT_KEYS.map((k) => (
                  <li key={k}>{t(`count_${k}`)}: {preflight.counts[k]}</li>
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
                    <li key={`${item.kind}:${item.externalRef}`} className="rounded border p-2 text-sm">
                      <Badge variant="warning">{item.kind}</Badge>
                      <p className="mt-1">{item.label}</p>
                      {item.suggestion && <p className="text-muted-foreground">{item.suggestion.label}</p>}
                      <p className="text-muted-foreground">{item.remedy}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <DisclosureSection title={t("advancedTitle")} summary={t("advancedSummary")}>
              <div className="space-y-4 pt-2">
                <div>
                  <Label>{t("mode")}</Label>
                  <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                    <option value="post_historical">{t("modePostHistorical")}</option>
                    <option value="opening_balances">{t("modeOpeningBalances")}</option>
                  </Select>
                </div>
                <div>
                  <Label>{t("cutover")}</Label>
                  <Input type="date" value={cutoverOn} onChange={(e) => setCutoverOn(e.target.value)} />
                </div>
              </div>
            </DisclosureSection>
            <Button disabled={busy} onClick={() => void acceptAndRun()}>
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
                    <Badge variant="outline">{d.kind}</Badge>
                    <p className="mt-1 font-medium">{d.ref}</p>
                    <p>{t("sourceValue")}: {d.sourceMajor} · {t("openbooksValue")}: {d.openbooksMajor}</p>
                    <p className="text-muted-foreground">{d.explanation}</p>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="outline" onClick={() => setDrawerOpen(false)}>{t("close")}</Button>
          </div>
        )}
      </Drawer>
    </ListPageLayout>
  );
}
