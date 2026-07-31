"use client";

import { useMoney } from "@/components/money-provider";
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
  cn,
} from "@openbooks/ui";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

export interface ApplicationIncomeAccount {
  id: string;
  label: string;
}

interface SovLine {
  id: string;
  itemNo: string | null;
  description: string;
  scheduledValue: string;
  retainagePercent: string | null;
  incomeAccountId: string | null;
  changeOrderId: string | null;
}

interface ChangeOrder {
  id: string;
  number: string;
  description: string | null;
  status: string;
  amount: string;
  approvedOn: string | null;
  targetSovLineId: string | null;
  targetSovLineDescription: string | null;
  independentApprovalAllowed: boolean;
}

interface PayApp {
  id: string;
  applicationNumber: number;
  periodEnd: string;
  kind: string;
  status: string;
  retainagePercent: string;
  invoiceNumber: string | null;
  invoiceTotal: string | null;
  invoiceStatus: string | null;
  invoiceDocumentId: string | null;
  independentApprovalAllowed: boolean;
}

interface Data {
  sovLines: SovLine[];
  changeOrders: ChangeOrder[];
  payApplications: PayApp[];
  contractSum: string;
  retainageHeld: string;
  committedCost: number;
  retainageConfigured: boolean;
}

type BillingTab = "applications" | "schedule" | "changes" | "retainage";

