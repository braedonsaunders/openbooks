"use client";

import { PagedTable } from '@/components/paged-table'
import { ListPageLayout } from '@/components/page-layout'
import { SetupDrawer } from '../admin/setup/[entity]/SetupDrawer'
import { BILLING_ENTITIES } from '@/lib/setup/entities/billing'
import { useRouter, useSearchParams } from 'next/navigation'
import { Plus } from 'lucide-react'
import { CollectionsQueue } from './CollectionsQueue'
import { useMoney } from '@/components/money-provider'
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { enumLabel } from "@/lib/enum-label";
import { Badge, Button, Card, Drawer, Input, Label, PageHeader, Select } from "@openbooks/ui";
import { AdvancedSubscriptionsPanel } from "./AdvancedSubscriptionsPanel";
import { confirmDialog } from "../../../lib/confirm";
import { readApiErrorMessage } from "../../../lib/api-error";
import { ActionError, fetchAction } from "@braedonsaunders/appkit-errors";
import { useAppAction } from "../../../lib/use-app-action";

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
  updatedAt?: string;
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
interface SubscriptionActionBody {
  documentNumber?: string;
  adjustment?: string;
  invoiceId?: string;
  proration?: { documentNumber?: string; amount?: string };
}

export type CollectionsView = 'worklist' | 'policies' | 'recurring' | 'subscriptions' | 'plans' | 'versions' | 'contracts' | 'amendments'
type EditorProps = { creating: boolean; onClose: () => void }

export function CollectionsClient({ subscriptionsEnabled = false, advancedSubscriptionsEnabled = false,
  customers = [], incomeAccounts = [], title, description, worklistEnabled = false, initialView,
}: {
  subscriptionsEnabled?: boolean; advancedSubscriptionsEnabled?: boolean;
  customers?: Opt[]; incomeAccounts?: Opt[]; title?: string; description?: string;
  worklistEnabled?: boolean; initialView?: CollectionsView;
}) {
  const search = useSearchParams()
  const t = useTranslations('ar.collections')
  const newAction = useTranslations('ar.actions')
  const requested = initialView ?? search?.get('view') ?? (worklistEnabled ? 'worklist' : 'policies')
  const available: CollectionsView[] = [ ...(worklistEnabled ? ['worklist' as const] : []), 'policies', 'recurring',
    ...(subscriptionsEnabled ? ['subscriptions' as const, 'plans' as const] : []),
    ...(advancedSubscriptionsEnabled ? ['versions' as const, 'contracts' as const, 'amendments' as const] : []),
  ]
  const view = available.find((candidate) => candidate === requested) ?? available[0]!
  const [creatingFor, setCreatingFor] = useState<CollectionsView | null>(null)
  const router = useRouter()
  const editor = { creating: creatingFor === view, onClose: () => setCreatingFor(null) }
  const openNew = () => view === 'policies' ? router.push('/collections?view=policies&policy=new') : setCreatingFor(view)
  return <ListPageLayout header={<PageHeader title={title ?? t('title')} description={description ?? t('pageDescription')}
    actions={view !== 'worklist' ? <Button onClick={openNew}><Plus size={16} />{newAction('new')}</Button> : undefined} />}>
    {view === 'worklist' && <CollectionsQueue />}
    {view === 'recurring' && <RecurringPanel {...editor} />}
    {(view === 'subscriptions' || view === 'plans') && <SubscriptionsPanel key={view} view={view} {...editor} customers={customers} incomeAccounts={incomeAccounts} />}
    {(view === 'versions' || view === 'contracts' || view === 'amendments') && <AdvancedSubscriptionsPanel key={view} view={view} {...editor} />}
    {view === 'policies' && <DunningPanel />}
  </ListPageLayout>
}

