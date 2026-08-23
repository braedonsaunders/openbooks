"use client";

import { useMoney } from '@/components/money-provider'
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Card, Input, Label, Select } from "@openbooks/ui";
import { AdvancedSubscriptionsPanel } from "./AdvancedSubscriptionsPanel";

interface Schedule {
  id: string;
  name: string;
  cadence: string;
  cron: string | null;
  nextRunOn: string;
  endsOn: string | null;
  autoPost: boolean;
  isActive: boolean;
  runCount: number;
  lastError: string | null;
  templateNumber: string;
  templateKind: string;
  partyName: string | null;
}

interface Stage {
  sequence: number;
  name: string;
  offsetDays: number;
  subjectTemplate: string;
  bodyTemplate: string;
  escalate?: boolean;
}
interface Policy {
  id: string;
  name: string;
  appliesToKind: string;
  gracePeriodDays: number;
  minBalance: string;
  isActive: boolean;
  stages: Stage[];
}

const CADENCES = ["weekly", "biweekly", "monthly", "quarterly", "annually", "custom_cron"];
const INTERVALS = ["weekly", "monthly", "quarterly", "annually"];
type Opt = { id: string; name?: string; label?: string };

interface Plan {
  id: string; name: string; description: string | null; amount: string; currency: string | null;
  interval: string; intervalCount: number; incomeAccountId: string | null; isActive: boolean;
}
interface Subscription {
  id: string; customerId: string; customerName: string | null; planId: string; planName: string;
  quantity: string; priceOverride: string | null; status: string; startOn: string; nextBillOn: string;
  autoPost: boolean; runCount: number; lastError: string | null; mrr: string; planCurrency: string | null;
  advancedLifecycle?: boolean;
}

export function CollectionsClient({
  subscriptionsEnabled = false,
  advancedSubscriptionsEnabled = false,
  customers = [],
  incomeAccounts = [],
}: {
  subscriptionsEnabled?: boolean;
  advancedSubscriptionsEnabled?: boolean;
  customers?: Opt[];
  incomeAccounts?: Opt[];
}) {
  const [tab, setTab] = useState<"recurring" | "subscriptions" | "advanced" | "dunning">("recurring");
  const t = useTranslations("ar.collections");
  return (
    <div className="mt-6">
      <div className="mb-4 flex flex-wrap gap-2">
        <Button variant={tab === "recurring" ? "default" : "ghost"} onClick={() => setTab("recurring")}>
          {t("tabs.recurring")}
        </Button>
        {subscriptionsEnabled && (
          <Button variant={tab === "subscriptions" ? "default" : "ghost"} onClick={() => setTab("subscriptions")}>
            {t("tabs.subscriptions")}
          </Button>
        )}
        {advancedSubscriptionsEnabled && (
          <Button variant={tab === "advanced" ? "default" : "ghost"} onClick={() => setTab("advanced")}>{t("tabs.advanced")}</Button>
        )}
        <Button variant={tab === "dunning" ? "default" : "ghost"} onClick={() => setTab("dunning")}>
          {t("tabs.dunning")}
        </Button>
      </div>
      {tab === "recurring" && <RecurringPanel />}
      {tab === "subscriptions" && subscriptionsEnabled && <SubscriptionsPanel customers={customers} incomeAccounts={incomeAccounts} />}
      {tab === "advanced" && advancedSubscriptionsEnabled && <AdvancedSubscriptionsPanel />}
      {tab === "dunning" && <DunningPanel />}
    </div>
  );
}

