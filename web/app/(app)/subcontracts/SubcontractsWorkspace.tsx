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
import { useTranslations } from "next-intl";
import {
  decimalAdd,
  decimalCmp,
  decimalNeg,
  decimalSum,
} from "../../../lib/statement-format";
import { readApiErrorMessage } from "../../../lib/api-error";

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
  revision: number;
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

async function api(payload: Record<string, unknown>, fallback: string) {
  const response = await fetch("/api/subcontracts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    // The status is checked before the body parses, and a stale revision
    // token is a conflict (409): carry the status so the caller can reload
    // the other editor's values instead of leaving the form on the state
    // the conflict just invalidated.
    throw Object.assign(new Error(await readApiErrorMessage(response, fallback)), { status: response.status });
  }
  return response.json().catch(() => ({}));
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
  const t = useTranslations("subcontracts");
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

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body. The loading reset lives
  // with the triggers (the mount initializer above, and the mutation reload)
  // instead of a mount effect.
  const loadList = useCallback(() => {
    return fetch("/api/subcontracts", { cache: "no-store" })
      .then(async (response) => {
        // The status is checked before the body parses: a non-JSON 502 page
        // must toast the translated fallback, never a SyntaxError.
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t("errors.listFailed")));
        setRows((await response.json()).subcontracts);
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : t("errors.listFailed"));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [t]);

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body.
  const loadDetail = useCallback((id: string) => {
    return fetch(`/api/subcontracts?id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t("errors.detailFailed")));
        setDetail(await response.json());
      });
  }, [t]);

  useEffect(() => { void loadList(); }, [loadList]);
  // Clear the detail while loading another subcontract, during render (same
  // committed values, no extra render).
  const [prevSelectedId, setPrevSelectedId] = useState(selectedId);
  if (prevSelectedId !== selectedId) {
    setPrevSelectedId(selectedId);
    setDetail(null);
  }
  useEffect(() => {
    if (!selectedId) return;
    void loadDetail(selectedId).catch((error) => toast.error(error.message));
  }, [selectedId, loadDetail]);

  const act = async (payload: Record<string, unknown>, success: string) => {
    if (busy) return null;
    setBusy(true);
    try {
      const result = await api(payload, t("errors.actionFailed"));
      toast.success(success);
      setLoading(true);
      await Promise.all([loadList(), selectedId ? loadDetail(selectedId) : Promise.resolve()]);
      return result;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("errors.actionFailed"));
      // A conflict means someone else saved first: reload their values so
      // the form stops editing the state the refusal just invalidated.
      if ((error as { status?: number }).status === 409 && selectedId) {
        setLoading(true);
        await loadDetail(selectedId).catch(() => null);
      }
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
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("register.title")}</div>
              <div className="mt-1 text-xs text-slate-500">{t("register.hint")}</div>
            </div>
            {permissions.create ? <Button onClick={() => setCreateOpen(true)}>{t("register.newButton")}</Button> : null}
          </div>
          {loading ? <div className="p-10 text-center text-sm text-slate-500">{t("register.loading")}</div> : rows.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t("register.emptyTitle")}</p>
              <p className="mt-1 text-sm text-slate-500">{t("register.emptyHint")}</p>
              {permissions.create ? <Button className="mt-4" onClick={() => setCreateOpen(true)}>{t("register.newButton")}</Button> : null}
            </div>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>{t("columns.number")}</TableHead><TableHead>{t("columns.subcontract")}</TableHead><TableHead>{t("columns.project")}</TableHead><TableHead>{t("columns.vendor")}</TableHead><TableHead>{t("columns.status")}</TableHead><TableHead className="text-right">{t("columns.revised")}</TableHead><TableHead className="text-right">{t("columns.billed")}</TableHead></TableRow></TableHeader>
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
        const result = await act({ action: "createSubcontract", ...payload }, t("toasts.created"));
        if (result?.id) { setCreateOpen(false); setSelectedId(result.id); setTab("sov"); }
      }} />

      <Drawer open={!!selectedId} onClose={() => setSelectedId(null)} size="2xl" title={detail ? `${detail.subcontract.number} · ${detail.subcontract.title}` : t("register.drawerTitle")} description={detail ? `${detail.subcontract.projectName} · ${detail.subcontract.vendorName}` : t("register.drawerLoading")}>
        {detail ? (
          <div className="space-y-5 p-1">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <StatusBadge status={detail.subcontract.status} />
              <LifecycleActions detail={detail} permissions={permissions} busy={busy} act={act} />
            </div>
            <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800" role="tablist">
              {(["overview", "sov", "changes", "applications", "retainage", "controls"] as Tab[]).map((key) => (
                <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium capitalize", tab === key ? "border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300" : "border-transparent text-slate-500")}>{t(`tabs.${key}`)}</button>
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

const STATUS_NAME_KEY: Record<string, string> = {
  draft: "draft",
  pending_approval: "pendingApproval",
  submitted: "submitted",
  approved: "approved",
  active: "active",
  substantially_complete: "substantiallyComplete",
  closed: "closed",
  void: "void",
  billed: "billed",
  posted: "posted",
};

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("subcontracts");
  const tone = ["active", "approved", "billed", "posted"].includes(status) ? "success" : ["pending_approval", "submitted"].includes(status) ? "warning" : status === "void" ? "destructive" : "secondary";
  const key = STATUS_NAME_KEY[status];
  return <Badge variant={(tone)}>{key ? t(`statusNames.${key}`) : status.replaceAll("_", " ")}</Badge>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-4"><div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 text-xl font-semibold tabular-nums">{value}</div></CardContent></Card>;
}

function Overview({ detail, money, canEdit, busy, act }: { detail: Detail; money: Money; canEdit: boolean; busy: boolean; act: Action }) {
  const t = useTranslations("subcontracts");
  const s = detail.subcontract;
  const billed = sumSubcontractAmounts(detail.payApplications.filter((app) => app.status === "billed").map((app) => app.grossThisPeriod));
  const [form, setForm] = useState({ title: s.title, description: s.description || "", originalCommitment: s.originalCommitment, defaultRetainagePercent: s.defaultRetainagePercent, startsOn: s.startsOn || "", endsOn: s.endsOn || "" });
  return <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-3"><Metric label={t("overview.originalCommitment")} value={money(s.originalCommitment, s.currency)} /><Metric label={t("overview.revisedCommitment")} value={money(s.revisedCommitment, s.currency)} /><Metric label={t("overview.grossBilled")} value={money(billed, s.currency)} /></div><Card><CardContent className="grid gap-4 p-4 sm:grid-cols-2"><Read label={t("overview.project")} value={s.projectName} /><Read label={t("overview.vendor")} value={s.vendorName} /><Read label={t("overview.retainage")} value={`${s.defaultRetainagePercent}%`} /><Read label={t("overview.term")} value={[s.startsOn, s.endsOn].filter(Boolean).join(" – ") || t("overview.notSet")} /><div className="sm:col-span-2"><Read label={t("overview.description")} value={s.description || "—"} /></div></CardContent></Card>{s.status === "draft" && canEdit ? <Card><CardContent className="space-y-3 p-4"><div><div className="text-sm font-semibold">{t("overview.editTitle")}</div><div className="mt-1 text-xs text-slate-500">{t("overview.editHint")}</div></div><div className="grid gap-3 sm:grid-cols-2"><Field label={t("overview.fieldTitle")}><Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></Field><Field label={t("overview.fieldCommitment")}><Input type="number" min="0" step="0.01" value={form.originalCommitment} onChange={(event) => setForm({ ...form, originalCommitment: event.target.value })} /></Field><Field label={t("overview.fieldRetainage")}><Input type="number" min="0" max="100" value={form.defaultRetainagePercent} onChange={(event) => setForm({ ...form, defaultRetainagePercent: event.target.value })} /></Field><Field label={t("overview.fieldStarts")}><Input type="date" value={form.startsOn} onChange={(event) => setForm({ ...form, startsOn: event.target.value })} /></Field><Field label={t("overview.fieldEnds")}><Input type="date" value={form.endsOn} onChange={(event) => setForm({ ...form, endsOn: event.target.value })} /></Field><div className="sm:col-span-2"><Field label={t("overview.fieldDescription")}><Textarea rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field></div></div><Button size="sm" disabled={busy || !form.title || !form.originalCommitment} onClick={() => act({ action: "updateSubcontract", id: s.id, ...form, startsOn: form.startsOn || null, endsOn: form.endsOn || null }, t("toasts.termsUpdated"))}>{t("overview.save")}</Button></CardContent></Card> : null}</div>;
}
function Read({ label, value }: { label: string; value: string }) { return <div><div className="text-xs font-medium text-slate-500">{label}</div><div className="mt-1 text-sm text-slate-900 dark:text-slate-100">{value}</div></div>; }

function LifecycleActions({ detail, permissions, busy, act }: { detail: Detail; permissions: Permissions; busy: boolean; act: Action }) {
  const t = useTranslations("subcontracts");
  const tCommon = useTranslations("common");
  const s = detail.subcontract;
  return <div className="flex flex-wrap gap-2">
    {s.status === "draft" && permissions.create ? <Button size="sm" disabled={busy} onClick={() => act({ action: "submitSubcontract", id: s.id }, t("toasts.submitted"))}>{tCommon("actions.submit")}</Button> : null}
    {s.status === "pending_approval" && permissions.approve ? <Button size="sm" disabled={busy} onClick={() => act({ action: "approveSubcontract", id: s.id }, t("toasts.approved"))}>{tCommon("actions.approve")}</Button> : null}
    {s.status === "active" && permissions.create ? <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "transitionSubcontract", id: s.id, transition: "substantially_complete" }, t("toasts.substantiallyComplete"))}>{t("lifecycle.substantiallyComplete")}</Button> : null}
    {s.status === "substantially_complete" && permissions.create ? <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "transitionSubcontract", id: s.id, transition: "close" }, t("toasts.closed"))}>{tCommon("actions.close")}</Button> : null}
    {["draft", "pending_approval"].includes(s.status) && permissions.create ? <Button size="sm" variant="destructive" disabled={busy} onClick={() => act({ action: "transitionSubcontract", id: s.id, transition: "void" }, t("toasts.voided"))}>{tCommon("actions.void")}</Button> : null}
  </div>;
}

function SovSection({ detail, accounts, canCreate, busy, act, money }: { detail: Detail; accounts: Option[]; canCreate: boolean; busy: boolean; act: Action; money: Money }) {
  const t = useTranslations("subcontracts");
  const tCommon = useTranslations("common");
  const editable = detail.subcontract.status === "draft" && canCreate;
  const [form, setForm] = useState({ itemNo: "", description: "", scheduledValue: "", retainagePercent: "", expenseAccountId: "" });
  const total = sumSubcontractAmounts(detail.sovLines.map((line) => line.scheduledValue));
  return <div className="space-y-4"><div className="flex justify-between text-sm"><span className="text-slate-500">{t("sov.total")}</span><span className="font-semibold tabular-nums">{money(total, detail.subcontract.currency)}</span></div><Table><TableHeader><TableRow><TableHead>{t("sov.colItem")}</TableHead><TableHead>{t("sov.colDescription")}</TableHead><TableHead className="text-right">{t("sov.colScheduled")}</TableHead><TableHead className="text-right">{t("sov.colEarned")}</TableHead><TableHead>{t("sov.colAccount")}</TableHead>{editable ? <TableHead /> : null}</TableRow></TableHeader><TableBody>{detail.sovLines.map((line) => <TableRow key={line.id}><TableCell>{line.itemNo || "—"}</TableCell><TableCell>{line.description}</TableCell><TableCell className="text-right tabular-nums">{money(line.scheduledValue, detail.subcontract.currency)}</TableCell><TableCell className="text-right tabular-nums">{money(line.earnedToDate, detail.subcontract.currency)}</TableCell><TableCell>{accounts.find((a) => a.id === line.expenseAccountId)?.name || t("sov.vendorDefault")}</TableCell>{editable ? <TableCell><Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: "removeSovLine", id: line.id }, t("toasts.sovRemoved"))}>{tCommon("actions.remove")}</Button></TableCell> : null}</TableRow>)}</TableBody></Table>{editable ? <Card><CardContent className="space-y-3 p-4"><div className="text-sm font-semibold">{t("sov.addTitle")}</div><div className="grid gap-3 sm:grid-cols-2"><Field label={t("sov.fieldItem")}><Input value={form.itemNo} onChange={(e) => setForm({ ...form, itemNo: e.target.value })} /></Field><Field label={t("sov.fieldDescription")}><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field><Field label={t("sov.fieldScheduled")}><Input type="number" min="0" step="0.01" value={form.scheduledValue} onChange={(e) => setForm({ ...form, scheduledValue: e.target.value })} /></Field><Field label={t("sov.fieldRetainage")}><Input type="number" min="0" max="100" value={form.retainagePercent} onChange={(e) => setForm({ ...form, retainagePercent: e.target.value })} /></Field><Field label={t("sov.fieldAccount")}><Select value={form.expenseAccountId} onChange={(e) => setForm({ ...form, expenseAccountId: e.target.value })}><option value="">{t("sov.vendorDefault")}</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field></div><Button size="sm" disabled={busy || !form.description || !form.scheduledValue} onClick={async () => { const ok = await act({ action: "addSovLine", subcontractId: detail.subcontract.id, ...form, retainagePercent: form.retainagePercent || null, expenseAccountId: form.expenseAccountId || null }, t("toasts.sovAdded")); if (ok) setForm({ itemNo: "", description: "", scheduledValue: "", retainagePercent: "", expenseAccountId: "" }); }}>{t("sov.add")}</Button></CardContent></Card> : null}</div>;
}

function ChangesSection({ detail, permissions, busy, act, money }: { detail: Detail; permissions: Permissions; busy: boolean; act: Action; money: Money }) {
  const t = useTranslations("subcontracts");
  const tCommon = useTranslations("common");
  const today = useBusinessToday();
  const allowed = ["active", "substantially_complete"].includes(detail.subcontract.status) && permissions.create;
  const [form, setForm] = useState({ number: "", description: "", amount: "", targetSovLineId: "" });
  return <div className="space-y-4"><Table><TableHeader><TableRow><TableHead>{t("changes.colNumber")}</TableHead><TableHead>{t("changes.colDescription")}</TableHead><TableHead>{t("changes.colStatus")}</TableHead><TableHead className="text-right">{t("changes.colAmount")}</TableHead><TableHead /></TableRow></TableHeader><TableBody>{detail.changeOrders.map((co) => <TableRow key={co.id}><TableCell className="font-medium">{co.number}</TableCell><TableCell>{co.description || "—"}</TableCell><TableCell><StatusBadge status={co.status} /></TableCell><TableCell className="text-right">{money(co.amount, detail.subcontract.currency)}</TableCell><TableCell className="space-x-2 text-right">{co.status === "draft" && permissions.approve && co.independentApprovalAllowed ? <Button size="sm" disabled={busy} onClick={() => act({ action: "approveChangeOrder", id: co.id, approvedOn: today }, t("toasts.changeApproved"))}>{tCommon("actions.approve")}</Button> : null}{co.status === "draft" && permissions.create ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: "voidChangeOrder", id: co.id }, t("toasts.changeVoided"))}>{tCommon("actions.void")}</Button> : null}</TableCell></TableRow>)}</TableBody></Table>{allowed ? <Card><CardContent className="space-y-3 p-4"><div className="text-sm font-semibold">{t("changes.newTitle")}</div><div className="grid gap-3 sm:grid-cols-2"><Field label={t("changes.fieldNumber")}><Input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} /></Field><Field label={t("changes.fieldAmount")}><Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field><Field label={t("changes.fieldTarget")}><Select value={form.targetSovLineId} onChange={(e) => setForm({ ...form, targetSovLineId: e.target.value })}><option value="">{t("sov.newSovLine")}</option>{detail.sovLines.map((line) => <option key={line.id} value={line.id}>{line.itemNo || line.description} · {line.description}</option>)}</Select></Field><Field label={t("changes.fieldDescription")}><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field></div><Button size="sm" disabled={busy || !form.number || !form.amount} onClick={async () => { const ok = await act({ action: "addChangeOrder", subcontractId: detail.subcontract.id, ...form, targetSovLineId: form.targetSovLineId || null }, t("toasts.changeCreated")); if (ok) setForm({ number: "", description: "", amount: "", targetSovLineId: "" }); }}>{t("changes.create")}</Button></CardContent></Card> : null}</div>;
}

function ApplicationsSection({ detail, permissions, busy, act, money }: { detail: Detail; permissions: Permissions; busy: boolean; act: Action; money: Money }) {
  const t = useTranslations("subcontracts");
  const tCommon = useTranslations("common");
  const [periodEnd, setPeriodEnd] = useState(useBusinessToday());
  const [vendorInvoiceNumber, setVendorInvoiceNumber] = useState("");
  const open = detail.payApplications.find((app) => ["draft", "submitted", "approved"].includes(app.status));
  return <div className="space-y-4">{!open && permissions.create && ["active", "substantially_complete"].includes(detail.subcontract.status) ? <Card><CardContent className="flex flex-wrap items-end gap-3 p-4"><Field label={t("applications.periodEnding")}><Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></Field><Field label={t("applications.vendorInvoice")}><Input value={vendorInvoiceNumber} onChange={(e) => setVendorInvoiceNumber(e.target.value)} /></Field><Button disabled={busy} onClick={() => act({ action: "createPayApplication", subcontractId: detail.subcontract.id, periodEnd, vendorInvoiceNumber: vendorInvoiceNumber || null }, t("toasts.appCreated"))}>{t("applications.new")}</Button></CardContent></Card> : null}{open?.status === "draft" ? <PayApplicationEditor app={open} lines={detail.payApplicationLines.filter((line) => line.payApplicationId === open.id)} busy={busy} act={act} currency={detail.subcontract.currency} money={money} /> : null}<Table><TableHeader><TableRow><TableHead>{t("applications.colApplication")}</TableHead><TableHead>{t("applications.colPeriod")}</TableHead><TableHead>{t("applications.colStatus")}</TableHead><TableHead className="text-right">{t("applications.colGross")}</TableHead><TableHead className="text-right">{t("applications.colRetainage")}</TableHead><TableHead className="text-right">{t("applications.colNetDue")}</TableHead><TableHead /></TableRow></TableHeader><TableBody>{detail.payApplications.map((app) => <TableRow key={app.id}><TableCell>#{app.applicationNumber}</TableCell><TableCell>{app.periodEnd}</TableCell><TableCell><StatusBadge status={app.vendorBillStatus === "posted" ? "posted" : app.status} /></TableCell><TableCell className="text-right">{money(app.grossThisPeriod, detail.subcontract.currency)}</TableCell><TableCell className="text-right">{money(app.retainageThisPeriod, detail.subcontract.currency)}</TableCell><TableCell className="text-right">{money(app.netDue, detail.subcontract.currency)}</TableCell><TableCell className="space-x-2 text-right">{app.status === "submitted" && permissions.approve && app.independentApprovalAllowed ? <Button size="sm" disabled={busy} onClick={() => act({ action: "approvePayApplication", id: app.id }, t("toasts.appApproved"))}>{tCommon("actions.approve")}</Button> : null}{app.status === "approved" && permissions.post ? <Button size="sm" disabled={busy} onClick={() => act({ action: "createVendorBill", id: app.id }, t("toasts.billCreated"))}>{t("applications.createBill")}</Button> : null}{app.vendorBillDocumentId ? <Button asChild size="sm" variant="outline"><Link href={`/ap/bills?doc=${app.vendorBillDocumentId}`}>{app.vendorBillNumber || t("applications.openBill")}</Link></Button> : null}{["draft", "submitted", "approved"].includes(app.status) && permissions.create ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: "voidPayApplication", id: app.id }, t("toasts.appVoided"))}>{tCommon("actions.void")}</Button> : null}</TableCell></TableRow>)}</TableBody></Table></div>;
}

function PayApplicationEditor({ app, lines, busy, act, currency, money }: { app: PayApplication; lines: PayApplicationLine[]; busy: boolean; act: Action; currency: string; money: Money }) {
  const t = useTranslations("subcontracts");
  const tCommon = useTranslations("common");
  const [values, setValues] = useState<Record<string, { work: string; stored: string }>>(() => Object.fromEntries(lines.map((line) => [line.sovLineId, { work: line.workCompletedThisPeriod, stored: line.materialsStoredCurrent }])));
  const save = () => act({ action: "updatePayApplication", payApplicationId: app.id, expectedRevision: app.revision, lines: lines.map((line) => ({ sovLineId: line.sovLineId, workCompletedThisPeriod: values[line.sovLineId]?.work || "0", materialsStoredCurrent: values[line.sovLineId]?.stored || "0" })) }, t("toasts.appLinesSaved"));
  return <Card><CardContent className="space-y-3 p-4"><div className="flex items-center justify-between"><div><div className="text-sm font-semibold">{t("applications.editorTitle", { n: app.applicationNumber })}</div><div className="text-xs text-slate-500">{t("applications.editorHint")}</div></div><div className="space-x-2"><Button size="sm" variant="outline" disabled={busy} onClick={save}>{tCommon("actions.save")}</Button><Button size="sm" disabled={busy} onClick={async () => { const ok = await save(); if (ok) await act({ action: "submitPayApplication", id: app.id }, t("toasts.appSubmitted")); }}>{t("applications.saveSubmit")}</Button></div></div><Table><TableHeader><TableRow><TableHead>{t("sov.colItem")} · {t("sov.colDescription")}</TableHead><TableHead className="text-right">{t("sov.colScheduled")}</TableHead><TableHead className="text-right">{t("sov.colEarned")}</TableHead><TableHead>{t("applications.colWork")}</TableHead><TableHead>{t("applications.colStored")}</TableHead></TableRow></TableHeader><TableBody>{lines.map((line) => <TableRow key={line.sovLineId}><TableCell>{line.itemNo || "—"} · {line.description}</TableCell><TableCell className="text-right">{money(line.scheduledValue, currency)}</TableCell><TableCell className="text-right">{money(line.previousEarned, currency)}</TableCell><TableCell><Input type="number" min="0" step="0.01" value={values[line.sovLineId]?.work || ""} onChange={(e) => setValues({ ...values, [line.sovLineId]: { work: e.target.value, stored: values[line.sovLineId]?.stored ?? "" } })} /></TableCell><TableCell><Input type="number" min="0" step="0.01" value={values[line.sovLineId]?.stored || ""} onChange={(e) => setValues({ ...values, [line.sovLineId]: { work: values[line.sovLineId]?.work ?? "", stored: e.target.value } })} /></TableCell></TableRow>)}</TableBody></Table></CardContent></Card>;
}

function RetainageSection({ detail, canPost, busy, act, money }: { detail: Detail; canPost: boolean; busy: boolean; act: Action; money: Money }) {
  const t = useTranslations("subcontracts");
  const [amount, setAmount] = useState(""); const [periodEnd, setPeriodEnd] = useState(useBusinessToday());
  const postedHeld = sumSubcontractAmounts(detail.payApplications.filter((app) => app.vendorBillStatus === "posted").map((app) => app.retainageThisPeriod));
  const released = sumSubcontractAmounts(detail.retainageReleases.filter((release) => release.vendorBillStatus !== "voided").map((release) => release.amount));
  const available = subtractSubcontractAmounts(postedHeld, released);
  return <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-3"><Metric label={t("retainage.posted")} value={money(postedHeld, detail.subcontract.currency)} /><Metric label={t("retainage.releasedReserved")} value={money(released, detail.subcontract.currency)} /><Metric label={t("retainage.available")} value={money(available, detail.subcontract.currency)} /></div>{canPost && decimalCmp(available, "0") > 0 ? <Card><CardContent className="flex flex-wrap items-end gap-3 p-4"><Field label={t("retainage.releaseAmount")}><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field><Field label={t("retainage.billDate")}><Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></Field><Button disabled={busy || !amount} onClick={() => act({ action: "releaseRetainage", subcontractId: detail.subcontract.id, periodEnd, amount }, t("toasts.retainageReleased"))}>{t("retainage.createRelease")}</Button></CardContent></Card> : null}<Table><TableHeader><TableRow><TableHead>{t("retainage.colDate")}</TableHead><TableHead className="text-right">{t("retainage.colAmount")}</TableHead><TableHead>{t("retainage.colBill")}</TableHead><TableHead>{t("retainage.colStatus")}</TableHead></TableRow></TableHeader><TableBody>{detail.retainageReleases.map((release) => <TableRow key={release.id}><TableCell>{release.periodEnd}</TableCell><TableCell className="text-right">{money(release.amount, detail.subcontract.currency)}</TableCell><TableCell><Link className="text-teal-700 hover:underline" href={`/ap/bills?doc=${release.vendorBillDocumentId}`}>{release.vendorBillNumber}</Link></TableCell><TableCell><StatusBadge status={release.vendorBillStatus} /></TableCell></TableRow>)}</TableBody></Table></div>;
}

function ControlsSection({ detail, parties, canPay, busy, act, money }: { detail: Detail; parties: Option[]; canPay: boolean; busy: boolean; act: Action; money: Money }) {
  const t = useTranslations("subcontracts");
  const tCommon = useTranslations("common");
  const today = useBusinessToday();
  const [form, setForm] = useState({ controlType: "payment_hold", jointPayeePartyId: "", amountLimit: "", reason: "", effectiveOn: today, expiresOn: "" });
  const [releaseId, setReleaseId] = useState<string | null>(null);
  const [releaseReason, setReleaseReason] = useState("");
  return <div className="space-y-4">
    <p className="text-sm text-slate-500">{t("controls.hint")}</p>
    <Table><TableHeader><TableRow><TableHead>{t("controls.colControl")}</TableHead><TableHead>{t("controls.colReason")}</TableHead><TableHead>{t("controls.colEffective")}</TableHead><TableHead>{t("controls.colCap")}</TableHead><TableHead>{t("controls.colStatus")}</TableHead><TableHead /></TableRow></TableHeader><TableBody>{detail.paymentControls.map((control) => <TableRow key={control.id}><TableCell>{control.controlType === "payment_hold" ? t("controls.holdOption") : control.controlType === "joint_check" ? t("controls.jointOption") : control.controlType.replaceAll("_", " ")}</TableCell><TableCell>{control.reason}{control.jointPayeeName ? ` · ${control.jointPayeeName}` : ""}</TableCell><TableCell>{control.effectiveOn}{control.expiresOn ? ` – ${control.expiresOn}` : ""}</TableCell><TableCell>{control.amountLimit ? money(control.amountLimit, detail.subcontract.currency) : t("controls.noneBlockAll")}</TableCell><TableCell><StatusBadge status={control.status} /></TableCell><TableCell>{control.status === "active" && canPay ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { setReleaseId(control.id); setReleaseReason(""); }}>{t("controls.release")}</Button> : null}</TableCell></TableRow>)}</TableBody></Table>
    {canPay ? <Card><CardContent className="space-y-3 p-4"><div><div className="text-sm font-semibold">{t("controls.addTitle")}</div><div className="text-xs text-muted-foreground">{t("controls.addHint")}</div></div><div className="grid gap-3 sm:grid-cols-2"><Field label={t("controls.fieldType")}><Select value={form.controlType} onChange={(e) => setForm({ ...form, controlType: e.target.value })}><option value="payment_hold">{t("controls.holdOption")}</option><option value="joint_check">{t("controls.jointOption")}</option></Select></Field>{form.controlType === "joint_check" ? <Field label={t("controls.jointPayee")}><Select value={form.jointPayeePartyId} onChange={(e) => setForm({ ...form, jointPayeePartyId: e.target.value })}><option value="">{t("controls.selectPayee")}</option>{parties.map((p: Option) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field> : null}<Field label={t("controls.fieldReason")}><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field><Field label={t("controls.fieldCap")}><Input type="number" min="0" step="0.01" value={form.amountLimit} onChange={(e) => setForm({ ...form, amountLimit: e.target.value })} /></Field><Field label={t("controls.fieldEffective")}><Input type="date" value={form.effectiveOn} onChange={(e) => setForm({ ...form, effectiveOn: e.target.value })} /></Field><Field label={t("controls.fieldExpires")}><Input type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} /></Field></div><Button disabled={busy || !form.reason || (form.controlType === "joint_check" && !form.jointPayeePartyId)} onClick={() => act({ action: "addPaymentControl", subcontractId: detail.subcontract.id, ...form, jointPayeePartyId: form.controlType === "joint_check" ? form.jointPayeePartyId : null, amountLimit: form.amountLimit || null, expiresOn: form.expiresOn || null }, t("toasts.controlAdded"))}>{t("controls.add")}</Button></CardContent></Card> : null}
    <Drawer
      open={releaseId !== null}
      onClose={() => setReleaseId(null)}
      size="sm"
      title={t("controls.releaseTitle")}
      description={t("controls.releaseDescription")}
      headerActions={<><Button variant="outline" onClick={() => setReleaseId(null)}>{tCommon("actions.cancel")}</Button><Button disabled={busy || !releaseReason.trim()} onClick={async () => { if (!releaseId) return; const ok = await act({ action: "releasePaymentControl", id: releaseId, releaseReason }, t("toasts.controlReleased")); if (ok) setReleaseId(null); }}>{t("controls.releaseControl")}</Button></>}
    >
      <Field label={t("controls.releaseReason")}><Textarea rows={5} autoFocus value={releaseReason} onChange={(event) => setReleaseReason(event.target.value)} /></Field>
    </Drawer>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>; }

function CreateSubcontractDrawer({ open, onClose, projects, vendors, busy, onCreate, multiCurrency = false }: { open: boolean; onClose: () => void; projects: Option[]; vendors: Option[]; busy: boolean; onCreate: (value: Record<string, string | null>) => void; multiCurrency?: boolean }) {
  const t = useTranslations("subcontracts");
  const tCommon = useTranslations("common");
  const [form, setForm] = useState({ projectId: "", vendorId: "", number: "", title: "", description: "", currency: "", originalCommitment: "", defaultRetainagePercent: "10", startsOn: "", endsOn: "" });
  const vendorCurrency = useMemo(() => vendors.find((v) => v.id === form.vendorId)?.currency || "", [vendors, form.vendorId]);
  return <Drawer open={open} onClose={onClose} size="md" title={t("create.title")} description={t("create.description")} headerActions={<><Button variant="outline" onClick={onClose}>{tCommon("actions.cancel")}</Button><Button disabled={busy || !form.projectId || !form.vendorId || !form.number || !form.title || !form.originalCommitment} onClick={() => { const { currency, ...fields } = form; onCreate({ ...fields, ...(multiCurrency ? { currency: currency || vendorCurrency || null } : {}), startsOn: form.startsOn || null, endsOn: form.endsOn || null }); }}>{tCommon("actions.create")}</Button></>}><div className="grid gap-4 p-1 sm:grid-cols-2"><Field label={t("create.project")}><Select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}><option value="">{t("create.selectProject")}</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field><Field label={t("create.vendor")}><Select value={form.vendorId} onChange={(e) => setForm({ ...form, vendorId: e.target.value })}><option value="">{t("create.selectVendor")}</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field><Field label={t("create.number")}><Input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} /></Field><Field label={t("create.titleField")}><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field><Field label={t("create.commitment")}><Input type="number" min="0" step="0.01" value={form.originalCommitment} onChange={(e) => setForm({ ...form, originalCommitment: e.target.value })} /></Field><Field label={t("create.retainage")}><Input type="number" min="0" max="100" value={form.defaultRetainagePercent} onChange={(e) => setForm({ ...form, defaultRetainagePercent: e.target.value })} /></Field>{multiCurrency ? <Field label={t("create.currency")}><Input maxLength={3} placeholder={vendorCurrency || t("create.orgCurrency")} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></Field> : null}<Field label={t("create.starts")}><Input type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} /></Field><Field label={t("create.ends")}><Input type="date" value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} /></Field><div className="sm:col-span-2"><Field label={t("create.descriptionField")}><Textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field></div></div></Drawer>;
}
