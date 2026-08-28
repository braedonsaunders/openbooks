"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  cn,
} from "@openbooks/ui";
import { useBusinessToday } from "@/components/business-date-provider";
import { useMoney } from "@/components/money-provider";
import { decimalAdd, decimalCmp, decimalNeg, decimalSum } from "../../../lib/statement-format";

type Option = { id: string; name: string; currency?: string | null };
type Permissions = { create: boolean; approve: boolean; post: boolean; pay: boolean };
type Summary = {
  id: string; number: string; title: string; status: string; currency: string;
  originalCommitment: string; revisedCommitment: string; billedToDate: string;
  retainageWithheld: string; projectName: string; vendorName: string;
};
type Money = (value: string | number, currency?: string) => string;
type Action = (
  payload: Record<string, unknown>,
  success: string,
) => Promise<Record<string, unknown> | null>;
type Subcontract = Summary & {
  description: string | null;
  defaultRetainagePercent: string;
  startsOn: string | null;
  endsOn: string | null;
};
type SovLine = {
  id: string;
  itemNo: string | null;
  description: string;
  scheduledValue: string;
  earnedToDate: string;
  expenseAccountId: string | null;
};
type ChangeOrder = {
  id: string;
  number: string;
  description: string | null;
  status: string;
  amount: string;
  independentApprovalAllowed: boolean;
};
type PayApplication = {
  id: string;
  applicationNumber: number;
  periodEnd: string;
  status: string;
  vendorBillStatus: string | null;
  grossThisPeriod: string;
  retainageThisPeriod: string;
  netDue: string;
  independentApprovalAllowed: boolean;
  vendorBillDocumentId: string | null;
  vendorBillNumber: string | null;
};
type PayApplicationLine = {
  payApplicationId: string;
  sovLineId: string;
  itemNo: string | null;
  description: string;
  scheduledValue: string;
  previousEarned: string;
  workCompletedThisPeriod: string;
  materialsStoredCurrent: string;
};
type PaymentControl = {
  id: string;
  controlType: string;
  reason: string;
  jointPayeeName: string | null;
  effectiveOn: string;
  expiresOn: string | null;
  amountLimit: string | null;
  status: string;
};
type RetainageRelease = {
  id: string;
  periodEnd: string;
  amount: string;
  vendorBillDocumentId: string;
  vendorBillNumber: string;
  vendorBillStatus: string;
};
type Detail = {
  subcontract: Subcontract;
  sovLines: SovLine[];
  changeOrders: ChangeOrder[];
  payApplications: PayApplication[];
  payApplicationLines: PayApplicationLine[];
  paymentControls: PaymentControl[];
  retainageReleases: RetainageRelease[];
};
type Tab = "overview" | "sov" | "changes" | "applications" | "retainage" | "controls";

function sumSubcontractAmounts(values: readonly string[]): string {
  return decimalSum(values);
}

function subtractSubcontractAmounts(left: string, right: string): string {
  return decimalAdd(left, decimalNeg(right));
}

async function api(payload: Record<string, unknown>) {
  const response = await fetch("/api/subcontracts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Subcontract action failed");
  return body;
}