function SubscriptionsPanel({ customers, incomeAccounts }: { customers: Opt[]; incomeAccounts: Opt[] }) {
  const { money } = useMoney()
  const t = useTranslations("ar.collections.subscriptions");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [mrr, setMrr] = useState("0.0000");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planForm, setPlanForm] = useState({ name: "", amount: "", interval: "monthly", intervalCount: "1", incomeAccountId: "" });
  const [subForm, setSubForm] = useState({ customerId: "", planId: "", quantity: "1", priceOverride: "", startOn: "", firstBillOn: "", prorateFirstPeriod: false, autoPost: false });
  const [changing, setChanging] = useState<string | null>(null);
  const [changeQty, setChangeQty] = useState("");

  const load = async () => {
    const r = await fetch("/api/subscriptions");
    if (r.ok) { const d = await r.json(); setPlans(d.plans ?? []); setSubs(d.subscriptions ?? []); setMrr(d.mrr ?? "0.0000"); }
  };
  useEffect(() => { void load(); }, []);

  const post = async (payload: Record<string, unknown>) => {
    setError(null); setMsg(null);
    const r = await fetch("/api/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { setError(b.error ?? t("errors.actionFailed")); return null; }
    await load();
    return b;
  };

  return (
    <div className="space-y-6">
      <Card className="flex items-center justify-between p-4">
        <div><div className="text-xs text-muted-foreground">{t("mrr")}</div><div className="text-2xl font-semibold">{money(mrr)}</div></div>
        <div className="text-sm text-muted-foreground">{t("summary", { active: subs.filter((s) => s.status === "active").length, plans: plans.length })}</div>
      </Card>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {msg && <p className="text-sm text-teal-700 dark:text-teal-300">{msg}</p>}

      {/* Plans */}
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">{t("plansTitle")}</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground"><tr><th className="py-1">{t("plansTable.plan")}</th><th className="text-right">{t("plansTable.price")}</th><th>{t("plansTable.billing")}</th><th></th></tr></thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="py-1 font-medium">{p.name}{!p.isActive && <span className="ml-1 text-xs text-slate-400">{t("archived")}</span>}</td>
                  <td className="text-right tabular-nums">{money(p.amount, { currency: p.currency ?? undefined })}</td>
                  <td>{t("every", { count: p.intervalCount > 1 ? `${p.intervalCount} ` : "", unit: p.interval.replace("ly", p.intervalCount > 1 ? "s" : "") })}</td>
                  <td className="text-right"><Button size="sm" variant="ghost" onClick={() => post({ action: "deletePlan", id: p.id })}>{t("delete")}</Button></td>
                </tr>
              ))}
              {plans.length === 0 && <tr><td colSpan={4} className="py-3 text-center text-muted-foreground">{t("noPlans")}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-5">
          <Input placeholder={t("planNamePlaceholder")} value={planForm.name} onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })} className="sm:col-span-2" />
          <Input placeholder={t("pricePlaceholder")} type="number" value={planForm.amount} onChange={(e) => setPlanForm({ ...planForm, amount: e.target.value })} />
          <Select value={planForm.interval} onChange={(e) => setPlanForm({ ...planForm, interval: e.target.value })}>
            {INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
          </Select>
          <Input placeholder={t("everyNPlaceholder")} type="number" value={planForm.intervalCount} onChange={(e) => setPlanForm({ ...planForm, intervalCount: e.target.value })} />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Select value={planForm.incomeAccountId} onChange={(e) => setPlanForm({ ...planForm, incomeAccountId: e.target.value })} className="max-w-xs">
            <option value="">{t("defaultIncomeAccount")}</option>
            {incomeAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </Select>
          <Button size="sm" disabled={!planForm.name || !planForm.amount} onClick={async () => { await post({ action: "addPlan", ...planForm, intervalCount: Number(planForm.intervalCount || 1), incomeAccountId: planForm.incomeAccountId || null }); setPlanForm({ name: "", amount: "", interval: "monthly", intervalCount: "1", incomeAccountId: "" }); }}>{t("addPlan")}</Button>
        </div>
      </Card>

      {/* Subscriptions */}
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">{t("subsTitle")}</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground"><tr><th className="py-1">{t("subsTable.customer")}</th><th>{t("subsTable.plan")}</th><th className="text-right">{t("subsTable.qty")}</th><th className="text-right">{t("subsTable.mrr")}</th><th>{t("subsTable.nextBill")}</th><th>{t("subsTable.status")}</th><th></th></tr></thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id} className="border-t align-top">
                  <td className="py-1 font-medium">{s.customerName ?? "—"}</td>
                  <td>{s.planName}</td>
                  <td className="text-right tabular-nums">{s.quantity}</td>
                  <td className="text-right tabular-nums">{s.status === "active" ? money(s.mrr, { currency: s.planCurrency ?? undefined }) : "—"}</td>
                  <td>{s.nextBillOn}{s.lastError && <span className="ml-1 text-red-600" title={s.lastError}>⚠</span>}</td>
                  <td><Badge variant={s.status === "active" ? "default" : "secondary"}>{s.status}</Badge></td>
                  <td className="whitespace-nowrap text-right">
                    {s.status === "active" && changing === s.id ? (
                      <span className="inline-flex items-center gap-1">
                        <Input type="number" value={changeQty} onChange={(e) => setChangeQty(e.target.value)} className="h-7 w-16" />
                        <Button size="sm" onClick={async () => { const r = await post({ action: "changeSubscription", id: s.id, quantity: changeQty }); if (r) setMsg(r.documentNumber ? t("toasts.prorated", { adjustment: money(r.adjustment), documentNumber: r.documentNumber }) : t("toasts.qtyUpdatedNoProration")); setChanging(null); }}>{t("apply")}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setChanging(null)}>×</Button>
                      </span>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" onClick={async () => { const r = await post({ action: "billNow", id: s.id }); if (r?.invoiceId) setMsg(t("toasts.billed", { documentNumber: r.documentNumber })); }}>{t("billNow")}</Button>
                        {s.status === "active" && !s.advancedLifecycle && <Button size="sm" variant="ghost" onClick={() => { setChanging(s.id); setChangeQty(s.quantity); }}>{t("changeQty")}</Button>}
                        {s.status === "active"
                          ? <Button size="sm" variant="ghost" onClick={() => post({ action: "updateSubscription", id: s.id, status: "paused" })}>{t("pause")}</Button>
                          : s.status === "paused"
                            ? <Button size="sm" variant="ghost" onClick={() => post({ action: "updateSubscription", id: s.id, status: "active" })}>{t("resume")}</Button>
                            : null}
                        {s.status !== "canceled" && <Button size="sm" variant="ghost" onClick={() => post({ action: "updateSubscription", id: s.id, status: "canceled" })}>{t("cancelSub")}</Button>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {subs.length === 0 && <tr><td colSpan={7} className="py-3 text-center text-muted-foreground">{t("noSubs")}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-6">
          <Select value={subForm.customerId} onChange={(e) => setSubForm({ ...subForm, customerId: e.target.value })} className="sm:col-span-2">
            <option value="">{t("customerPlaceholder")}</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={subForm.planId} onChange={(e) => setSubForm({ ...subForm, planId: e.target.value })} className="sm:col-span-2">
            <option value="">{t("planPlaceholder")}</option>
            {plans.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Input placeholder={t("qtyPlaceholder")} type="number" value={subForm.quantity} onChange={(e) => setSubForm({ ...subForm, quantity: e.target.value })} />
          <Input type="date" value={subForm.startOn} onChange={(e) => setSubForm({ ...subForm, startOn: e.target.value })} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Input placeholder={t("priceOverridePlaceholder")} type="number" value={subForm.priceOverride} onChange={(e) => setSubForm({ ...subForm, priceOverride: e.target.value })} className="max-w-48" />
          <label className="flex items-center gap-1 text-sm">{t("firstFullBill")} <Input type="date" value={subForm.firstBillOn} onChange={(e) => setSubForm({ ...subForm, firstBillOn: e.target.value })} className="h-8" /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={subForm.prorateFirstPeriod} onChange={(e) => setSubForm({ ...subForm, prorateFirstPeriod: e.target.checked })} /> {t("prorateFirstPeriod")}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={subForm.autoPost} onChange={(e) => setSubForm({ ...subForm, autoPost: e.target.checked })} /> {t("autoPostInvoices")}</label>
          <Button size="sm" disabled={!subForm.customerId || !subForm.planId} onClick={async () => { const r = await post({ action: "addSubscription", ...subForm, priceOverride: subForm.priceOverride || null }); if ((r as any)?.proration?.documentNumber) setMsg(t("toasts.firstInvoiceProrated", { documentNumber: (r as any).proration.documentNumber, amount: money((r as any).proration.amount) })); setSubForm({ customerId: "", planId: "", quantity: "1", priceOverride: "", startOn: "", firstBillOn: "", prorateFirstPeriod: false, autoPost: false }); }}>{t("addSubscription")}</Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("prorateHint")}</p>
      </Card>
    </div>
  );
}

function RecurringPanel() {
  const [rows, setRows] = useState<Schedule[]>([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ templateDocumentNumber: "", cadence: "monthly", cron: "", nextRunOn: "", autoPost: false });
  const [error, setError] = useState<string | null>(null);
  const t = useTranslations("ar.collections.recurring");

  const load = async () => {
    const r = await fetch("/api/recurring");
    if (r.ok) setRows((await r.json()).schedules ?? []);
  };
  useEffect(() => { void load(); }, []);

  const create = async () => {
    setError(null);
    setBusy(true);
    const r = await fetch("/api/recurring", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        templateDocumentNumber: form.templateDocumentNumber,
        cadence: form.cadence,
        cron: form.cadence === "custom_cron" ? form.cron : null,
        nextRunOn: form.nextRunOn || undefined,
        autoPost: form.autoPost,
      }),
    });
    setBusy(false);
    if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? t("couldNotCreate")); return; }
    setForm({ templateDocumentNumber: "", cadence: "monthly", cron: "", nextRunOn: "", autoPost: false });
    void load();
  };

  const act = async (id: string, method: "PATCH" | "DELETE" | "POST", body?: unknown) => {
    setError(null);
    const r = await fetch(`/api/recurring/${id}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await r.json().catch(() => ({})) as { code?: unknown; error?: unknown };
    if (!r.ok) {
      setError(
        result.code === "generated_documents_exist"
          ? t("generatedDocumentsDeleteConflict")
          : typeof result.error === "string"
            ? result.error
            : t("actionFailed"),
      );
      return;
    }
    void load();
  };

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">{t("newSchedule")}</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label>{t("templateDocLabel")}</Label>
            <Input
              placeholder={t("templateDocPlaceholder")}
              value={form.templateDocumentNumber}
              onChange={(e) => setForm({ ...form, templateDocumentNumber: e.target.value })}
            />
          </div>
          <div>
            <Label>{t("cadenceLabel")}</Label>
            <Select value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value })}>
              {CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
          {form.cadence === "custom_cron" && (
            <div>
              <Label>{t("cronLabel")}</Label>
              <Input placeholder="0 9 1 * *" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
            </div>
          )}
          <div>
            <Label>{t("firstRunLabel")}</Label>
            <Input type="date" value={form.nextRunOn} onChange={(e) => setForm({ ...form, nextRunOn: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" checked={form.autoPost} onChange={(e) => setForm({ ...form, autoPost: e.target.checked })} />
            {t("autoPostCheckbox")}
          </label>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-3">
          <Button onClick={create} disabled={busy || !form.templateDocumentNumber}>{t("createSchedule")}</Button>
        </div>
      </Card>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-2">{t("table.template")}</th><th>{t("table.customer")}</th><th>{t("table.cadence")}</th><th>{t("table.nextRun")}</th>
              <th>{t("table.runs")}</th><th>{t("table.autoPost")}</th><th>{t("table.status")}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-t">
                <td className="py-2 font-medium">{s.templateNumber}</td>
                <td>{s.partyName ?? "—"}</td>
                <td>{s.cadence}{s.cron ? ` (${s.cron})` : ""}</td>
                <td>{s.nextRunOn}</td>
                <td>{s.runCount}{s.lastError ? <span className="ml-1 text-red-600" title={s.lastError}>⚠</span> : null}</td>
                <td>{s.autoPost ? t("yes") : t("no")}</td>
                <td>{s.isActive ? <Badge>{t("active")}</Badge> : <Badge variant="secondary">{t("paused")}</Badge>}</td>
                <td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => act(s.id, "POST")}>{t("runNow")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => act(s.id, "PATCH", { isActive: !s.isActive })}>
                    {s.isActive ? t("pause") : t("resume")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => act(s.id, "DELETE")}>{t("delete")}</Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="py-6 text-center text-muted-foreground">{t("noneYet")}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const BLANK_STAGE: Stage = {
  sequence: 1,
  name: "First reminder",
  offsetDays: 7,
  subjectTemplate: "Invoice {{invoice}} is past due",
  bodyTemplate: "Hi {{party}},\n\nInvoice {{invoice}} for {{amount}} was due {{dueDate}} ({{daysOverdue}} days ago). Please arrange payment.\n\n{{orgName}}",
  escalate: false,
};

function DunningPanel() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [draft, setDraft] = useState<{ name: string; gracePeriodDays: number; stages: Stage[] }>({
    name: "", gracePeriodDays: 0, stages: [BLANK_STAGE],
  });
  const [error, setError] = useState<string | null>(null);
  const t = useTranslations("ar.collections.dunning");
  const tErrors = useTranslations("ar.collections.errors");

  const load = async () => {
    const r = await fetch("/api/dunning");
    if (r.ok) setPolicies((await r.json()).policies ?? []);
  };
  useEffect(() => { void load(); }, []);

  const create = async () => {
    setError(null);
    const r = await fetch("/api/dunning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? tErrors("couldNotCreate")); return; }
    setDraft({ name: "", gracePeriodDays: 0, stages: [BLANK_STAGE] });
    void load();
  };

  const remove = async (id: string) => { await fetch(`/api/dunning/${id}`, { method: "DELETE" }); void load(); };

  const setStage = (i: number, patch: Partial<Stage>) =>
    setDraft({ ...draft, stages: draft.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">{t("newPolicy")}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>{t("policyNameLabel")}</Label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("policyNamePlaceholder")} />
          </div>
          <div>
            <Label>{t("gracePeriodLabel")}</Label>
            <Input type="number" value={draft.gracePeriodDays} onChange={(e) => setDraft({ ...draft, gracePeriodDays: Number(e.target.value) })} />
          </div>
        </div>
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t("reminderLadder")}</span>
            <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, stages: [...draft.stages, { ...BLANK_STAGE, sequence: draft.stages.length + 1, name: t("newStageName", { n: draft.stages.length + 1 }), offsetDays: (draft.stages.at(-1)?.offsetDays ?? 0) + 14 }] })}>
              {t("addStage")}
            </Button>
          </div>
          {draft.stages.map((s, i) => (
            <div key={i} className="rounded border p-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <div><Label>{t("stageLabels.name")}</Label><Input value={s.name} onChange={(e) => setStage(i, { name: e.target.value })} /></div>
                <div><Label>{t("stageLabels.daysPastDue")}</Label><Input type="number" value={s.offsetDays} onChange={(e) => setStage(i, { offsetDays: Number(e.target.value) })} /></div>
                <div><Label>{t("stageLabels.sequence")}</Label><Input type="number" value={s.sequence} onChange={(e) => setStage(i, { sequence: Number(e.target.value) })} /></div>
              </div>
              <div className="mt-2"><Label>{t("subjectLabel")}</Label><Input value={s.subjectTemplate} onChange={(e) => setStage(i, { subjectTemplate: e.target.value })} /></div>
              <div className="mt-2">
                <Label>{t("bodyLabel")}</Label>
                <textarea className="w-full rounded border px-2 py-1 text-sm" rows={4} value={s.bodyTemplate} onChange={(e) => setStage(i, { bodyTemplate: e.target.value })} />
              </div>
              {draft.stages.length > 1 && (
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => setDraft({ ...draft, stages: draft.stages.filter((_, j) => j !== i) })}>{t("removeStage")}</Button>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{t("tokensHint")} {"{{party}} {{invoice}} {{amount}} {{dueDate}} {{daysOverdue}} {{orgName}}"}</p>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-3"><Button onClick={create} disabled={!draft.name}>{t("createPolicy")}</Button></div>
      </Card>

      <div className="space-y-3">
        {policies.map((p) => (
          <Card key={p.id} className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium">{p.name}</span>
                <span className="ml-2 text-sm text-muted-foreground">
                  {t("policySummary", { count: p.stages.length, grace: p.gracePeriodDays })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {p.isActive ? <Badge>{t("activeBadge")}</Badge> : <Badge variant="secondary">{t("off")}</Badge>}
                <Button size="sm" variant="ghost" onClick={() => remove(p.id)}>{t("delete")}</Button>
              </div>
            </div>
            <ul className="mt-2 text-sm text-muted-foreground">
              {[...p.stages].sort((a, b) => a.sequence - b.sequence).map((s) => (
                <li key={s.sequence}>{t("stageDay", { day: s.offsetDays, name: s.name })}</li>
              ))}
            </ul>
          </Card>
        ))}
        {policies.length === 0 && <p className="text-center text-muted-foreground">{t("noneYet")}</p>}
      </div>
    </div>
  );
}
