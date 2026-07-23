"use client";

import { useMoney } from '@/components/money-provider'
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, Input, Label, Select } from "@openbooks/ui";

interface Project { id: string; name: string; customerName: string | null }
interface Account { id: string; label: string }
interface SovLine {
  id: string; itemNo: string | null; description: string; scheduledValue: string;
  retainagePercent: string | null; incomeAccountId: string | null; changeOrderId: string | null;
}
interface ChangeOrder {
  id: string; number: string; description: string | null; status: string; amount: string;
  approvedOn: string | null; targetSovLineId: string | null; targetSovLineDescription: string | null;
  independentApprovalAllowed: boolean;
}
interface PayApp {
  id: string; applicationNumber: number; periodEnd: string; kind: string; status: string;
  retainagePercent: string; invoiceNumber: string | null; invoiceTotal: string | null; invoiceStatus: string | null;
  invoiceDocumentId: string | null; independentApprovalAllowed: boolean;
}
interface Data {
  sovLines: SovLine[]; changeOrders: ChangeOrder[]; payApplications: PayApp[];
  contractSum: string; retainageHeld: string; committedCost: number; retainageConfigured: boolean;
}

export function ConstructionClient({
  projects, incomeAccounts, initialProjectId, canCreate, canApprove, canInvoice,
}: {
  projects: Project[]; incomeAccounts: Account[]; initialProjectId: string | null;
  canCreate: boolean; canApprove: boolean; canInvoice: boolean;
}) {
  const { money } = useMoney()
  const t = useTranslations("applications");
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) { setData(null); return; }
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/construction?projectId=${projectId}`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? t("errors.load"));
      setData(body);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : t("errors.load"));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);
  useEffect(() => { void load(); }, [load]);

  const post = async (payload: Record<string, unknown>) => {
    if (busy) return null;
    setError(null); setMsg(null); setBusy(true);
    try {
      const r = await fetch("/api/construction", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? t("errors.action"));
      await load();
      return body;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.action"));
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (projects.length === 0) return (
    <Card className="mt-6 p-6 text-sm text-muted-foreground">
      <h2 className="font-semibold text-foreground">{t("empty.title")}</h2>
      <p className="mt-1">{t("empty.description")}</p>
      <Button asChild variant="outline" size="sm" className="mt-4"><Link href="/admin/setup/project-types">{t("empty.manageProjectTypes")}</Link></Button>
    </Card>
  );

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center gap-3">
        <Label className="shrink-0">{t("project")}</Label>
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="max-w-md">
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.customerName ? ` — ${p.customerName}` : ""}</option>)}
        </Select>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {msg && <p className="text-sm text-teal-700 dark:text-teal-300">{msg}</p>}
      {loading && <p className="text-sm text-muted-foreground">{t("loading")}</p>}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="p-4"><div className="text-xs text-muted-foreground">{t("summary.contractSum")}</div><div className="text-lg font-semibold">{money(data.contractSum)}</div></Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">{t("summary.retainageHeld")}</div><div className="text-lg font-semibold">{money(data.retainageHeld)}</div></Card>
            <Card className="p-4"><div className="text-xs text-muted-foreground">{t("summary.committedCost")}</div><div className="text-lg font-semibold">{money(data.committedCost)}</div></Card>
          </div>
          {!data.retainageConfigured && (
            <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {t("retainage.notConfigured")}
            </p>
          )}

          <SovSection projectId={projectId} lines={data.sovLines} incomeAccounts={incomeAccounts} onChange={post} canCreate={canCreate} busy={busy} />
          <ChangeOrderSection projectId={projectId} orders={data.changeOrders} sov={data.sovLines} onChange={post} canCreate={canCreate} canApprove={canApprove} busy={busy} />
          <PayAppSection projectId={projectId} apps={data.payApplications} sov={data.sovLines} onChange={post} setMsg={setMsg} canCreate={canCreate} canApprove={canApprove} canInvoice={canInvoice} busy={busy} />
          <RetainageReleaseSection projectId={projectId} held={data.retainageHeld} onChange={post} setMsg={setMsg} canInvoice={canInvoice} busy={busy} />
        </>
      )}
    </div>
  );
}

function SovSection({ projectId, lines, incomeAccounts, onChange, canCreate, busy }: {
  projectId: string; lines: SovLine[]; incomeAccounts: Account[];
  onChange: (p: Record<string, unknown>) => Promise<unknown>;
  canCreate: boolean; busy: boolean;
}) {
  const { money } = useMoney()
  const t = useTranslations("applications.sov");
  const [f, setF] = useState({ itemNo: "", description: "", scheduledValue: "", retainagePercent: "", incomeAccountId: "" });
  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold">{t("title")}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr><th className="py-1">{t("item")}</th><th>{t("description")}</th><th className="text-right">{t("scheduledValue")}</th><th className="text-right">{t("retainagePercent")}</th><th></th></tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-t">
                <td className="py-1">{l.itemNo ?? "—"}{l.changeOrderId && <Badge variant="secondary" className="ml-1">CO</Badge>}</td>
                <td>{l.description}</td>
                <td className="text-right tabular-nums">{money(l.scheduledValue)}</td>
                <td className="text-right tabular-nums">{l.retainagePercent ?? t("default")}</td>
                <td className="text-right">{canCreate && !l.changeOrderId ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
                  if (window.confirm(t("deleteConfirm", { description: l.description }))) void onChange({ action: "deleteSov", id: l.id });
                }}>{t("delete")}</Button> : null}</td>
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">{t("empty")}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-5">
        <Input placeholder={t("itemPlaceholder")} value={f.itemNo} onChange={(e) => setF({ ...f, itemNo: e.target.value })} />
        <Input placeholder={t("description")} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className="sm:col-span-2" />
        <Input placeholder={t("scheduledValue")} type="number" value={f.scheduledValue} onChange={(e) => setF({ ...f, scheduledValue: e.target.value })} />
        <Input placeholder={t("retainagePercent")} type="number" value={f.retainagePercent} onChange={(e) => setF({ ...f, retainagePercent: e.target.value })} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Select value={f.incomeAccountId} onChange={(e) => setF({ ...f, incomeAccountId: e.target.value })} className="max-w-xs">
          <option value="">{t("defaultIncomeAccount")}</option>
          {incomeAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </Select>
        <Button
          size="sm"
          disabled={busy || !canCreate || !f.description || !f.scheduledValue}
          onClick={async () => {
            await onChange({ action: "addSov", projectId, ...f, retainagePercent: f.retainagePercent || null, incomeAccountId: f.incomeAccountId || null, sortOrder: lines.length + 1 });
            setF({ itemNo: "", description: "", scheduledValue: "", retainagePercent: "", incomeAccountId: "" });
          }}
        >{t("addLine")}</Button>
      </div>
    </Card>
  );
}

function ChangeOrderSection({ projectId, orders, sov, onChange, canCreate, canApprove, busy }: {
  projectId: string; orders: ChangeOrder[]; sov: SovLine[]; onChange: (p: Record<string, unknown>) => Promise<unknown>;
  canCreate: boolean; canApprove: boolean; busy: boolean;
}) {
  const { money } = useMoney()
  const t = useTranslations("applications.changeOrders");
  const [f, setF] = useState({ number: "", description: "", amount: "", targetSovLineId: "" });
  const deductive = f.amount.trim().startsWith("-");
  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold">{t("title")}</h3>
      <ul className="space-y-1 text-sm">
        {orders.map((o) => (
          <li key={o.id} className="flex items-center gap-3 border-t py-1.5">
            <span className="font-medium">CO {o.number}</span>
            <span className="text-muted-foreground">{o.description}</span>
            <span className="tabular-nums">{money(o.amount)}</span>
            {o.targetSovLineDescription && <span className="text-xs text-muted-foreground">{t("adjusts", { description: o.targetSovLineDescription })}</span>}
            {o.status === "approved" ? <Badge>{t("status.approved")}</Badge> : <Badge variant="secondary">{t(`status.${o.status}`)}</Badge>}
            {o.status === "draft" && canApprove && o.independentApprovalAllowed && (
              <Button size="sm" variant="ghost" disabled={busy} className="ml-auto" onClick={() => onChange({ action: "approveChangeOrder", id: o.id })}>{t("approve")}</Button>
            )}
            {o.status === "draft" && canCreate && (
              <Button size="sm" variant="ghost" disabled={busy} className={canApprove && o.independentApprovalAllowed ? "" : "ml-auto"} onClick={() => {
                if (window.confirm(t("voidConfirm", { number: o.number }))) void onChange({ action: "voidChangeOrder", id: o.id });
              }}>{t("void")}</Button>
            )}
          </li>
        ))}
        {orders.length === 0 && <li className="py-2 text-center text-muted-foreground">{t("empty")}</li>}
      </ul>
      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <Input placeholder={t("number")} value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
        <Input placeholder={t("description")} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className="sm:col-span-2" />
        <Input placeholder={t("amount")} type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Label className="shrink-0">{t("applyTo")}</Label>
        <Select value={f.targetSovLineId} onChange={(e) => setF({ ...f, targetSovLineId: e.target.value })} className="max-w-md">
          <option value="">{t("newScheduleLine")}</option>
          {sov.map((line) => <option key={line.id} value={line.id}>{line.itemNo ? `${line.itemNo} · ` : ""}{line.description}</option>)}
        </Select>
        <span className="text-xs text-muted-foreground">
          {deductive ? t("deductiveHint") : t("additiveHint")}
        </span>
      </div>
      <div className="mt-2">
        <Button size="sm" disabled={busy || !canCreate || !f.number || !f.amount || (deductive && !f.targetSovLineId)} onClick={async () => {
          const result = await onChange({ action: "addChangeOrder", projectId, ...f, targetSovLineId: f.targetSovLineId || null });
          if (result) setF({ number: "", description: "", amount: "", targetSovLineId: "" });
        }}>{t("add")}</Button>
      </div>
    </Card>
  );
}

function PayAppSection({ projectId, apps, sov, onChange, setMsg, canCreate, canApprove, canInvoice, busy }: {
  projectId: string; apps: PayApp[]; sov: SovLine[];
  onChange: (p: Record<string, unknown>) => Promise<unknown>;
  setMsg: (m: string | null) => void; canCreate: boolean; canApprove: boolean; canInvoice: boolean; busy: boolean;
}) {
  const { money } = useMoney()
  const t = useTranslations("applications.payApplications");
  const [periodEnd, setPeriodEnd] = useState("");
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [lines, setLines] = useState<Record<string, { thisPeriodCompleted: string; materialsStored: string }>>({});

  const openDraws = async (appId: string) => {
    setOpenApp(openApp === appId ? null : appId);
    setLines({});
  };

  const submit = async (appId: string) => {
    const drawLines = Object.entries(lines).map(([sovLineId, value]) => ({ sovLineId, ...value }));
    const r = await onChange({ action: "submitPayApp", payApplicationId: appId, lines: drawLines });
    if (r) setMsg(t("submittedMessage"));
    setOpenApp(null);
  };

  const bill = async (appId: string) => {
    const r = (await onChange({ action: "billPayApp", payApplicationId: appId })) as any;
    if (r?.invoiceId) setMsg(t("billedMessage", { number: r.documentNumber, currentDue: money(r.currentDue), retainage: money(r.retainage) }));
    setOpenApp(null);
  };

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold">{t("title")}</h3>
      <ul className="space-y-1 text-sm">
        {apps.map((a) => (
          <li key={a.id} className="border-t py-1.5">
            <div className="flex items-center gap-3">
              <span className="font-medium">{t("applicationNumber", { number: a.applicationNumber })}</span>
              <span className="text-muted-foreground">{a.periodEnd}</span>
              {a.kind === "retainage_release" && <Badge variant="secondary">{t("retainage")}</Badge>}
              {a.status === "invoiced" || a.status === "posted"
                ? <Badge>{t("status.invoiced")}{a.invoiceNumber ? ` · ${a.invoiceNumber}` : ""}</Badge>
                : <Badge variant="secondary">{t(`status.${a.status}`)}</Badge>}
              {a.invoiceTotal && <span className="tabular-nums">{money(a.invoiceTotal)}</span>}
              {a.status === "draft" && canCreate && (
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => openDraws(a.id)}>{openApp === a.id ? t("hideDraws") : t("enterDraws")}</Button>
                </span>
              )}
              {a.status === "submitted" && canApprove && a.independentApprovalAllowed ? <Button size="sm" disabled={busy} className="ml-auto" onClick={() => onChange({ action: "approvePayApp", payApplicationId: a.id })}>{t("approve")}</Button> : null}
              {a.status === "approved" && canInvoice ? <Button size="sm" disabled={busy} className="ml-auto" onClick={() => bill(a.id)}>{t("createInvoice")}</Button> : null}
              {["draft", "submitted", "approved"].includes(a.status) && canApprove ? <Button size="sm" variant="ghost" disabled={busy} className={a.status === "draft" ? "ml-auto" : ""} onClick={() => {
                if (window.confirm(t("voidConfirm", { number: a.applicationNumber }))) void onChange({ action: "voidPayApp", payApplicationId: a.id });
              }}>{t("void")}</Button> : null}
            </div>
            {openApp === a.id && (
              <table className="mt-2 w-full text-xs">
                <thead className="text-left text-muted-foreground"><tr><th>{t("item")}</th><th>{t("description")}</th><th className="text-right">{t("workThisPeriod")}</th><th className="text-right">{t("materialsStored")}</th></tr></thead>
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
            {openApp === a.id && <div className="mt-2 flex justify-end"><Button size="sm" disabled={busy} onClick={() => submit(a.id)}>{t("submit")}</Button></div>}
          </li>
        ))}
        {apps.length === 0 && <li className="py-2 text-center text-muted-foreground">{t("empty")}</li>}
      </ul>
      <div className="mt-3 flex items-center gap-2">
        <Label className="shrink-0">{t("periodEnding")}</Label>
        <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="max-w-xs" />
        <Button size="sm" disabled={busy || !canCreate || !periodEnd || sov.length === 0} onClick={() => onChange({ action: "createPayApp", projectId, periodEnd })}>{t("newApplication")}</Button>
      </div>
    </Card>
  );
}

function RetainageReleaseSection({ projectId, held, onChange, setMsg, canInvoice, busy }: {
  projectId: string; held: string; onChange: (p: Record<string, unknown>) => Promise<unknown>;
  setMsg: (m: string | null) => void;
  canInvoice: boolean; busy: boolean;
}) {
  const { money } = useMoney()
  const t = useTranslations("applications.retainage");
  const [amount, setAmount] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  return (
    <Card className="p-4">
      <h3 className="mb-1 text-sm font-semibold">{t("title")}</h3>
      <p className="mb-3 text-xs text-muted-foreground">{t("description", { held: money(held) })}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="number" placeholder={t("amount")} value={amount} onChange={(e) => setAmount(e.target.value)} className="max-w-40" />
        <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="max-w-xs" />
        <Button
          size="sm"
          disabled={busy || !canInvoice || !amount || !periodEnd}
          onClick={async () => {
            const r = (await onChange({ action: "releaseRetainage", projectId, amount, periodEnd })) as any;
            if (r?.invoiceId) { setMsg(t("createdMessage", { number: r.documentNumber, amount: money(r.amount) })); setAmount(""); }
          }}
        >{t("release")}</Button>
      </div>
    </Card>
  );
}