function SubscriptionsPanel({ customers, incomeAccounts, view, creating, onClose }: { customers: Opt[]; incomeAccounts: Opt[]; view: 'plans' | 'subscriptions' } & EditorProps) {
  const { money } = useMoney()
  const t = useTranslations("ar.collections.subscriptions");
  const tCommon = useTranslations("common");
  const subscriptionStatusLabels = {
    active: tCommon("status.active"),
    paused: tCommon("status.paused"),
    canceled: tCommon("status.cancelled"),
  } satisfies Record<"active" | "paused" | "canceled", string>;
  const tc = useTranslations("common");
  // The refusal fallback lives under `ar.collections.errors`, not under this
  // section — read from `t` it rendered the literal text
  // `ar.collections.subscriptions.errors.actionFailed` whenever the API
  // refused without a message body.
  const tErrors = useTranslations("ar.collections.errors");
  const tCommonActions = useTranslations("common.actions");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [mrr, setMrr] = useState("0.0000");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planForm, setPlanForm] = useState({ name: "", amount: "", interval: "monthly", intervalCount: "1", incomeAccountId: "" });
  const [subForm, setSubForm] = useState({ customerId: "", planId: "", quantity: "1", priceOverride: "", startOn: "", firstBillOn: "", prorateFirstPeriod: false, autoPost: false });
  const [changing, setChanging] = useState<string | null>(null);
  const [changeQty, setChangeQty] = useState("");
  const action = useAppAction();

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body. Named refusals surface
  // through the shared read; transport outages pin the fallback and keep the
  // last good table with its retry instead of emptying it.
  const load = useCallback(async () => {
    const result = await fetchAction<{ plans?: Plan[]; subscriptions?: Subscription[]; mrr?: string }>("/api/subscriptions");
    if (!result.ok) {
      setLoadError(result.error.displayMessage(tErrors("actionFailed")));
      return;
    }
    const data = result.data;
    setLoadError(null);
    setPlans(data.plans ?? []);
    setSubs(data.subscriptions ?? []);
    setMrr(data.mrr ?? "0.0000");
    setLoaded(true);
  }, [tErrors]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  const post = async (payload: Record<string, unknown>): Promise<SubscriptionActionBody | null> => {
    setError(null); setMsg(null);
    // Assigned inside the execute task below, which execute awaits before it
    // resolves: by the return the closure has run, but control-flow analysis
    // cannot see that, so the declared return type carries the contract.
    let body: SubscriptionActionBody | null = null;
    const ok = await action.execute(async () => {
      const result = await fetchAction<SubscriptionActionBody>("/api/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (result.ok) body = result.data ?? {};
      return result;
    }, {
      fallbackMessage: tErrors("actionFailed"),
      onRefused: (refusal) => setError(refusal.displayMessage(tErrors("actionFailed"))),
      onOk: () => { void load() },
    });
    return ok ? body : null;
  };

  return (
    <div className="space-y-6">
      {loadError && <div role="alert" className="flex items-center gap-3 text-sm text-red-600">{loadError}<Button variant="outline" onClick={() => void load()}>{tCommonActions("retry")}</Button></div>}
      {loaded && view === "subscriptions" && <Card className="flex items-center justify-between p-4">
        <div><div className="text-xs text-muted-foreground">{t("mrr")}</div><div className="text-2xl font-semibold">{money(mrr)}</div></div>
        <div className="text-sm text-muted-foreground">{t("summary", { active: subs.filter((s) => s.status === "active").length, plans: plans.length })}</div>
      </Card>}

      {error && !creating && !changing && <p role="alert" className="text-sm text-red-600">{error} <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => void load()}>{tc("actions.retry")}</Button></p>}
      {msg && <p className="text-sm text-teal-700 dark:text-teal-300">{msg}</p>}

      {/* Plans */}
      {view === "plans" && <>
        <PagedTable source="collections_plans" searchable rows={plans} rowKey={(p) => p.id} empty={loaded ? t("noPlans") : tc("feedback.loading")} columns={[
{ key: 'name', header: <>{t("plansTable.plan")}</>, cell: (p) => <>{p.name}{!p.isActive && <span className="ml-1 text-xs text-slate-400">{t("archived")}</span>}</>, search: (p) => p.name ?? '' },
{ key: 'amount', header: <>{t("plansTable.price")}</>, cell: (p) => <>{money(p.amount, { currency: p.currency ?? undefined })}</> },
{ key: 'interval', header: <>{t("plansTable.billing")}</>, cell: (p) => <>{t("every", { count: p.intervalCount > 1 ? `${p.intervalCount} ` : "", unit: p.interval.replace("ly", p.intervalCount > 1 ? "s" : "") })}</> },
{ key: 'actions', header: <></>, cell: (p) => <><Button size="sm" variant="ghost" disabled={action.busy} onClick={() => post({ action: "deletePlan", id: p.id })}>{t("delete")}</Button></> }
        ]} />
      <Drawer open={creating} onClose={onClose} title={t("plansTitle")} size="lg">
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        <div className="mt-3 grid gap-2 sm:grid-cols-5">
          <Input placeholder={t("planNamePlaceholder")} value={planForm.name} onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })} className="sm:col-span-2" />
          <Input placeholder={t("pricePlaceholder")} inputMode="decimal" value={planForm.amount} onChange={(e) => setPlanForm({ ...planForm, amount: e.target.value })} />
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
          <Button size="sm" disabled={action.busy || !planForm.name || !planForm.amount} onClick={async () => { const r = await post({ action: "addPlan", ...planForm, intervalCount: Number(planForm.intervalCount || 1), incomeAccountId: planForm.incomeAccountId || null }); if (!r) return; onClose(); setPlanForm({ name: "", amount: "", interval: "monthly", intervalCount: "1", incomeAccountId: "" }); }}>{t("addPlan")}</Button>
        </div>

      </Drawer>
      </>}

      {/* Subscriptions */}
      {view === "subscriptions" && <>
        <PagedTable source="collections_subscriptions" searchable rows={subs} rowKey={(s) => s.id} empty={loaded ? t("noSubs") : tc("feedback.loading")} columns={[
{ key: 'customerName', header: <>{t("subsTable.customer")}</>, cell: (s) => <>{s.customerName ?? "—"}</>, search: (s) => s.customerName ?? '' },
{ key: 'planName', header: <>{t("subsTable.plan")}</>, cell: (s) => <>{s.planName}</>, search: (s) => s.planName ?? '' },
{ key: 'quantity', header: <>{t("subsTable.qty")}</>, cell: (s) => <>{s.quantity}</> },
{ key: 'mrr', header: <>{t("subsTable.mrr")}</>, cell: (s) => <>{s.status === "active" ? money(s.mrr, { currency: s.planCurrency ?? undefined }) : "—"}</> },
{ key: 'nextBillOn', header: <>{t("subsTable.nextBill")}</>, cell: (s) => <>{s.nextBillOn}{s.lastError && <span className="ml-1 text-red-600" title={s.lastError}>⚠</span>}</> },
{ key: 'status', header: <>{t("subsTable.status")}</>, cell: (s) => <><Badge variant={s.status === "active" ? "default" : "secondary"}>{enumLabel(s.status, subscriptionStatusLabels, tCommon("labels.unknownValue"))}</Badge></> },
{ key: 'actions', header: <></>, cell: (s) => <>
                      <>
                        <Button size="sm" variant="ghost" disabled={action.busy} onClick={async () => { const r = await post({ action: "billNow", id: s.id }); if (r?.invoiceId && r.documentNumber) setMsg(t("toasts.billed", { documentNumber: r.documentNumber })); }}>{t("billNow")}</Button>
                        {s.status === "active" && !s.advancedLifecycle && <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => { setChanging(s.id); setChangeQty(s.quantity); }}>{t("changeQty")}</Button>}
                        {s.status === "active"
                          ? <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => post({ action: "updateSubscription", id: s.id, status: "paused" })}>{t("pause")}</Button>
                          : s.status === "paused"
                            ? <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => post({ action: "updateSubscription", id: s.id, status: "active" })}>{t("resume")}</Button>
                            : null}
                        {s.status !== "canceled" && <Button size="sm" variant="ghost" disabled={action.busy} onClick={async () => {
                          const confirmed = await confirmDialog({
                            title: t("cancelConfirmTitle"),
                            message: t("cancelConfirmBody"),
                            confirmLabel: t("cancelSub"),
                            tone: "danger",
                          })
                          if (confirmed) post({ action: "updateSubscription", id: s.id, status: "canceled" })
                        }}>{t("cancelSub")}</Button>}
                      </>
                  </> }
        ]} />
      <Drawer open={creating} onClose={onClose} title={t("subsTitle")} size="lg">
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

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
          <Input placeholder={t("priceOverridePlaceholder")} inputMode="decimal" value={subForm.priceOverride} onChange={(e) => setSubForm({ ...subForm, priceOverride: e.target.value })} className="max-w-48" />
          <label className="flex items-center gap-1 text-sm">{t("firstFullBill")} <Input type="date" value={subForm.firstBillOn} onChange={(e) => setSubForm({ ...subForm, firstBillOn: e.target.value })} className="h-8" /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={subForm.prorateFirstPeriod} onChange={(e) => setSubForm({ ...subForm, prorateFirstPeriod: e.target.checked })} /> {t("prorateFirstPeriod")}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={subForm.autoPost} onChange={(e) => setSubForm({ ...subForm, autoPost: e.target.checked })} /> {t("autoPostInvoices")}</label>
          <Button size="sm" disabled={action.busy || !subForm.customerId || !subForm.planId} onClick={async () => { const r = await post({ action: "addSubscription", ...subForm, priceOverride: subForm.priceOverride || null }); if (!r) return; onClose(); if (r.proration?.documentNumber) setMsg(t("toasts.firstInvoiceProrated", { documentNumber: r.proration.documentNumber, amount: money(r.proration.amount) })); setSubForm({ customerId: "", planId: "", quantity: "1", priceOverride: "", startOn: "", firstBillOn: "", prorateFirstPeriod: false, autoPost: false }); }}>{t("addSubscription")}</Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("prorateHint")}</p>

      </Drawer>
      </>}
      <Drawer open={!!changing} onClose={() => setChanging(null)} title={t('changeQty')}>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Label>{t('subsTable.qty')}</Label>
        <Input aria-label={t('subsTable.qty')} inputMode="decimal" value={changeQty} onChange={(e) => setChangeQty(e.target.value)} />
        <Button className="mt-3" disabled={action.busy} onClick={async () => {
          const r = await post({ action: 'changeSubscription', id: changing, quantity: changeQty })
          if (!r) return
          setMsg(r.documentNumber ? t('toasts.prorated', { adjustment: money(r.adjustment), documentNumber: r.documentNumber }) : t('toasts.qtyUpdatedNoProration'))
          setChanging(null)
        }}>{t('apply')}</Button>
      </Drawer>

    </div>
  );
}