export function SubcontractsWorkspace({
  projects,
  vendors,
  expenseAccounts,
  parties,
  permissions,
  multiCurrency = false,
}: {
  projects: Option[];
  vendors: Option[];
  expenseAccounts: Option[];
  parties: Option[];
  permissions: Permissions;
  multiCurrency?: boolean;
}) {
  const { money: localizedMoney } = useMoney();
  const money = useCallback(
    (value: string | number, currency?: string) => localizedMoney(value, currency ? { currency } : undefined),
    [localizedMoney],
  );
  const [rows, setRows] = useState<Summary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/subcontracts", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load subcontracts");
      setRows(body.subcontracts);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load subcontracts");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const response = await fetch(`/api/subcontracts?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not load subcontract");
    setDetail(body);
  }, []);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    void loadDetail(selectedId).catch((error) => toast.error(error.message));
  }, [selectedId, loadDetail]);

  const act = async (payload: Record<string, unknown>, success: string) => {
    if (busy) return null;
    setBusy(true);
    try {
      const result = await api(payload);
      toast.success(success);
      await Promise.all([loadList(), selectedId ? loadDetail(selectedId) : Promise.resolve()]);
      return result;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed");
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between gap-4 border-b border-slate-200 p-4 dark:border-slate-800">
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Subcontract register</div>
              <div className="mt-1 text-xs text-slate-500">Original and revised commitments remain visible beside billed progress.</div>
            </div>
            {permissions.create ? <Button onClick={() => setCreateOpen(true)}>New subcontract</Button> : null}
          </div>
          {loading ? <div className="p-10 text-center text-sm text-slate-500">Loading subcontracts…</div> : rows.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">No subcontracts yet</p>
              <p className="mt-1 text-sm text-slate-500">Create the vendor commitment before entering its schedule of values.</p>
              {permissions.create ? <Button className="mt-4" onClick={() => setCreateOpen(true)}>New subcontract</Button> : null}
            </div>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Number</TableHead><TableHead>Subcontract</TableHead><TableHead>Project</TableHead><TableHead>Vendor</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Revised</TableHead><TableHead className="text-right">Billed</TableHead></TableRow></TableHeader>
              <TableBody>{rows.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => { setSelectedId(row.id); setTab("overview"); }}>
                  <TableCell className="font-medium">{row.number}</TableCell><TableCell>{row.title}</TableCell><TableCell>{row.projectName}</TableCell><TableCell>{row.vendorName}</TableCell>
                  <TableCell><StatusBadge status={row.status} /></TableCell><TableCell className="text-right tabular-nums">{money(row.revisedCommitment, row.currency)}</TableCell><TableCell className="text-right tabular-nums">{money(row.billedToDate, row.currency)}</TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CreateSubcontractDrawer open={createOpen} onClose={() => setCreateOpen(false)} projects={projects} vendors={vendors} busy={busy} multiCurrency={multiCurrency} onCreate={async (payload) => {
        const result = await act({ action: "createSubcontract", ...payload }, "Subcontract created");
        if (result?.id) { setCreateOpen(false); setSelectedId(result.id); setTab("sov"); }
      }} />

      <Drawer open={!!selectedId} onClose={() => setSelectedId(null)} size="2xl" title={detail ? `${detail.subcontract.number} · ${detail.subcontract.title}` : "Subcontract"} description={detail ? `${detail.subcontract.projectName} · ${detail.subcontract.vendorName}` : "Loading…"}>
        {detail ? (
          <div className="space-y-5 p-1">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <StatusBadge status={detail.subcontract.status} />
              <LifecycleActions detail={detail} permissions={permissions} busy={busy} act={act} />
            </div>
            <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800" role="tablist">
              {(["overview", "sov", "changes", "applications", "retainage", "controls"] as Tab[]).map((key) => (
                <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium capitalize", tab === key ? "border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300" : "border-transparent text-slate-500")}>{key}</button>
              ))}
            </nav>
            {tab === "overview" ? <Overview detail={detail} money={money} canEdit={permissions.create} busy={busy} act={act} /> : null}
            {tab === "sov" ? <SovSection detail={detail} accounts={expenseAccounts} canCreate={permissions.create} busy={busy} act={act} money={money} /> : null}
            {tab === "changes" ? <ChangesSection detail={detail} permissions={permissions} busy={busy} act={act} money={money} /> : null}
            {tab === "applications" ? <ApplicationsSection detail={detail} permissions={permissions} busy={busy} act={act} money={money} /> : null}
            {tab === "retainage" ? <RetainageSection detail={detail} canPost={permissions.post} busy={busy} act={act} money={money} /> : null}
            {tab === "controls" ? <ControlsSection detail={detail} parties={parties} canPay={permissions.pay} busy={busy} act={act} money={money} /> : null}
          </div>
        ) : <div className="p-10 text-center text-sm text-slate-500">Loading subcontract…</div>}
      </Drawer>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = ["active", "approved", "billed", "posted"].includes(status) ? "success" : ["pending_approval", "submitted"].includes(status) ? "warning" : status === "void" ? "destructive" : "secondary";
  return <Badge variant={(tone)}>{status.replaceAll("_", " ")}</Badge>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-4"><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-xl font-semibold tabular-nums">{value}</div></CardContent></Card>;
}

function Overview({ detail, money, canEdit, busy, act }: { detail: Detail; money: Money; canEdit: boolean; busy: boolean; act: Action }) {
  const s = detail.subcontract;
  const billed = sumSubcontractAmounts(detail.payApplications.filter((app) => app.status === "billed").map((app) => app.grossThisPeriod));
  const [form, setForm] = useState({ title: s.title, description: s.description || "", originalCommitment: s.originalCommitment, defaultRetainagePercent: s.defaultRetainagePercent, startsOn: s.startsOn || "", endsOn: s.endsOn || "" });
  return <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-3"><Metric label="Original commitment" value={money(s.originalCommitment, s.currency)} /><Metric label="Revised commitment" value={money(s.revisedCommitment, s.currency)} /><Metric label="Gross billed" value={money(billed, s.currency)} /></div><Card><CardContent className="grid gap-4 p-4 sm:grid-cols-2"><Read label="Project" value={s.projectName} /><Read label="Vendor" value={s.vendorName} /><Read label="Retainage" value={`${s.defaultRetainagePercent}%`} /><Read label="Term" value={[s.startsOn, s.endsOn].filter(Boolean).join(" – ") || "Not set"} /><div className="sm:col-span-2"><Read label="Description" value={s.description || "—"} /></div></CardContent></Card>{s.status === "draft" && canEdit ? <Card><CardContent className="space-y-3 p-4"><div><div className="text-sm font-semibold">Edit draft terms</div><div className="mt-1 text-xs text-slate-500">Commercial terms lock when the subcontract is submitted.</div></div><div className="grid gap-3 sm:grid-cols-2"><Field label="Title"><Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field><Field label="Original commitment"><Input type="number" min="0" step="0.01" value={form.originalCommitment} onChange={(event) => setForm({ ...form, originalCommitment: event.target.value })} /></Field><Field label="Retainage %"><Input type="number" min="0" max="100" value={form.defaultRetainagePercent} onChange={(event) => setForm({ ...form, defaultRetainagePercent: event.target.value })} /></Field><Field label="Starts"><Input type="date" value={form.startsOn} onChange={(event) => setForm({ ...form, startsOn: event.target.value })} /></Field><Field label="Ends"><Input type="date" value={form.endsOn} onChange={(event) => setForm({ ...form, endsOn: event.target.value })} /></Field><div className="sm:col-span-2"><Field label="Description"><Textarea rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field></div></div><Button size="sm" disabled={busy || !form.title || !form.originalCommitment} onClick={() => act({ action: "updateSubcontract", id: s.id, ...form, startsOn: form.startsOn || null, endsOn: form.endsOn || null }, "Draft terms updated")}>Save terms</Button></CardContent></Card> : null}</div>;
}
function Read({ label, value }: { label: string; value: string }) { return <div><div className="text-xs font-medium text-slate-500">{label}</div><div className="mt-1 text-sm text-slate-900 dark:text-slate-100">{value}</div></div>; }

function LifecycleActions({ detail, permissions, busy, act }: { detail: Detail; permissions: Permissions; busy: boolean; act: Action }) {
  const s = detail.subcontract;
  return <div className="flex flex-wrap gap-2">
    {s.status === "draft" && permissions.create ? <Button size="sm" disabled={busy} onClick={() => act({ action: "submitSubcontract", id: s.id }, "Submitted for approval")}>Submit</Button> : null}
    {s.status === "pending_approval" && permissions.approve ? <Button size="sm" disabled={busy} onClick={() => act({ action: "approveSubcontract", id: s.id }, "Subcontract approved")}>Approve</Button> : null}
    {s.status === "active" && permissions.create ? <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "transitionSubcontract", id: s.id, transition: "substantially_complete" }, "Marked substantially complete")}>Substantially complete</Button> : null}
    {s.status === "substantially_complete" && permissions.create ? <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "transitionSubcontract", id: s.id, transition: "close" }, "Subcontract closed")}>Close</Button> : null}
    {["draft", "pending_approval"].includes(s.status) && permissions.create ? <Button size="sm" variant="destructive" disabled={busy} onClick={() => act({ action: "transitionSubcontract", id: s.id, transition: "void" }, "Subcontract voided")}>Void</Button> : null}
  </div>;
}

