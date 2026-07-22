"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Input, Label, Select } from "@openbooks/ui";

interface Project { id: string; name: string; customerName: string | null }
interface Account { id: string; label: string }
interface SovLine {
  id: string; itemNo: string | null; description: string; scheduledValue: string;
  retainagePercent: string | null; incomeAccountId: string | null; changeOrderId: string | null;
}
interface ChangeOrder { id: string; number: string; description: string | null; status: string; amount: string; approvedOn: string | null }
interface PayApp {
  id: string; applicationNumber: number; periodEnd: string; kind: string; status: string;
  retainagePercent: string; invoiceNumber: string | null; invoiceTotal: string | null; invoiceStatus: string | null;
}
interface Data {
  sovLines: SovLine[]; changeOrders: ChangeOrder[]; payApplications: PayApp[];
  contractSum: string; retainageHeld: string; committedCost: number; retainageConfigured: boolean;
}

const money = (v: unknown) => Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function ConstructionClient({
  projects, incomeAccounts, initialProjectId,
}: {
  projects: Project[]; incomeAccounts: Account[]; initialProjectId: string | null;
}) {
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    const r = await fetch(`/api/construction?projectId=${projectId}`);
    if (r.ok) setData(await r.json());
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const post = async (payload: Record<string, unknown>) => {
    setError(null); setMsg(null);
    const r = await fetch("/api/construction", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { setError(body.error ?? "Action failed"); return null; }
    await load();
    return body;
  };

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center gap-3">
        <Label className="shrink-0">Project</Label>
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="max-w-md">
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.customerName ? ` — ${p.customerName}` : ""}</option>)}
        </Select>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {msg && <p className="text-sm text-teal-700 dark:text-teal-300">{msg}</p>}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="p-4"><div className="text-xs text-muted-foreground">Contract sum</div><div className="text-lg font-semibold">{money(data.contractSum)}</div></Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">Retainage held</div><div className="text-lg font-semibold">{money(data.retainageHeld)}</div></Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">Committed cost (open POs)</div><div className="text-lg font-semibold">{money(data.committedCost)}</div></Card>
          </div>
          {!data.retainageConfigured && (
            <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              No Retainage Receivable control account is configured — billing an application with retainage will be blocked until one is set in Company control accounts.
            </p>
          )}

          <SovSection projectId={projectId} lines={data.sovLines} incomeAccounts={incomeAccounts} onChange={post} />
          <ChangeOrderSection projectId={projectId} orders={data.changeOrders} onChange={post} />
          <PayAppSection projectId={projectId} apps={data.payApplications} sov={data.sovLines} onChange={post} setMsg={setMsg} onReload={load} />
          <RetainageReleaseSection projectId={projectId} held={data.retainageHeld} onChange={post} setMsg={setMsg} />
        </>
      )}
    </div>
  );
}

function SovSection({ projectId, lines, incomeAccounts, onChange }: {
  projectId: string; lines: SovLine[]; incomeAccounts: Account[];
  onChange: (p: Record<string, unknown>) => Promise<unknown>;
}) {
  const [f, setF] = useState({ itemNo: "", description: "", scheduledValue: "", retainagePercent: "", incomeAccountId: "" });
  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold">Schedule of Values</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr><th className="py-1">Item</th><th>Description</th><th className="text-right">Scheduled value</th><th className="text-right">Retainage %</th><th></th></tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-t">
                <td className="py-1">{l.itemNo ?? "—"}{l.changeOrderId && <Badge variant="secondary" className="ml-1">CO</Badge>}</td>
                <td>{l.description}</td>
                <td className="text-right tabular-nums">{money(l.scheduledValue)}</td>
                <td className="text-right tabular-nums">{l.retainagePercent ?? "default"}</td>
                <td className="text-right"><Button size="sm" variant="ghost" onClick={() => onChange({ action: "deleteSov", id: l.id })}>Delete</Button></td>
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">No schedule-of-values lines yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-5">
        <Input placeholder="Item #" value={f.itemNo} onChange={(e) => setF({ ...f, itemNo: e.target.value })} />
        <Input placeholder="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className="sm:col-span-2" />
        <Input placeholder="Scheduled value" type="number" value={f.scheduledValue} onChange={(e) => setF({ ...f, scheduledValue: e.target.value })} />
        <Input placeholder="Retainage %" type="number" value={f.retainagePercent} onChange={(e) => setF({ ...f, retainagePercent: e.target.value })} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Select value={f.incomeAccountId} onChange={(e) => setF({ ...f, incomeAccountId: e.target.value })} className="max-w-xs">
          <option value="">Default income account</option>
          {incomeAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </Select>
        <Button
          size="sm"
          disabled={!f.description || !f.scheduledValue}
          onClick={async () => {
            await onChange({ action: "addSov", projectId, ...f, retainagePercent: f.retainagePercent || null, incomeAccountId: f.incomeAccountId || null, sortOrder: lines.length + 1 });
            setF({ itemNo: "", description: "", scheduledValue: "", retainagePercent: "", incomeAccountId: "" });
          }}
        >Add line</Button>
      </div>
    </Card>
  );
}