export function ApplicationsBillingWorkspace({
  projectId,
  incomeAccounts,
  canCreate,
  canApprove,
  canInvoice,
}: {
  projectId: string;
  incomeAccounts: ApplicationIncomeAccount[];
  canCreate: boolean;
  canApprove: boolean;
  canInvoice: boolean;
}) {
  const { money } = useMoney();
  const t = useTranslations("applications");
  const [tab, setTab] = useState<BillingTab>("applications");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/construction?projectId=${encodeURIComponent(projectId)}`, {
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t("errors.load"));
      setData(body);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : t("errors.load"));
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (payload: Record<string, unknown>) => {
    if (busy) return null;
    setError(null);
    setMsg(null);
    setBusy(true);
    try {
      const response = await fetch("/api/construction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t("errors.action"));
      await load();
      return body;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.action"));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const tabs: { key: BillingTab; label: string; count?: number }[] = [
    { key: "applications", label: t("payApplications.title"), count: data?.payApplications.length },
    { key: "schedule", label: t("sov.title"), count: data?.sovLines.length },
    { key: "changes", label: t("changeOrders.title"), count: data?.changeOrders.length },
    { key: "retainage", label: t("retainage.title") },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("title")}</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{t("description")}</p>
      </div>

      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {msg ? <p className="text-sm text-teal-700 dark:text-teal-300">{msg}</p> : null}
      {loading && !data ? <p className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">{t("loading")}</p> : null}

      {data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label={t("summary.contractSum")} value={money(data.contractSum)} />
            <Metric label={t("summary.retainageHeld")} value={money(data.retainageHeld)} />
            <Metric label={t("summary.committedCost")} value={money(data.committedCost)} />
          </div>

          {!data.retainageConfigured ? (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {t("retainage.notConfigured")}
            </p>
          ) : null}

          <nav
            className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800"
            aria-label={t("workspace.sectionsAria")}
            role="tablist"
          >
            {tabs.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                onClick={() => setTab(item.key)}
                className={cn(
                  "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                  tab === item.key
                    ? "border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300"
                    : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200",
                )}
              >
                {item.label}
                {item.count != null ? (
                  <span className="ml-1.5 text-xs font-normal text-slate-400">{item.count}</span>
                ) : null}
              </button>
            ))}
          </nav>

          {tab === "applications" ? (
            <PayApplicationsSection
              projectId={projectId}
              apps={data.payApplications}
              sov={data.sovLines}
              onChange={post}
              setMsg={setMsg}
              canCreate={canCreate}
              canApprove={canApprove}
              canInvoice={canInvoice}
              busy={busy}
            />
          ) : null}
          {tab === "schedule" ? (
            <ScheduleSection
              projectId={projectId}
              lines={data.sovLines}
              incomeAccounts={incomeAccounts}
              onChange={post}
              canCreate={canCreate}
              busy={busy}
            />
          ) : null}
          {tab === "changes" ? (
            <ChangeOrdersSection
              projectId={projectId}
              orders={data.changeOrders}
              sov={data.sovLines}
              onChange={post}
              canCreate={canCreate}
              canApprove={canApprove}
              busy={busy}
            />
          ) : null}
          {tab === "retainage" ? (
            <RetainageSection
              projectId={projectId}
              held={data.retainageHeld}
              onChange={post}
              setMsg={setMsg}
              canInvoice={canInvoice}
              busy={busy}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{label}</div>
        <div className="mt-1 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value}</div>
      </CardContent>
    </Card>
  );
}

function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h4>
        <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
      </div>
      {action}
    </div>
  );
}

function ScheduleSection({
  projectId,
  lines,
  incomeAccounts,
  onChange,
  canCreate,
  busy,
}: {
  projectId: string;
  lines: SovLine[];
  incomeAccounts: ApplicationIncomeAccount[];
  onChange: (payload: Record<string, unknown>) => Promise<unknown>;
  canCreate: boolean;
  busy: boolean;
}) {
  const { money } = useMoney();
  const t = useTranslations("applications.sov");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({
    itemNo: "",
    description: "",
    scheduledValue: "",
    retainagePercent: "",
    incomeAccountId: "",
  });

  async function addLine() {
    const result = await onChange({
      action: "addSov",
      projectId,
      ...form,
      retainagePercent: form.retainagePercent || null,
      incomeAccountId: form.incomeAccountId || null,
      sortOrder: lines.length + 1,
    });
    if (result) {
      setForm({ itemNo: "", description: "", scheduledValue: "", retainagePercent: "", incomeAccountId: "" });
      setFormOpen(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("title")}
        description={t("workspaceHint")}
        action={canCreate ? <Button size="sm" onClick={() => setFormOpen(true)}>{t("addLine")}</Button> : undefined}
      />
      <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("item")}</TableHead>
              <TableHead>{t("description")}</TableHead>
              <TableHead className="text-right">{t("scheduledValue")}</TableHead>
              <TableHead className="text-right">{t("retainagePercent")}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell>
                  {line.itemNo ?? "—"}
                  {line.changeOrderId ? <Badge variant="secondary" className="ml-1.5">CO</Badge> : null}
                </TableCell>
                <TableCell className="font-medium">{line.description}</TableCell>
                <TableCell className="text-right tabular-nums">{money(line.scheduledValue)}</TableCell>
                <TableCell className="text-right tabular-nums">{line.retainagePercent ?? t("default")}</TableCell>
                <TableCell className="text-right">
                  {canCreate && !line.changeOrderId ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(t("deleteConfirm", { description: line.description }))) {
                          void onChange({ action: "deleteSov", id: line.id });
                        }
                      }}
                    >
                      {t("delete")}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
            {lines.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="py-10 text-center text-slate-500 dark:text-slate-400">{t("empty")}</TableCell></TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      <Drawer
        open={formOpen}
        stacked
        size="md"
        onClose={() => setFormOpen(false)}
        title={t("addLine")}
        description={t("formHint")}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setFormOpen(false)}>{t("cancel")}</Button>
            <Button disabled={busy || !form.description || !form.scheduledValue} onClick={addLine}>{t("addLine")}</Button>
          </div>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("item")}><Input value={form.itemNo} onChange={(event) => setForm({ ...form, itemNo: event.target.value })} /></Field>
          <Field label={t("description")}><Input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
          <Field label={t("scheduledValue")}><Input type="number" inputMode="decimal" value={form.scheduledValue} onChange={(event) => setForm({ ...form, scheduledValue: event.target.value })} /></Field>
          <Field label={t("retainagePercent")}><Input type="number" inputMode="decimal" value={form.retainagePercent} onChange={(event) => setForm({ ...form, retainagePercent: event.target.value })} /></Field>
          <div className="sm:col-span-2">
            <Field label={t("incomeAccount")}>
              <Select value={form.incomeAccountId} onChange={(event) => setForm({ ...form, incomeAccountId: event.target.value })}>
                <option value="">{t("defaultIncomeAccount")}</option>
                {incomeAccounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
              </Select>
            </Field>
          </div>
        </div>
      </Drawer>
    </div>
  );
}

function ChangeOrdersSection({
  projectId,
  orders,
  sov,
  onChange,
  canCreate,
  canApprove,
  busy,
}: {
  projectId: string;
  orders: ChangeOrder[];
  sov: SovLine[];
  onChange: (payload: Record<string, unknown>) => Promise<unknown>;
  canCreate: boolean;
  canApprove: boolean;
  busy: boolean;
}) {
  const { money } = useMoney();
  const t = useTranslations("applications.changeOrders");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ number: "", description: "", amount: "", targetSovLineId: "" });
  const deductive = form.amount.trim().startsWith("-");

  async function addOrder() {
    const result = await onChange({
      action: "addChangeOrder",
      projectId,
      ...form,
      targetSovLineId: form.targetSovLineId || null,
    });
    if (result) {
      setForm({ number: "", description: "", amount: "", targetSovLineId: "" });
      setFormOpen(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("title")}
        description={t("workspaceHint")}
        action={canCreate ? <Button size="sm" onClick={() => setFormOpen(true)}>{t("add")}</Button> : undefined}
      />
      <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("number")}</TableHead>
              <TableHead>{t("description")}</TableHead>
              <TableHead>{t("applyTo")}</TableHead>
              <TableHead className="text-right">{t("amount")}</TableHead>
              <TableHead>{t("statusLabel")}</TableHead>
              <TableHead className="w-36" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((order) => (
              <TableRow key={order.id}>
                <TableCell className="font-medium">CO {order.number}</TableCell>
                <TableCell>{order.description || "—"}</TableCell>
                <TableCell className="text-slate-500 dark:text-slate-400">{order.targetSovLineDescription || t("newScheduleLine")}</TableCell>
                <TableCell className="text-right tabular-nums">{money(order.amount)}</TableCell>
                <TableCell><Badge variant={order.status === "approved" ? "success" : "secondary"}>{t(`status.${order.status}`)}</Badge></TableCell>
                <TableCell className="text-right">
                  {order.status === "draft" && canApprove && order.independentApprovalAllowed ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => onChange({ action: "approveChangeOrder", id: order.id })}>{t("approve")}</Button>
                  ) : null}
                  {order.status === "draft" && canCreate ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(t("voidConfirm", { number: order.number }))) {
                          void onChange({ action: "voidChangeOrder", id: order.id });
                        }
                      }}
                    >
                      {t("void")}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
            {orders.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="py-10 text-center text-slate-500 dark:text-slate-400">{t("empty")}</TableCell></TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      <Drawer
        open={formOpen}
        stacked
        size="md"
        onClose={() => setFormOpen(false)}
        title={t("add")}
        description={t("formHint")}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setFormOpen(false)}>{t("cancel")}</Button>
            <Button disabled={busy || !form.number || !form.amount || (deductive && !form.targetSovLineId)} onClick={addOrder}>{t("add")}</Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("number")}><Input value={form.number} onChange={(event) => setForm({ ...form, number: event.target.value })} /></Field>
            <Field label={t("amount")}><Input type="number" inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></Field>
          </div>
          <Field label={t("description")}><Input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
          <Field label={t("applyTo")}>
            <Select value={form.targetSovLineId} onChange={(event) => setForm({ ...form, targetSovLineId: event.target.value })}>
              <option value="">{t("newScheduleLine")}</option>
              {sov.map((line) => <option key={line.id} value={line.id}>{line.itemNo ? `${line.itemNo} · ` : ""}{line.description}</option>)}
            </Select>
          </Field>
          <p className="text-xs text-slate-500 dark:text-slate-400">{deductive ? t("deductiveHint") : t("additiveHint")}</p>
        </div>
      </Drawer>
    </div>
  );
}

function PayApplicationsSection({
  projectId,
  apps,
  sov,
  onChange,
  setMsg,
  canCreate,
  canApprove,
  canInvoice,
  busy,
}: {
  projectId: string;
  apps: PayApp[];
  sov: SovLine[];
  onChange: (payload: Record<string, unknown>) => Promise<unknown>;
  setMsg: (message: string | null) => void;
  canCreate: boolean;
  canApprove: boolean;
  canInvoice: boolean;
  busy: boolean;
}) {
  const { money } = useMoney();
  const t = useTranslations("applications.payApplications");
  const [newOpen, setNewOpen] = useState(false);
  const [periodEnd, setPeriodEnd] = useState("");
  const [drawApp, setDrawApp] = useState<PayApp | null>(null);

  async function createApplication() {
    const result = await onChange({ action: "createPayApp", projectId, periodEnd });
    if (result) {
      setPeriodEnd("");
      setNewOpen(false);
    }
  }

  async function bill(appId: string) {
    const result = (await onChange({ action: "billPayApp", payApplicationId: appId })) as any;
    if (result?.invoiceId) {
      setMsg(t("billedMessage", {
        number: result.documentNumber,
        currentDue: money(result.currentDue),
        retainage: money(result.retainage),
      }));
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("title")}
        description={t("workspaceHint")}
        action={canCreate ? <Button size="sm" disabled={sov.length === 0} onClick={() => setNewOpen(true)}>{t("newApplication")}</Button> : undefined}
      />
      <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("application")}</TableHead>
              <TableHead>{t("periodEnding")}</TableHead>
              <TableHead>{t("statusLabel")}</TableHead>
              <TableHead>{t("invoice")}</TableHead>
              <TableHead className="text-right">{t("amount")}</TableHead>
              <TableHead className="w-60" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.map((app) => (
              <TableRow key={app.id}>
                <TableCell className="font-medium">
                  {t("applicationNumber", { number: app.applicationNumber })}
                  {app.kind === "retainage_release" ? <Badge variant="secondary" className="ml-2">{t("retainage")}</Badge> : null}
                </TableCell>
                <TableCell>{app.periodEnd}</TableCell>
                <TableCell>
                  <Badge variant={app.status === "invoiced" || app.status === "posted" ? "success" : app.status === "submitted" ? "warning" : "secondary"}>
                    {app.status === "invoiced" || app.status === "posted" ? t("status.invoiced") : t(`status.${app.status}`)}
                  </Badge>
                </TableCell>
                <TableCell>
                  {app.invoiceDocumentId ? (
                    <Link className="font-medium text-teal-700 hover:underline dark:text-teal-300" href={`/ar/invoices?doc=${app.invoiceDocumentId}`}>
                      {app.invoiceNumber ?? t("openInvoice")}
                    </Link>
                  ) : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">{app.invoiceTotal ? money(app.invoiceTotal) : "—"}</TableCell>
                <TableCell className="text-right">
                  {app.status === "draft" && canCreate ? <Button size="sm" variant="ghost" onClick={() => setDrawApp(app)}>{t("enterDraws")}</Button> : null}
                  {app.status === "submitted" && canApprove && app.independentApprovalAllowed ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => onChange({ action: "approvePayApp", payApplicationId: app.id })}>{t("approve")}</Button> : null}
                  {app.status === "approved" && canInvoice ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => bill(app.id)}>{t("createInvoice")}</Button> : null}
                  {["draft", "submitted", "approved"].includes(app.status) && canApprove ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(t("voidConfirm", { number: app.applicationNumber }))) {
                          void onChange({ action: "voidPayApp", payApplicationId: app.id });
                        }
                      }}
                    >
                      {t("void")}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
            {apps.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="py-10 text-center text-slate-500 dark:text-slate-400">{t("empty")}</TableCell></TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      <Drawer
        open={newOpen}
        stacked
        size="sm"
        onClose={() => setNewOpen(false)}
        title={t("newApplication")}
        description={t("newHint")}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setNewOpen(false)}>{t("cancel")}</Button>
            <Button disabled={busy || !periodEnd || sov.length === 0} onClick={createApplication}>{t("create")}</Button>
          </div>
        }
      >
        <Field label={t("periodEnding")}><Input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></Field>
      </Drawer>

      {drawApp ? (
        <DrawEntryDrawer
          app={drawApp}
          sov={sov}
          busy={busy}
          onClose={() => setDrawApp(null)}
          onSubmit={async (lines) => {
            const result = await onChange({ action: "submitPayApp", payApplicationId: drawApp.id, lines });
            if (result) {
              setMsg(t("submittedMessage"));
              setDrawApp(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function DrawEntryDrawer({
  app,
  sov,
  busy,
  onClose,
  onSubmit,
}: {
  app: PayApp;
  sov: SovLine[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (lines: { sovLineId: string; thisPeriodCompleted: string; materialsStored: string }[]) => Promise<void>;
}) {
  const t = useTranslations("applications.payApplications");
  const [lines, setLines] = useState<Record<string, { thisPeriodCompleted: string; materialsStored: string }>>({});
  const submitLines = Object.entries(lines).map(([sovLineId, value]) => ({ sovLineId, ...value }));

  return (
    <Drawer
      open
      stacked
      size="xl"
      onClose={onClose}
      title={t("applicationNumber", { number: app.applicationNumber })}
      description={t("drawHint", { periodEnd: app.periodEnd })}
      bodyClassName="overflow-auto p-4"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("cancel")}</Button>
          <Button disabled={busy} onClick={() => onSubmit(submitLines)}>{t("submit")}</Button>
        </div>
      }
    >
      <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("item")}</TableHead>
              <TableHead>{t("description")}</TableHead>
              <TableHead className="text-right">{t("workThisPeriod")}</TableHead>
              <TableHead className="text-right">{t("materialsStored")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sov.map((line) => (
              <TableRow key={line.id}>
                <TableCell>{line.itemNo ?? "—"}</TableCell>
                <TableCell className="font-medium">{line.description}</TableCell>
                <TableCell>
                  <Input
                    type="number"
                    inputMode="decimal"
                    className="ml-auto w-36 text-right tabular-nums"
                    value={lines[line.id]?.thisPeriodCompleted ?? ""}
                    onChange={(event) => setLines({
                      ...lines,
                      [line.id]: {
                        ...(lines[line.id] ?? { thisPeriodCompleted: "", materialsStored: "" }),
                        thisPeriodCompleted: event.target.value,
                      },
                    })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    inputMode="decimal"
                    className="ml-auto w-36 text-right tabular-nums"
                    value={lines[line.id]?.materialsStored ?? ""}
                    onChange={(event) => setLines({
                      ...lines,
                      [line.id]: {
                        ...(lines[line.id] ?? { thisPeriodCompleted: "", materialsStored: "" }),
                        materialsStored: event.target.value,
                      },
                    })}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Drawer>
  );
}

function RetainageSection({
  projectId,
  held,
  onChange,
  setMsg,
  canInvoice,
  busy,
}: {
  projectId: string;
  held: string;
  onChange: (payload: Record<string, unknown>) => Promise<unknown>;
  setMsg: (message: string | null) => void;
  canInvoice: boolean;
  busy: boolean;
}) {
  const { money } = useMoney();
  const t = useTranslations("applications.retainage");
  const [formOpen, setFormOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");

  async function release() {
    const result = (await onChange({ action: "releaseRetainage", projectId, amount, periodEnd })) as any;
    if (result?.invoiceId) {
      setMsg(t("createdMessage", { number: result.documentNumber, amount: money(result.amount) }));
      setAmount("");
      setPeriodEnd("");
      setFormOpen(false);
    }
  }

  return (
    <>
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <div className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{t("heldLabel")}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{money(held)}</div>
            <p className="mt-1 max-w-xl text-xs leading-5 text-slate-500 dark:text-slate-400">{t("workspaceHint")}</p>
          </div>
          {canInvoice ? <Button size="sm" disabled={Number(held) <= 0} onClick={() => setFormOpen(true)}>{t("release")}</Button> : null}
        </CardContent>
      </Card>

      <Drawer
        open={formOpen}
        stacked
        size="sm"
        onClose={() => setFormOpen(false)}
        title={t("title")}
        description={t("description", { held: money(held) })}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setFormOpen(false)}>{t("cancel")}</Button>
            <Button disabled={busy || !amount || !periodEnd} onClick={release}>{t("release")}</Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Field label={t("amount")}><Input type="number" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>
          <Field label={t("periodEnding")}><Input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></Field>
        </div>
      </Drawer>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