function SovSection({ detail, accounts, canCreate, busy, act, money }: { detail: Detail; accounts: Option[]; canCreate: boolean; busy: boolean; act: Action; money: Money }) {
  const editable = detail.subcontract.status === "draft" && canCreate;
  const [form, setForm] = useState({ itemNo: "", description: "", scheduledValue: "", retainagePercent: "", expenseAccountId: "" });
  const total = sumSubcontractAmounts(detail.sovLines.map((line) => line.scheduledValue));
  return <div className="space-y-4"><div className="flex justify-between text-sm"><span className="text-slate-500">Vendor SOV total</span><span className="font-semibold tabular-nums">{money(total, detail.subcontract.currency)}</span></div><Table><TableHeader><TableRow><TableHead>Item</TableHead><TableHead>Description</TableHead><TableHead className="text-right">Scheduled</TableHead><TableHead className="text-right">Earned</TableHead><TableHead>Account</TableHead>{editable ? <TableHead /> : null}</TableRow></TableHeader><TableBody>{detail.sovLines.map((line) => <TableRow key={line.id}><TableCell>{line.itemNo || "—"}</TableCell><TableCell>{line.description}</TableCell><TableCell className="text-right tabular-nums">{money(line.scheduledValue, detail.subcontract.currency)}</TableCell><TableCell className="text-right tabular-nums">{money(line.earnedToDate, detail.subcontract.currency)}</TableCell><TableCell>{accounts.find((a) => a.id === line.expenseAccountId)?.name || "Vendor default"}</TableCell>{editable ? <TableCell><Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: "removeSovLine", id: line.id }, "SOV line removed")}>Remove</Button></TableCell> : null}</TableRow>)}</TableBody></Table>{editable ? <Card><CardContent className="space-y-3 p-4"><div className="text-sm font-semibold">Add SOV line</div><div className="grid gap-3 sm:grid-cols-2"><Field label="Item"><Input value={form.itemNo} onChange={(e) => setForm({ ...form, itemNo: e.target.value })} /></Field><Field label="Description"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field><Field label="Scheduled value"><Input type="number" min="0" step="0.01" value={form.scheduledValue} onChange={(e) => setForm({ ...form, scheduledValue: e.target.value })} /></Field><Field label="Retainage override %"><Input type="number" min="0" max="100" value={form.retainagePercent} onChange={(e) => setForm({ ...form, retainagePercent: e.target.value })} /></Field><Field label="Expense account"><Select value={form.expenseAccountId} onChange={(e) => setForm({ ...form, expenseAccountId: e.target.value })}><option value="">Vendor default</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field></div><Button size="sm" disabled={busy || !form.description || !form.scheduledValue} onClick={async () => { const ok = await act({ action: "addSovLine", subcontractId: detail.subcontract.id, ...form, retainagePercent: form.retainagePercent || null, expenseAccountId: form.expenseAccountId || null }, "SOV line added"); if (ok) setForm({ itemNo: "", description: "", scheduledValue: "", retainagePercent: "", expenseAccountId: "" }); }}>Add line</Button></CardContent></Card> : null}</div>;
}