function RecurringPanel({ creating, onClose }: EditorProps) {
  const [rows, setRows] = useState<Schedule[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">("loading");
  const action = useAppAction();
  const busy = action.busy;
  const [form, setForm] = useState({ templateDocumentNumber: "", cadence: "monthly", cron: "", nextRunOn: "", autoPost: false });
  const [error, setError] = useState<string | null>(null);
  const t = useTranslations("ar.collections.recurring");
  const tErrors = useTranslations("ar.collections.errors");
  const common = useTranslations("common");

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body.
  const load = useCallback(() => {
    setLoadState("loading");
    return fetch("/api/recurring").then(async (r) => {
      if (!r.ok) throw new Error(await readApiErrorMessage(r, common("feedback.loadFailed")));
      const body = await r.json();
      setRows(body.schedules ?? []);
      setLoadState("loaded");
    }).catch((cause: unknown) => { setLoadState("failed"); setError(cause instanceof Error ? cause.message : common("feedback.loadFailed")); });
  }, [common]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  const create = async () => {
    setError(null);
    await action.execute(() => fetchAction("/api/recurring", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        templateDocumentNumber: form.templateDocumentNumber,
        cadence: form.cadence,
        cron: form.cadence === "custom_cron" ? form.cron : null,
        nextRunOn: form.nextRunOn || undefined,
        autoPost: form.autoPost,
      }),
    }), {
      fallbackMessage: tErrors("couldNotCreate"),
      onRefused: (refusal) => setError(refusal.displayMessage(tErrors("couldNotCreate"))),
      onOk: () => {
        onClose();
        setForm({ templateDocumentNumber: "", cadence: "monthly", cron: "", nextRunOn: "", autoPost: false });
        void load();
      },
    });
  };

  const act = async (id: string, method: "PATCH" | "DELETE" | "POST", body?: unknown) => {
    setError(null);
    await action.execute(async () => {
        const result = await fetchAction(`/api/recurring/${id}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!result.ok && result.error.code === "generated_documents_exist") {
        return { ok: false as const, error: new ActionError({ kind: "refused", code: result.error.code, serverMessage: t("generatedDocumentsDeleteConflict") }) };
      }
      return result;
    }, {
      fallbackMessage: t("actionFailed"),
      onRefused: (refusal) => setError(refusal.displayMessage(t("actionFailed"))),
      onOk: () => { void load() },
    });
  };

  return (
    <div className="space-y-6">
      <Drawer open={creating} onClose={onClose} title={t("newSchedule")} size="lg">
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
              {CADENCES.map((c) => <option key={c} value={c}>{t(`cadences.${c}`)}</option>)}
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
        {error && <p role="alert" className="mt-2 text-sm text-red-600">{error} <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => void load()}>{common("actions.retry")}</Button></p>}
        <div className="mt-3">
          <Button onClick={create} disabled={busy || !form.templateDocumentNumber}>{t("createSchedule")}</Button>
        </div>
      </Drawer>

      {error && !creating && <p role="alert" className="text-sm text-destructive">{error} <Button variant="outline" onClick={() => void load()}>{common('actions.retry')}</Button></p>}
      <PagedTable source="collections_recurring" searchable rows={rows} rowKey={(row) => row.id}
        empty={loadState === 'loaded' ? t('noneYet') : loadState === 'failed' ? common('feedback.loadFailed') : common('feedback.loading')}
        columns={[
          { key: 'template', headerClassName: 'whitespace-nowrap', header: t('table.template'), search: (s) => s.templateNumber, cell: (s) => <span className="font-medium">{s.templateNumber}</span> },
          { key: 'customer', headerClassName: 'whitespace-nowrap', header: t('table.customer'), search: (s) => s.partyName ?? '', cell: (s) => s.partyName ?? '—' },
          { key: 'cadence', headerClassName: 'whitespace-nowrap', header: t('table.cadence'), cell: (s) => <>{t(`cadences.${s.cadence}`)}{s.cron ? ` (${s.cron})` : ''}</> },
          { key: 'nextRun', headerClassName: 'whitespace-nowrap', header: t('table.nextRun'), cell: (s) => s.nextRunOn },
          { key: 'runs', headerClassName: 'whitespace-nowrap', header: t('table.runs'), cell: (s) => <>{s.runCount}{s.lastError && <span className="ml-1 text-destructive" title={s.lastError}>⚠</span>}</> },
          { key: 'autoPost', headerClassName: 'whitespace-nowrap', header: t('table.autoPost'), cell: (s) => s.autoPost ? t('yes') : t('no') },
          { key: 'status', headerClassName: 'whitespace-nowrap', header: t('table.status'), cell: (s) => <Badge variant={s.isActive ? 'default' : 'secondary'}>{s.isActive ? t('active') : t('paused')}</Badge> },
          { key: 'actions', headerClassName: 'whitespace-nowrap', header: '', cell: (s) => <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(s.id, 'POST')}>{t('runNow')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(s.id, 'PATCH', { isActive: !s.isActive })}>{s.isActive ? t('pause') : t('resume')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(s.id, 'DELETE')}>{t('delete')}</Button>
          </div> },
        ]} />
    </div>
  );
}

const policyEntity = BILLING_ENTITIES.find((entity) => entity.key === 'dunning-policies')!

function DunningPanel() {
  const { money } = useMoney()
  const [policies, setPolicies] = useState<Policy[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const action = useAppAction()
  const t = useTranslations('ar.collections.dunning')
  const common = useTranslations('common')
  const errors = useTranslations('ar.collections.errors')
  const search = useSearchParams()
  const router = useRouter()
  const policyId = search?.get('policy')
  const load = useCallback(async () => {
    const result = await fetchAction<{ policies: Policy[] }>('/api/dunning')
    if (!result.ok) { setError(result.error.displayMessage(errors('couldNotLoad'))); return }
    setPolicies(result.data.policies); setLoaded(true); setError(null)
  }, [errors])
  useEffect(() => { void Promise.resolve().then(load) }, [load, policyId])
  const remove = async (id: string) => {
    setError(null)
    await action.execute(() => fetchAction(`/api/dunning/${id}`, { method: 'DELETE' }), {
      fallbackMessage: errors('couldNotDelete'),
      onRefused: (refusal) => setError(refusal.displayMessage(errors('couldNotDelete'))),
      onOk: () => { void load() },
    })
  }
  const selected = policies.find((policy) => policy.id === policyId)
  // The native editor owns its dialog. It mounts only when the full policy
  // and its stages are available, without an intermediate loading dialog.
  const row = selected ? {
    ...selected, grace_period_days: selected.gracePeriodDays, min_balance: selected.minBalance,
    reply_to: (selected as Policy & { replyTo?: string | null }).replyTo, is_active: selected.isActive,
  } : null
  return <div className="space-y-4">
    {error && <p role="alert" className="text-sm text-destructive">{error} <Button variant="outline" onClick={() => void load()}>{common('actions.retry')}</Button></p>}
    <PagedTable source="collections_policies" searchable rows={policies} rowKey={(p) => p.id}
      onRowClick={(p) => router.push(`/collections?view=policies&policy=${encodeURIComponent(p.id)}`)}
      empty={loaded ? t('noneYet') : common('feedback.loading')} columns={[
        { key: 'name', header: t('policyNameLabel'), search: (p) => p.name, cell: (p) => <span className="font-medium">{p.name}</span> },
        { key: 'stages', header: t('reminderLadder'), cell: (p) => <span>{t('policySummary', { count: p.stages.length, grace: p.gracePeriodDays })}</span> },
        { key: 'minBalance', header: t('minimumBalance'), cell: (p) => money(p.minBalance) },
        { key: 'status', header: common('labels.status'), cell: (p) => <Badge variant={p.isActive ? 'default' : 'secondary'}>{p.isActive ? t('activeBadge') : t('off')}</Badge> },
        { key: 'actions', header: '', cell: (p) => <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => void remove(p.id)}>{t('delete')}</Button> },
      ]} />
    {loaded && policyId && (policyId === 'new' || selected) && <SetupDrawer key={policyId} entity={policyEntity} row={row}
      members={[]} refOptions={{}} closeHref="/collections?view=policies" fixedValues={selected?.updatedAt ? { expectedUpdatedAt: selected.updatedAt } : undefined}
      initialValues={policyId === 'new' ? { stages: [{ sequence: 1, name: '', offsetDays: 7, subjectTemplate: '', bodyTemplate: '', escalate: false }] } : undefined} />}
    {loaded && policyId && policyId !== 'new' && !selected && <p role="alert" className="text-sm text-destructive">{common('feedback.loadFailed')}</p>}
  </div>
}
