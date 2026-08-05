"use client";

import { useMoney } from '@/components/money-provider'
import { useEffect, useState } from "react";
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

interface Opt { id: string; name?: string; label?: string }

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
  return (
    <div className="mt-6">
      <div className="mb-4 flex flex-wrap gap-2">
        <Button variant={tab === "recurring" ? "default" : "ghost"} onClick={() => setTab("recurring")}>
          Recurring invoices
        </Button>
        {subscriptionsEnabled && (
          <Button variant={tab === "subscriptions" ? "default" : "ghost"} onClick={() => setTab("subscriptions")}>
            Subscriptions
          </Button>
        )}
        {advancedSubscriptionsEnabled && (
          <Button variant={tab === "advanced" ? "default" : "ghost"} onClick={() => setTab("advanced")}>Advanced lifecycle</Button>
        )}
        <Button variant={tab === "dunning" ? "default" : "ghost"} onClick={() => setTab("dunning")}>
          Dunning ladders
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
    if (!r.ok) { setError(b.error ?? "Action failed"); return null; }
    await load();
    return b;
  };

  return (
    <div className="space-y-6">
      <Card className="flex items-center justify-between p-4">
        <div><div className="text-xs text-muted-foreground">Monthly recurring revenue</div><div className="text-2xl font-semibold">{money(mrr)}</div></div>
        <div className="text-sm text-muted-foreground">{subs.filter((s) => s.status === "active").length} active · {plans.length} plan{plans.length === 1 ? "" : "s"}</div>
      </Card>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {msg && <p className="text-sm text-teal-700 dark:text-teal-300">{msg}</p>}

      {/* Plans */}
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">Plans</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground"><tr><th className="py-1">Plan</th><th className="text-right">Price</th><th>Billing</th><th></th></tr></thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="py-1 font-medium">{p.name}{!p.isActive && <span className="ml-1 text-xs text-slate-400">(archived)</span>}</td>
                  <td className="text-right tabular-nums">{money(p.amount, { currency: p.currency ?? undefined })}</td>
                  <td>every {p.intervalCount > 1 ? `${p.intervalCount} ` : ""}{p.interval.replace("ly", p.intervalCount > 1 ? "s" : "")}</td>
                  <td className="text-right"><Button size="sm" variant="ghost" onClick={() => post({ action: "deletePlan", id: p.id })}>Delete</Button></td>
                </tr>
              ))}
              {plans.length === 0 && <tr><td colSpan={4} className="py-3 text-center text-muted-foreground">No plans yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-5">
          <Input placeholder="Plan name" value={planForm.name} onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })} className="sm:col-span-2" />
          <Input placeholder="Price" type="number" value={planForm.amount} onChange={(e) => setPlanForm({ ...planForm, amount: e.target.value })} />
          <Select value={planForm.interval} onChange={(e) => setPlanForm({ ...planForm, interval: e.target.value })}>
            {INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
          </Select>
          <Input placeholder="every N" type="number" value={planForm.intervalCount} onChange={(e) => setPlanForm({ ...planForm, intervalCount: e.target.value })} />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Select value={planForm.incomeAccountId} onChange={(e) => setPlanForm({ ...planForm, incomeAccountId: e.target.value })} className="max-w-xs">
            <option value="">Default income account</option>
            {incomeAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </Select>
          <Button size="sm" disabled={!planForm.name || !planForm.amount} onClick={async () => { await post({ action: "addPlan", ...planForm, intervalCount: Number(planForm.intervalCount || 1), incomeAccountId: planForm.incomeAccountId || null }); setPlanForm({ name: "", amount: "", interval: "monthly", intervalCount: "1", incomeAccountId: "" }); }}>Add plan</Button>
        </div>
      </Card>

      {/* Subscriptions */}
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">Subscriptions</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground"><tr><th className="py-1">Customer</th><th>Plan</th><th className="text-right">Qty</th><th className="text-right">MRR</th><th>Next bill</th><th>Status</th><th></th></tr></thead>
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
                        <Button size="sm" onClick={async () => { const r = await post({ action: "changeSubscription", id: s.id, quantity: changeQty }); if (r) setMsg(r.documentNumber ? `Proration ${money(r.adjustment)} → ${r.documentNumber}` : "Quantity updated (no proration due)"); setChanging(null); }}>Apply</Button>
                        <Button size="sm" variant="ghost" onClick={() => setChanging(null)}>×</Button>
                      </span>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" onClick={async () => { const r = await post({ action: "billNow", id: s.id }); if (r?.invoiceId) setMsg(`Billed ${r.documentNumber}`); }}>Bill now</Button>
                        {s.status === "active" && !s.advancedLifecycle && <Button size="sm" variant="ghost" onClick={() => { setChanging(s.id); setChangeQty(s.quantity); }}>Change qty</Button>}
                        {s.status === "active"
                          ? <Button size="sm" variant="ghost" onClick={() => post({ action: "updateSubscription", id: s.id, status: "paused" })}>Pause</Button>
                          : s.status === "paused"
                            ? <Button size="sm" variant="ghost" onClick={() => post({ action: "updateSubscription", id: s.id, status: "active" })}>Resume</Button>
                            : null}
                        {s.status !== "canceled" && <Button size="sm" variant="ghost" onClick={() => post({ action: "updateSubscription", id: s.id, status: "canceled" })}>Cancel</Button>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {subs.length === 0 && <tr><td colSpan={7} className="py-3 text-center text-muted-foreground">No subscriptions yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-6">
          <Select value={subForm.customerId} onChange={(e) => setSubForm({ ...subForm, customerId: e.target.value })} className="sm:col-span-2">
            <option value="">Customer…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={subForm.planId} onChange={(e) => setSubForm({ ...subForm, planId: e.target.value })} className="sm:col-span-2">
            <option value="">Plan…</option>
            {plans.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Input placeholder="Qty" type="number" value={subForm.quantity} onChange={(e) => setSubForm({ ...subForm, quantity: e.target.value })} />
          <Input type="date" value={subForm.startOn} onChange={(e) => setSubForm({ ...subForm, startOn: e.target.value })} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Input placeholder="Price override (optional)" type="number" value={subForm.priceOverride} onChange={(e) => setSubForm({ ...subForm, priceOverride: e.target.value })} className="max-w-48" />
          <label className="flex items-center gap-1 text-sm">First full bill <Input type="date" value={subForm.firstBillOn} onChange={(e) => setSubForm({ ...subForm, firstBillOn: e.target.value })} className="h-8" /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={subForm.prorateFirstPeriod} onChange={(e) => setSubForm({ ...subForm, prorateFirstPeriod: e.target.checked })} /> Prorate first period</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={subForm.autoPost} onChange={(e) => setSubForm({ ...subForm, autoPost: e.target.checked })} /> Auto-post invoices</label>
          <Button size="sm" disabled={!subForm.customerId || !subForm.planId} onClick={async () => { const r = await post({ action: "addSubscription", ...subForm, priceOverride: subForm.priceOverride || null }); if ((r as any)?.proration?.documentNumber) setMsg(`Prorated first invoice ${(r as any).proration.documentNumber} for ${money((r as any).proration.amount)}`); setSubForm({ customerId: "", planId: "", quantity: "1", priceOverride: "", startOn: "", firstBillOn: "", prorateFirstPeriod: false, autoPost: false }); }}>Add subscription</Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Set a first-bill date after the start and tick “prorate” to bill only the partial first period now.</p>
      </Card>
    </div>
  );
}

function RecurringPanel() {
  const [rows, setRows] = useState<Schedule[]>([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ templateDocumentNumber: "", cadence: "monthly", cron: "", nextRunOn: "", autoPost: false });
  const [error, setError] = useState<string | null>(null);

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
    if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? "Could not create"); return; }
    setForm({ templateDocumentNumber: "", cadence: "monthly", cron: "", nextRunOn: "", autoPost: false });
    void load();
  };

  const act = async (id: string, method: "PATCH" | "DELETE" | "POST", body?: unknown) => {
    await fetch(`/api/recurring/${id}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    void load();
  };

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">New recurring schedule</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label>Template document #</Label>
            <Input
              placeholder="INV-000123"
              value={form.templateDocumentNumber}
              onChange={(e) => setForm({ ...form, templateDocumentNumber: e.target.value })}
            />
          </div>
          <div>
            <Label>Cadence</Label>
            <Select value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value })}>
              {CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
          {form.cadence === "custom_cron" && (
            <div>
              <Label>Cron</Label>
              <Input placeholder="0 9 1 * *" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
            </div>
          )}
          <div>
            <Label>First run</Label>
            <Input type="date" value={form.nextRunOn} onChange={(e) => setForm({ ...form, nextRunOn: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" checked={form.autoPost} onChange={(e) => setForm({ ...form, autoPost: e.target.checked })} />
            Auto-post generated documents
          </label>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-3">
          <Button onClick={create} disabled={busy || !form.templateDocumentNumber}>Create schedule</Button>
        </div>
      </Card>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-2">Template</th><th>Customer</th><th>Cadence</th><th>Next run</th>
              <th>Runs</th><th>Auto-post</th><th>Status</th><th></th>
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
                <td>{s.autoPost ? "Yes" : "No"}</td>
                <td>{s.isActive ? <Badge>Active</Badge> : <Badge variant="secondary">Paused</Badge>}</td>
                <td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => act(s.id, "POST")}>Run now</Button>
                  <Button size="sm" variant="ghost" onClick={() => act(s.id, "PATCH", { isActive: !s.isActive })}>
                    {s.isActive ? "Pause" : "Resume"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => act(s.id, "DELETE")}>Delete</Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="py-6 text-center text-muted-foreground">No recurring schedules yet.</td></tr>}
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
    if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? "Could not create"); return; }
    setDraft({ name: "", gracePeriodDays: 0, stages: [BLANK_STAGE] });
    void load();
  };

  const remove = async (id: string) => { await fetch(`/api/dunning/${id}`, { method: "DELETE" }); void load(); };

  const setStage = (i: number, patch: Partial<Stage>) =>
    setDraft({ ...draft, stages: draft.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">New dunning policy</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Policy name</Label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Standard net-30 collections" />
          </div>
          <div>
            <Label>Grace period (days past due)</Label>
            <Input type="number" value={draft.gracePeriodDays} onChange={(e) => setDraft({ ...draft, gracePeriodDays: Number(e.target.value) })} />
          </div>
        </div>
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Reminder ladder</span>
            <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, stages: [...draft.stages, { ...BLANK_STAGE, sequence: draft.stages.length + 1, name: `Reminder ${draft.stages.length + 1}`, offsetDays: (draft.stages.at(-1)?.offsetDays ?? 0) + 14 }] })}>
              + Add stage
            </Button>
          </div>
          {draft.stages.map((s, i) => (
            <div key={i} className="rounded border p-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <div><Label>Name</Label><Input value={s.name} onChange={(e) => setStage(i, { name: e.target.value })} /></div>
                <div><Label>Days past due</Label><Input type="number" value={s.offsetDays} onChange={(e) => setStage(i, { offsetDays: Number(e.target.value) })} /></div>
                <div><Label>Sequence</Label><Input type="number" value={s.sequence} onChange={(e) => setStage(i, { sequence: Number(e.target.value) })} /></div>
              </div>
              <div className="mt-2"><Label>Subject</Label><Input value={s.subjectTemplate} onChange={(e) => setStage(i, { subjectTemplate: e.target.value })} /></div>
              <div className="mt-2">
                <Label>Body</Label>
                <textarea className="w-full rounded border px-2 py-1 text-sm" rows={4} value={s.bodyTemplate} onChange={(e) => setStage(i, { bodyTemplate: e.target.value })} />
              </div>
              {draft.stages.length > 1 && (
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => setDraft({ ...draft, stages: draft.stages.filter((_, j) => j !== i) })}>Remove stage</Button>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Tokens: {"{{party}} {{invoice}} {{amount}} {{dueDate}} {{daysOverdue}} {{orgName}}"}</p>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-3"><Button onClick={create} disabled={!draft.name}>Create policy</Button></div>
      </Card>

      <div className="space-y-3">
        {policies.map((p) => (
          <Card key={p.id} className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium">{p.name}</span>
                <span className="ml-2 text-sm text-muted-foreground">
                  {p.stages.length} stage{p.stages.length === 1 ? "" : "s"} · grace {p.gracePeriodDays}d
                </span>
              </div>
              <div className="flex items-center gap-2">
                {p.isActive ? <Badge>Active</Badge> : <Badge variant="secondary">Off</Badge>}
                <Button size="sm" variant="ghost" onClick={() => remove(p.id)}>Delete</Button>
              </div>
            </div>
            <ul className="mt-2 text-sm text-muted-foreground">
              {[...p.stages].sort((a, b) => a.sequence - b.sequence).map((s) => (
                <li key={s.sequence}>· Day {s.offsetDays}: {s.name}</li>
              ))}
            </ul>
          </Card>
        ))}
        {policies.length === 0 && <p className="text-center text-muted-foreground">No dunning policies yet.</p>}
      </div>
    </div>
  );
}