function ChangesSection({ detail, permissions, busy, act, money }: { detail: Detail; permissions: Permissions; busy: boolean; act: Action; money: Money }) {
  const today = useBusinessToday();
  const allowed = ["active", "substantially_complete"].includes(detail.subcontract.status) && permissions.create;
  const [form, setForm] = useState({ number: "", description: "", amount: "", targetSovLineId: "" });
  return <div className="space-y-4"><Table><TableHeader><TableRow><TableHead>Number</TableHead><TableHead>Description</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Amount</TableHead><TableHead /></TableRow></TableHeader><TableBody>{detail.changeOrders.map((co) => <TableRow key={co.id}><TableCell className="font-medium">{co.number}</TableCell><TableCell>{co.description || "—"}</TableCell><TableCell><StatusBadge status={co.status} /></TableCell><TableCell className="text-right">{money(co.amount, detail.subcontract.currency)}</TableCell><TableCell className="space-x-2 text-right">{co.status === "draft" && permissions.approve && co.independentApprovalAllowed ? <Button size="sm" disabled={busy} onClick={() => act({ action: "approveChangeOrder", id: co.id, approvedOn: today }, "Change order approved")}>Approve</Button> : null}{co.status === "draft" && permissions.create ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: "voidChangeOrder", id: co.id }, "Change order voided")}>Void</Button> : null}</TableCell></TableRow>)}</TableBody></Table>{allowed ? <Card><CardContent className="space-y-3 p-4"><div className="text-sm font-semibold">New change order</div><div className="grid gap-3 sm:grid-cols-2"><Field label="Number"><Input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} /></Field><Field label="Amount"><Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field><Field label="Target SOV line"><Select value={form.targetSovLineId} onChange={(e) => setForm({ ...form, targetSovLineId: e.target.value })}><option value="">Create a new SOV line</option>{detail.sovLines.map((line) => <option key={line.id} value={line.id}>{line.itemNo || line.description} · {line.description}</option>)}</Select></Field><Field label="Description"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field></div><Button size="sm" disabled={busy || !form.number || !form.amount} onClick={async () => { const ok = await act({ action: "addChangeOrder", subcontractId: detail.subcontract.id, ...form, targetSovLineId: form.targetSovLineId || null }, "Change order created"); if (ok) setForm({ number: "", description: "", amount: "", targetSovLineId: "" }); }}>Create change order</Button></CardContent></Card> : null}</div>;
}