function ChangeOrderSection({ projectId, orders, onChange }: {
  projectId: string; orders: ChangeOrder[]; onChange: (p: Record<string, unknown>) => Promise<unknown>;
}) {
  const [f, setF] = useState({ number: "", description: "", amount: "" });
  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold">Change orders</h3>
      <ul className="space-y-1 text-sm">
        {orders.map((o) => (
          <li key={o.id} className="flex items-center gap-3 border-t py-1.5">
            <span className="font-medium">CO {o.number}</span>
            <span className="text-muted-foreground">{o.description}</span>
            <span className="tabular-nums">{money(o.amount)}</span>
            {o.status === "approved" ? <Badge>Approved</Badge> : <Badge variant="secondary">Draft</Badge>}
            {o.status === "draft" && (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onChange({ action: "approveChangeOrder", id: o.id })}>Approve</Button>
            )}
          </li>
        ))}
        {orders.length === 0 && <li className="py-2 text-center text-muted-foreground">No change orders.</li>}
      </ul>
      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <Input placeholder="CO number" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
        <Input placeholder="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className="sm:col-span-2" />
        <Input placeholder="Amount" type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
      </div>
      <div className="mt-2">
        <Button size="sm" disabled={!f.number || !f.amount} onClick={async () => { await onChange({ action: "addChangeOrder", projectId, ...f }); setF({ number: "", description: "", amount: "" }); }}>Add change order</Button>
      </div>
    </Card>
  );
}

function PayAppSection({ projectId, apps, sov, onChange, setMsg, onReload }: {
  projectId: string; apps: PayApp[]; sov: SovLine[];
  onChange: (p: Record<string, unknown>) => Promise<unknown>;
  setMsg: (m: string | null) => void; onReload: () => Promise<void>;
}) {
  const [periodEnd, setPeriodEnd] = useState("");
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, { thisPeriodCompleted: string; materialsStored: string }>>({});

  const openDraws = async (appId: string) => {
    setOpenApp(openApp === appId ? null : appId);
    setLines({});
  };

  const bill = async (appId: string) => {
    // Persist any entered draws first.
    for (const [sovLineId, v] of Object.entries(lines)) {
      await onChange({ action: "updatePayAppLine", payApplicationId: appId, sovLineId, thisPeriodCompleted: v.thisPeriodCompleted || "0", materialsStored: v.materialsStored || "0" });
    }
    const r = (await onChange({ action: "billPayApp", payApplicationId: appId })) as any;
    if (r?.invoiceId) setMsg(`Billed ${r.documentNumber} — current due ${money(r.currentDue)}, retainage ${money(r.retainage)}`);
    setOpenApp(null);
    await onReload();
  };

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold">Applications for Payment</h3>
      <ul className="space-y-1 text-sm">
        {apps.map((a) => (
          <li key={a.id} className="border-t py-1.5">
            <div className="flex items-center gap-3">
              <span className="font-medium">App #{a.applicationNumber}</span>
              <span className="text-muted-foreground">{a.periodEnd}</span>
              {a.kind === "retainage_release" && <Badge variant="secondary">Retainage</Badge>}
              {a.status === "posted"
                ? <Badge>Billed{a.invoiceNumber ? ` · ${a.invoiceNumber}` : ""}</Badge>
                : <Badge variant="secondary">{a.status}</Badge>}
              {a.invoiceTotal && <span className="tabular-nums">{money(a.invoiceTotal)}</span>}
              {a.status !== "posted" && (
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => openDraws(a.id)}>{openApp === a.id ? "Hide draws" : "Enter draws"}</Button>
                  <Button size="sm" onClick={() => bill(a.id)}>Bill</Button>
                </span>
              )}
            </div>
            {openApp === a.id && (
              <table className="mt-2 w-full text-xs">
                <thead className="text-left text-muted-foreground"><tr><th>Item</th><th>Description</th><th className="text-right">Work this period</th><th className="text-right">Materials stored</th></tr></thead>
                <tbody>
                  {sov.map((s) => (
                    <tr key={s.id} className="border-t">
                      <td className="py-1">{s.itemNo ?? "—"}</td>
                      <td>{s.description}</td>
                      <td className="text-right"><Input type="number" className="h-7 w-28 text-right" value={lines[s.id]?.thisPeriodCompleted ?? ""} onChange={(e) => setLines({ ...lines, [s.id]: { ...(lines[s.id] ?? { thisPeriodCompleted: "", materialsStored: "" }), thisPeriodCompleted: e.target.value } })} /></td>
                      <td className="text-right"><Input type="number" className="h-7 w-28 text-right" value={lines[s.id]?.materialsStored ?? ""} onChange={(e) => setLines({ ...lines, [s.id]: { ...(lines[s.id] ?? { thisPeriodCompleted: "", materialsStored: "" }), materialsStored: e.target.value } })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        ))}
        {apps.length === 0 && <li className="py-2 text-center text-muted-foreground">No applications yet.</li>}
      </ul>
      <div className="mt-3 flex items-center gap-2">
        <Label className="shrink-0">Period ending</Label>
        <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="max-w-xs" />
        <Button size="sm" disabled={!periodEnd || sov.length === 0} onClick={() => onChange({ action: "createPayApp", projectId, periodEnd })}>New application</Button>
      </div>
    </Card>
  );
}

function RetainageReleaseSection({ projectId, held, onChange, setMsg }: {
  projectId: string; held: string; onChange: (p: Record<string, unknown>) => Promise<unknown>;
  setMsg: (m: string | null) => void;
}) {
  const [amount, setAmount] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  return (
    <Card className="p-4">
      <h3 className="mb-1 text-sm font-semibold">Release retainage</h3>
      <p className="mb-3 text-xs text-muted-foreground">Bills held retainage into collectible AR. Held: {money(held)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="number" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} className="max-w-40" />
        <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="max-w-xs" />
        <Button
          size="sm"
          disabled={!amount || !periodEnd || Number(amount) <= 0}
          onClick={async () => {
            const r = (await onChange({ action: "releaseRetainage", projectId, amount, periodEnd })) as any;
            if (r?.invoiceId) { setMsg(`Retainage release invoice ${r.documentNumber} for ${money(r.amount)} created`); setAmount(""); }
          }}
        >Release</Button>
      </div>
    </Card>
  );
}