function ApplicationsSection({ detail, permissions, busy, act, money }: { detail: Detail; permissions: Permissions; busy: boolean; act: Action; money: Money }) {
  const [periodEnd, setPeriodEnd] = useState(useBusinessToday());
  const [vendorInvoiceNumber, setVendorInvoiceNumber] = useState("");
  const open = detail.payApplications.find((app) => ["draft", "submitted", "approved"].includes(app.status));
  return <div className="space-y-4">{!open && permissions.create && ["active", "substantially_complete"].includes(detail.subcontract.status) ? <Card><CardContent className="flex flex-wrap items-end gap-3 p-4"><Field label="Period ending"><Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></Field><Field label="Vendor invoice number"><Input value={vendorInvoiceNumber} onChange={(e) => setVendorInvoiceNumber(e.target.value)} /></Field><Button disabled={busy} onClick={() => act({ action: "createPayApplication", subcontractId: detail.subcontract.id, periodEnd, vendorInvoiceNumber: vendorInvoiceNumber || null }, "Vendor application created")}>New application</Button></CardContent></Card> : null}{open?.status === "draft" ? <PayApplicationEditor app={open} lines={detail.payApplicationLines.filter((line) => line.payApplicationId === open.id)} busy={busy} act={act} currency={detail.subcontract.currency} money={money} /> : null}<Table><TableHeader><TableRow><TableHead>Application</TableHead><TableHead>Period ending</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Gross</TableHead><TableHead className="text-right">Retainage</TableHead><TableHead className="text-right">Net due</TableHead><TableHead /></TableRow></TableHeader><TableBody>{detail.payApplications.map((app) => <TableRow key={app.id}><TableCell>#{app.applicationNumber}</TableCell><TableCell>{app.periodEnd}</TableCell><TableCell><StatusBadge status={app.vendorBillStatus === "posted" ? "posted" : app.status} /></TableCell><TableCell className="text-right">{money(app.grossThisPeriod, detail.subcontract.currency)}</TableCell><TableCell className="text-right">{money(app.retainageThisPeriod, detail.subcontract.currency)}</TableCell><TableCell className="text-right">{money(app.netDue, detail.subcontract.currency)}</TableCell><TableCell className="space-x-2 text-right">{app.status === "submitted" && permissions.approve && app.independentApprovalAllowed ? <Button size="sm" disabled={busy} onClick={() => act({ action: "approvePayApplication", id: app.id }, "Application approved")}>Approve</Button> : null}{app.status === "approved" && permissions.post ? <Button size="sm" disabled={busy} onClick={() => act({ action: "createVendorBill", id: app.id }, "Draft vendor bill created")}>Create bill</Button> : null}{app.vendorBillDocumentId ? <Button asChild size="sm" variant="outline"><Link href={`/ap/bills?doc=${app.vendorBillDocumentId}`}>{app.vendorBillNumber || "Open bill"}</Link></Button> : null}{["draft", "submitted", "approved"].includes(app.status) && permissions.create ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: "voidPayApplication", id: app.id }, "Application voided")}>Void</Button> : null}</TableCell></TableRow>)}</TableBody></Table></div>;
}

function PayApplicationEditor({ app, lines, busy, act, currency, money }: { app: PayApplication; lines: PayApplicationLine[]; busy: boolean; act: Action; currency: string; money: Money }) {
  const [values, setValues] = useState<Record<string, { work: string; stored: string }>>(() => Object.fromEntries(lines.map((line) => [line.sovLineId, { work: line.workCompletedThisPeriod, stored: line.materialsStoredCurrent }])));
  const save = () => act({ action: "updatePayApplication", payApplicationId: app.id, lines: lines.map((line) => ({ sovLineId: line.sovLineId, workCompletedThisPeriod: values[line.sovLineId]?.work || "0", materialsStoredCurrent: values[line.sovLineId]?.stored || "0" })) }, "Application lines saved");
  return <Card><CardContent className="space-y-3 p-4"><div className="flex items-center justify-between"><div><div className="text-sm font-semibold">Application #{app.applicationNumber}</div><div className="text-xs text-slate-500">Stored material is a cumulative balance; installed work offsets reductions.</div></div><div className="space-x-2"><Button size="sm" variant="outline" disabled={busy} onClick={save}>Save</Button><Button size="sm" disabled={busy} onClick={async () => { const ok = await save(); if (ok) await act({ action: "submitPayApplication", id: app.id }, "Application submitted"); }}>Save & submit</Button></div></div><Table><TableHeader><TableRow><TableHead>SOV line</TableHead><TableHead className="text-right">Scheduled</TableHead><TableHead className="text-right">Previous earned</TableHead><TableHead>Work this period</TableHead><TableHead>Stored current</TableHead></TableRow></TableHeader><TableBody>{lines.map((line) => <TableRow key={line.sovLineId}><TableCell>{line.itemNo || "—"} · {line.description}</TableCell><TableCell className="text-right">{money(line.scheduledValue, currency)}</TableCell><TableCell className="text-right">{money(line.previousEarned, currency)}</TableCell><TableCell><Input type="number" min="0" step="0.01" value={values[line.sovLineId]?.work || ""} onChange={(e) => setValues({ ...values, [line.sovLineId]: { work: e.target.value, stored: values[line.sovLineId]?.stored ?? "" } })} /></TableCell><TableCell><Input type="number" min="0" step="0.01" value={values[line.sovLineId]?.stored || ""} onChange={(e) => setValues({ ...values, [line.sovLineId]: { work: values[line.sovLineId]?.work ?? "", stored: e.target.value } })} /></TableCell></TableRow>)}</TableBody></Table></CardContent></Card>;
}

function RetainageSection({ detail, canPost, busy, act, money }: { detail: Detail; canPost: boolean; busy: boolean; act: Action; money: Money }) {
  const [amount, setAmount] = useState(""); const [periodEnd, setPeriodEnd] = useState(useBusinessToday());
  const postedHeld = sumSubcontractAmounts(detail.payApplications.filter((app) => app.vendorBillStatus === "posted").map((app) => app.retainageThisPeriod));
  const released = sumSubcontractAmounts(detail.retainageReleases.filter((release) => release.vendorBillStatus !== "voided").map((release) => release.amount));
  const available = subtractSubcontractAmounts(postedHeld, released);
  return <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-3"><Metric label="Posted retainage" value={money(postedHeld, detail.subcontract.currency)} /><Metric label="Released or reserved" value={money(released, detail.subcontract.currency)} /><Metric label="Available" value={money(available, detail.subcontract.currency)} /></div>{canPost && decimalCmp(available, "0") > 0 ? <Card><CardContent className="flex flex-wrap items-end gap-3 p-4"><Field label="Release amount"><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field><Field label="Bill date"><Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></Field><Button disabled={busy || !amount} onClick={() => act({ action: "releaseRetainage", subcontractId: detail.subcontract.id, periodEnd, amount }, "Retainage-release bill created")}>Create release bill</Button></CardContent></Card> : null}<Table><TableHeader><TableRow><TableHead>Date</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Vendor bill</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{detail.retainageReleases.map((release) => <TableRow key={release.id}><TableCell>{release.periodEnd}</TableCell><TableCell className="text-right">{money(release.amount, detail.subcontract.currency)}</TableCell><TableCell><Link className="text-teal-700 hover:underline" href={`/ap/bills?doc=${release.vendorBillDocumentId}`}>{release.vendorBillNumber}</Link></TableCell><TableCell><StatusBadge status={release.vendorBillStatus} /></TableCell></TableRow>)}</TableBody></Table></div>;
}

function ControlsSection({ detail, parties, canPay, busy, act, money }: { detail: Detail; parties: Option[]; canPay: boolean; busy: boolean; act: Action; money: Money }) {
  const today = useBusinessToday();
  const [form, setForm] = useState({ controlType: "payment_hold", jointPayeePartyId: "", amountLimit: "", reason: "", effectiveOn: today, expiresOn: "" });
  const [releaseId, setReleaseId] = useState<string | null>(null);
  const [releaseReason, setReleaseReason] = useState("");
  return <div className="space-y-4">
    <p className="text-sm text-slate-500">Active controls block ordinary vendor payments. A joint-check instruction must be handled through a joint-payee disbursement or explicitly released.</p>
    <Table><TableHeader><TableRow><TableHead>Control</TableHead><TableHead>Reason / joint payee</TableHead><TableHead>Effective</TableHead><TableHead>Ordinary-payment cap</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader><TableBody>{detail.paymentControls.map((control) => <TableRow key={control.id}><TableCell>{control.controlType.replaceAll("_", " ")}</TableCell><TableCell>{control.reason}{control.jointPayeeName ? ` · ${control.jointPayeeName}` : ""}</TableCell><TableCell>{control.effectiveOn}{control.expiresOn ? ` – ${control.expiresOn}` : ""}</TableCell><TableCell>{control.amountLimit ? money(control.amountLimit, detail.subcontract.currency) : "None (block all)"}</TableCell><TableCell><StatusBadge status={control.status} /></TableCell><TableCell>{control.status === "active" && canPay ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { setReleaseId(control.id); setReleaseReason(""); }}>Release</Button> : null}</TableCell></TableRow>)}</TableBody></Table>
    {canPay ? <Card><CardContent className="space-y-3 p-4"><div><div className="text-sm font-semibold">Add payment control</div><div className="text-xs text-muted-foreground">Leave the cap blank to block every ordinary payment. With a cap, larger payments require release or the recorded joint-check workflow.</div></div><div className="grid gap-3 sm:grid-cols-2"><Field label="Control type"><Select value={form.controlType} onChange={(e) => setForm({ ...form, controlType: e.target.value })}><option value="payment_hold">Payment hold</option><option value="joint_check">Joint check</option></Select></Field>{form.controlType === "joint_check" ? <Field label="Joint payee"><Select value={form.jointPayeePartyId} onChange={(e) => setForm({ ...form, jointPayeePartyId: e.target.value })}><option value="">Select joint payee</option>{parties.map((p: Option) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field> : null}<Field label="Reason"><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field><Field label="Ordinary-payment cap"><Input type="number" min="0" step="0.01" value={form.amountLimit} onChange={(e) => setForm({ ...form, amountLimit: e.target.value })} /></Field><Field label="Effective"><Input type="date" value={form.effectiveOn} onChange={(e) => setForm({ ...form, effectiveOn: e.target.value })} /></Field><Field label="Expires"><Input type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} /></Field></div><Button disabled={busy || !form.reason || (form.controlType === "joint_check" && !form.jointPayeePartyId)} onClick={() => act({ action: "addPaymentControl", subcontractId: detail.subcontract.id, ...form, jointPayeePartyId: form.controlType === "joint_check" ? form.jointPayeePartyId : null, amountLimit: form.amountLimit || null, expiresOn: form.expiresOn || null }, "Payment control added")}>Add control</Button></CardContent></Card> : null}
    <Drawer
      open={releaseId !== null}
      onClose={() => setReleaseId(null)}
      size="sm"
      title="Release payment control"
      description="Document why this control no longer blocks payment. The reason is retained in the audit trail."
      headerActions={<><Button variant="outline" onClick={() => setReleaseId(null)}>Cancel</Button><Button disabled={busy || !releaseReason.trim()} onClick={async () => { if (!releaseId) return; const ok = await act({ action: "releasePaymentControl", id: releaseId, releaseReason }, "Payment control released"); if (ok) setReleaseId(null); }}>Release control</Button></>}
    >
      <Field label="Release reason"><Textarea rows={5} autoFocus value={releaseReason} onChange={(event) => setReleaseReason(event.target.value)} /></Field>
    </Drawer>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>; }

function CreateSubcontractDrawer({ open, onClose, projects, vendors, busy, onCreate, multiCurrency = false }: { open: boolean; onClose: () => void; projects: Option[]; vendors: Option[]; busy: boolean; onCreate: (value: Record<string, string | null>) => void; multiCurrency?: boolean }) {
  const [form, setForm] = useState({ projectId: "", vendorId: "", number: "", title: "", description: "", currency: "", originalCommitment: "", defaultRetainagePercent: "10", startsOn: "", endsOn: "" });
  const vendorCurrency = useMemo(() => vendors.find((v) => v.id === form.vendorId)?.currency || "", [vendors, form.vendorId]);
  return <Drawer open={open} onClose={onClose} size="md" title="New subcontract" description="Create the commitment, then add its vendor schedule of values." headerActions={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !form.projectId || !form.vendorId || !form.number || !form.title || !form.originalCommitment} onClick={() => { const { currency, ...fields } = form; onCreate({ ...fields, ...(multiCurrency ? { currency: currency || vendorCurrency || null } : {}), startsOn: form.startsOn || null, endsOn: form.endsOn || null }); }}>Create</Button></>}><div className="grid gap-4 p-1 sm:grid-cols-2"><Field label="Project"><Select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}><option value="">Select project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field><Field label="Vendor"><Select value={form.vendorId} onChange={(e) => setForm({ ...form, vendorId: e.target.value })}><option value="">Select vendor</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field><Field label="Number"><Input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} /></Field><Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field><Field label="Original commitment"><Input type="number" min="0" step="0.01" value={form.originalCommitment} onChange={(e) => setForm({ ...form, originalCommitment: e.target.value })} /></Field><Field label="Retainage %"><Input type="number" min="0" max="100" value={form.defaultRetainagePercent} onChange={(e) => setForm({ ...form, defaultRetainagePercent: e.target.value })} /></Field>{multiCurrency ? <Field label="Currency"><Input maxLength={3} placeholder={vendorCurrency || "Org currency"} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></Field> : null}<Field label="Starts"><Input type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} /></Field><Field label="Ends"><Input type="date" value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} /></Field><div className="sm:col-span-2"><Field label="Description"><Textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field></div></div></Drawer>;
}
