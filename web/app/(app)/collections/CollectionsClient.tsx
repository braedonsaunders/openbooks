"use client";

import { PagedTable } from "@/components/paged-table";
import { ListPageLayout } from "@/components/page-layout";
import { SetupDrawer } from "../admin/setup/[entity]/SetupDrawer";
import { BILLING_ENTITIES } from "@/lib/setup/entities/billing";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { Field } from "@/components/field";
import { InspectorPanel } from "@/components/builder/builder-kit";
import { SwitchField } from "@/components/switch";
import { CollectionsQueue } from "./CollectionsQueue";
import { ListDrawerHost } from "@/components/list-drawer-host";
import { KpiStrip } from "@/components/kpi-strip";
import { useMoney } from "@/components/money-provider";
import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { ModuleHomeTabs } from "@/components/module-home/ui";
import { useTranslations } from "next-intl";
import { enumLabel } from "@/lib/enum-label";
import {
  Badge,
  Button,
  Card,
  Drawer,
  Input,
  PageHeader,
  SearchSelect,
  Select,
} from "@openbooks/ui";
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
  retryOffsetsDays?: { days: number }[];
  finalAction?: string;
}

const CADENCES = [
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "annually",
  "custom_cron",
];
const INTERVALS = ["weekly", "monthly", "quarterly", "annually"];
type Opt = { id: string; name?: string; label?: string };

interface Plan {
  id: string;
  name: string;
  description: string | null;
  amount: string;
  currency: string | null;
  interval: string;
  intervalCount: number;
  incomeAccountId: string | null;
  taxCodeId: string | null;
  isActive: boolean;
}
interface Subscription {
  id: string;
  customerId: string;
  customerName: string | null;
  planId: string;
  planName: string;
  quantity: string;
  priceOverride: string | null;
  status: string;
  startOn: string;
  nextBillOn: string;
  autoPost: boolean;
  runCount: number;
  lastError: string | null;
  mrr: string;
  planCurrency: string | null;
  advancedLifecycle?: boolean;
}
interface SubscriptionActionBody {
  documentNumber?: string;
  adjustment?: string;
  invoiceId?: string;
  proration?: { documentNumber?: string; amount?: string };
}

export type CollectionsView =
  | "worklist"
  | "policies"
  | "recurring"
  | "subscriptions"
  | "plans"
  | "versions"
  | "contracts"
  | "amendments"
  | "recovery"
  | "attempts";
type EditorProps = { creating: boolean; onClose: () => void };

export function CollectionsClient({
  subscriptionsEnabled = false,
  advancedSubscriptionsEnabled = false,
  customers = [],
  incomeAccounts = [],
  title,
  description,
  tabs = [],
  autopayOn = false,
  worklistEnabled = false,
  initialView,
}: {
  subscriptionsEnabled?: boolean;
  advancedSubscriptionsEnabled?: boolean;
  customers?: Opt[];
  incomeAccounts?: Opt[];
  title?: string;
  description?: string;
  tabs?: ComponentProps<typeof ModuleHomeTabs>["tabs"];
  autopayOn?: boolean;
  worklistEnabled?: boolean;
  initialView?: string;
}) {
  const search = useSearchParams();
  const t = useTranslations("ar.collections");
  const newAction = useTranslations("ar.collections.actions");
  const requested =
    initialView ??
    search?.get("view") ??
    (worklistEnabled ? "worklist" : "policies");
  const available: CollectionsView[] = [
    ...(autopayOn ? (["recovery", "attempts"] as const) : []),
    ...(worklistEnabled ? ["worklist" as const] : []),
    "policies",
    "recurring",
    ...(subscriptionsEnabled
      ? ["subscriptions" as const, "plans" as const]
      : []),
    ...(advancedSubscriptionsEnabled
      ? ["versions" as const, "contracts" as const, "amendments" as const]
      : []),
  ];
  const view =
    available.find((candidate) => candidate === requested) ?? available[0]!;
  // Recovery and attempts own their page views with the server blocks: the
  // shell renders its header and tab strip there, never an operational
  // panel beside them.
  const panelView =
    view === "recovery" || view === "attempts" ? null : view;
  const [creatingFor, setCreatingFor] = useState<CollectionsView | null>(null);
  const router = useRouter();
  const editor = {
    creating: creatingFor === view,
    onClose: () => setCreatingFor(null),
  };
  const openNew = () =>
    view === "policies"
      ? router.push("/collections?view=policies&policy=new")
      : setCreatingFor(view);
  return (
    <ListPageLayout
      header={
        <PageHeader
          title={title ?? t("title")}
          description={description ?? t("pageDescription")}
          actions={[
            panelView && panelView !== "worklist" ? (
              <Button key="new" onClick={openNew}>
                <Plus size={16} />
                {newAction(panelView)}
              </Button>
            ) : null,
            <ModuleHomeTabs key="tabs" tabs={tabs} />,
          ]}
        />
      }
    >
      {view === "worklist" && <CollectionsQueue />}
      {view === "recurring" && <RecurringPanel {...editor} />}
      {(view === "subscriptions" || view === "plans") && (
        <SubscriptionsPanel
          key={view}
          view={view}
          {...editor}
          customers={customers}
          incomeAccounts={incomeAccounts}
        />
      )}
      {(view === "versions" ||
        view === "contracts" ||
        view === "amendments") && (
        <AdvancedSubscriptionsPanel key={view} view={view} {...editor} />
      )}
      {view === "policies" && <DunningPanel />}
      <ListDrawerHost source="subscription" />
    </ListPageLayout>
  );
}

function SubscriptionsPanel({
  customers,
  incomeAccounts,
  view,
  creating,
  onClose,
}: {
  customers: Opt[];
  incomeAccounts: Opt[];
  view: "plans" | "subscriptions";
} & EditorProps) {
  const { money } = useMoney();
  const t = useTranslations("ar.collections.subscriptions");
  const forms = useTranslations("ar.collections.forms");
  const newAction = useTranslations("ar.collections.actions");
  const cadence = useTranslations("ar.collections.recurring.cadences");
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
  const [retention, setRetention] = useState<{
    month: string | null;
    rows: Array<{ currency: string; values: Record<string, string | null> }>;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planForm, setPlanForm] = useState({
    name: "",
    amount: "",
    interval: "monthly",
    intervalCount: "1",
    incomeAccountId: "",
  });
  const resetPlanForm = () =>
    setPlanForm({ name: "", amount: "", interval: "monthly", intervalCount: "1", incomeAccountId: "" });
  // Plan editing reuses the create drawer: the row's stored values prefill
  // the form, and save posts updatePlan with the row's unexposed fields
  // (description, tax code, active flag) carried through, so editing never
  // wipes what the form does not show. Currency and item stay untouched by
  // omitting their keys, which updatePlan preserves.
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);
  const [subForm, setSubForm] = useState({
    customerId: "",
    planId: "",
    quantity: "1",
    priceOverride: "",
    startOn: "",
    firstBillOn: "",
    prorateFirstPeriod: false,
    autoPost: false,
  });
  const [changing, setChanging] = useState<string | null>(null);
  const [changeQty, setChangeQty] = useState("");
  const action = useAppAction();

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body. Named refusals surface
  // through the shared read; transport outages pin the fallback and keep the
  // last good table with its retry instead of emptying it.
  const load = useCallback(async () => {
    const result = await fetchAction<{
      plans?: Plan[];
      subscriptions?: Subscription[];
      mrr?: string;
    }>("/api/subscriptions");
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
    if (view === "subscriptions") {
      // Supplementary surface: operators without usage.read never see the
      // strip, so a refusal here hides it instead of failing the page.
      const retentionResult = await fetchAction<{
        month: string | null;
        rows: Array<{ currency: string; values: Record<string, string | null> }>;
      }>("/api/metrics/retention");
      setRetention(retentionResult.ok ? retentionResult.data : null);
    }
  }, [tErrors, view]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const post = async (
    payload: Record<string, unknown>,
  ): Promise<SubscriptionActionBody | null> => {
    setError(null);
    setMsg(null);
    // Assigned inside the execute task below, which execute awaits before it
    // resolves: by the return the closure has run, but control-flow analysis
    // cannot see that, so the declared return type carries the contract.
    let body: SubscriptionActionBody | null = null;
    const ok = await action.execute(
      async () => {
        const result = await fetchAction<SubscriptionActionBody>(
          "/api/subscriptions",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        if (result.ok) body = result.data ?? {};
        return result;
      },
      {
        fallbackMessage: tErrors("actionFailed"),
        onRefused: (refusal) =>
          setError(refusal.displayMessage(tErrors("actionFailed"))),
        onOk: () => {
          void load();
        },
      },
    );
    return ok ? body : null;
  };

  return (
    <div className="space-y-6">
      {loadError && (
        <div
          role="alert"
          className="flex items-center gap-3 text-sm text-red-600"
        >
          {loadError}
          <Button variant="outline" onClick={() => void load()}>
            {tCommonActions("retry")}
          </Button>
        </div>
      )}
      {loaded && view === "subscriptions" && (
        <Card className="flex items-center justify-between p-4">
          <div>
            <div className="text-xs text-muted-foreground">{t("mrr")}</div>
            <div className="text-2xl font-semibold">{money(mrr)}</div>
          </div>
          <div className="text-sm text-muted-foreground">
            {t("summary", {
              active: subs.filter((s) => s.status === "active").length,
              plans: plans.length,
            })}
          </div>
        </Card>
      )}
      {loaded && view === "subscriptions" && retention?.month && retention.rows.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">
            {t("retentionForMonth", { month: retention.month.slice(0, 7) })}
          </div>
          <KpiStrip
            items={[
              { label: t("retentionArr"), value: retention.rows[0]!.values.arr ?? "—", suffix: retention.rows[0]!.currency },
              { label: t("retentionNrr"), value: retention.rows[0]!.values.nrr ?? "—", suffix: "%" },
              { label: t("retentionGrr"), value: retention.rows[0]!.values.grr ?? "—", suffix: "%" },
              { label: t("retentionRevenueChurn"), value: retention.rows[0]!.values.revenue_churn ?? "—", suffix: "%" },
              { label: t("retentionLogoChurn"), value: retention.rows[0]!.values.logo_churn ?? "—", suffix: "%" },
              { label: t("retentionArpa"), value: retention.rows[0]!.values.arpa ?? "—", suffix: retention.rows[0]!.currency },
              { label: t("retentionQuickRatio"), value: retention.rows[0]!.values.quick_ratio ?? "—" },
            ]}
          />
        </div>
      )}
      {loaded && view === "subscriptions" && retention && !retention.month && (
        <p className="text-xs text-muted-foreground">{t("retentionUnavailable")}</p>
      )}

      {error && !creating && !changing && (
        <p role="alert" className="text-sm text-red-600">
          {error}{" "}
          <Button
            size="sm"
            variant="ghost"
            disabled={action.busy}
            onClick={() => void load()}
          >
            {tc("actions.retry")}
          </Button>
        </p>
      )}
      {msg && <p className="text-sm text-teal-700 dark:text-teal-300">{msg}</p>}

      {/* Plans */}
      {view === "plans" && (
        <>
          <PagedTable
            source="collections_plans"
            searchable
            rows={plans}
            rowKey={(p) => p.id}
            empty={loaded ? t("noPlans") : tc("feedback.loading")}
            columns={[
              {
                key: "name",
                header: <>{t("plansTable.plan")}</>,
                cell: (p) => (
                  <>
                    {p.name}
                    {!p.isActive && (
                      <span className="ml-1 text-xs text-slate-400">
                        {t("archived")}
                      </span>
                    )}
                  </>
                ),
                search: (p) => p.name ?? "",
              },
              {
                key: "amount",
                header: <>{t("plansTable.price")}</>,
                cell: (p) => (
                  <>{money(p.amount, { currency: p.currency ?? undefined })}</>
                ),
              },
              {
                key: "interval",
                header: <>{t("plansTable.billing")}</>,
                cell: (p) => (
                  <>
                    {t("every", {
                      count: p.intervalCount > 1 ? `${p.intervalCount} ` : "",
                      unit: p.interval.replace(
                        "ly",
                        p.intervalCount > 1 ? "s" : "",
                      ),
                    })}
                  </>
                ),
              },
              {
                key: "actions",
                header: <></>,
                cell: (p) => (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={action.busy}
                      onClick={() => {
                        setPlanForm({
                          name: p.name,
                          amount: p.amount,
                          interval: p.interval,
                          intervalCount: String(p.intervalCount),
                          incomeAccountId: p.incomeAccountId ?? "",
                        });
                        setEditingPlan(p);
                      }}
                    >
                      {tCommonActions("edit")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={action.busy}
                      onClick={() => post({ action: "deletePlan", id: p.id })}
                    >
                      {t("delete")}
                    </Button>
                  </>
                ),
              },
            ]}
          />
          <Drawer
            open={creating || editingPlan !== null}
            onClose={() => {
              setEditingPlan(null);
              onClose();
            }}
            title={editingPlan ? newAction("editPlan") : newAction("plans")}
            size="xl"
            headerActions={
              <Button
                disabled={action.busy || !planForm.name || !planForm.amount}
                onClick={async () => {
                  const r = await post(
                    editingPlan
                      ? {
                          action: "updatePlan",
                          id: editingPlan.id,
                          name: planForm.name,
                          description: editingPlan.description,
                          amount: planForm.amount,
                          interval: planForm.interval,
                          intervalCount: Number(planForm.intervalCount || 1),
                          incomeAccountId: planForm.incomeAccountId || null,
                          taxCodeId: editingPlan.taxCodeId,
                          isActive: editingPlan.isActive,
                        }
                      : {
                          action: "addPlan",
                          ...planForm,
                          intervalCount: Number(planForm.intervalCount || 1),
                          incomeAccountId: planForm.incomeAccountId || null,
                        },
                  );
                  if (!r) return;
                  onClose();
                  setEditingPlan(null);
                  resetPlanForm();
                }}
              >
                {editingPlan ? tCommonActions("save") : t("addPlan")}
              </Button>
            }
          >
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="space-y-5">
              <InspectorPanel title={forms("planDetails")}>
                <Field label={t("plansTable.plan")} required>
                  <Input
                    value={planForm.name}
                    onChange={(e) =>
                      setPlanForm({ ...planForm, name: e.target.value })
                    }
                  />
                </Field>
              </InspectorPanel>
              <InspectorPanel title={forms("billing")}>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label={t("plansTable.price")} required>
                    <Input
                      inputMode="decimal"
                      value={planForm.amount}
                      onChange={(e) =>
                        setPlanForm({ ...planForm, amount: e.target.value })
                      }
                    />
                  </Field>
                  <Field label={forms("incomeAccount")}>
                    <SearchSelect
                      searchable
                      clearable
                      value={planForm.incomeAccountId}
                      onChange={(value) =>
                        setPlanForm({ ...planForm, incomeAccountId: value })
                      }
                      options={incomeAccounts.map((a) => ({
                        value: a.id,
                        label: a.label ?? a.name ?? a.id,
                      }))}
                      placeholder={t("defaultIncomeAccount")}
                    />
                  </Field>
                  <Field label={forms("interval")}>
                    <Select
                      value={planForm.interval}
                      onChange={(e) =>
                        setPlanForm({ ...planForm, interval: e.target.value })
                      }
                    >
                      {INTERVALS.map((i) => (
                        <option key={i} value={i}>
                          {cadence(i)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={forms("intervalCount")}>
                    <Input
                      type="number"
                      min="1"
                      value={planForm.intervalCount}
                      onChange={(e) =>
                        setPlanForm({
                          ...planForm,
                          intervalCount: e.target.value,
                        })
                      }
                    />
                  </Field>
                </div>
              </InspectorPanel>
            </div>
          </Drawer>
        </>
      )}

      {/* Subscriptions */}
      {view === "subscriptions" && (
        <>
          <PagedTable
            source="collections_subscriptions"
            searchable
            rows={subs}
            rowKey={(s) => s.id}
            empty={loaded ? t("noSubs") : tc("feedback.loading")}
            columns={[
              {
                key: "customerName",
                header: <>{t("subsTable.customer")}</>,
                cell: (s) => <>{s.customerName ?? "—"}</>,
                search: (s) => s.customerName ?? "",
              },
              {
                key: "planName",
                header: <>{t("subsTable.plan")}</>,
                cell: (s) => <>{s.planName}</>,
                search: (s) => s.planName ?? "",
              },
              {
                key: "quantity",
                header: <>{t("subsTable.qty")}</>,
                cell: (s) => <>{s.quantity}</>,
              },
              {
                key: "mrr",
                header: <>{t("subsTable.mrr")}</>,
                cell: (s) => (
                  <>
                    {s.status === "active"
                      ? money(s.mrr, { currency: s.planCurrency ?? undefined })
                      : "—"}
                  </>
                ),
              },
              {
                key: "nextBillOn",
                header: <>{t("subsTable.nextBill")}</>,
                cell: (s) => (
                  <>
                    {s.nextBillOn}
                    {s.lastError && (
                      <span className="ml-1 text-red-600" title={s.lastError}>
                        ⚠
                      </span>
                    )}
                  </>
                ),
              },
              {
                key: "status",
                header: <>{t("subsTable.status")}</>,
                cell: (s) => (
                  <>
                    <Badge
                      variant={s.status === "active" ? "default" : "secondary"}
                    >
                      {enumLabel(
                        s.status,
                        subscriptionStatusLabels,
                        tCommon("labels.unknownValue"),
                      )}
                    </Badge>
                  </>
                ),
              },
              {
                key: "actions",
                header: <></>,
                cell: (s) => (
                  <>
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={action.busy}
                        onClick={async () => {
                          const r = await post({ action: "billNow", id: s.id });
                          if (r?.invoiceId && r.documentNumber)
                            setMsg(
                              t("toasts.billed", {
                                documentNumber: r.documentNumber,
                              }),
                            );
                        }}
                      >
                        {t("billNow")}
                      </Button>
                      {s.status === "active" && !s.advancedLifecycle && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={action.busy}
                          onClick={() => {
                            setChanging(s.id);
                            setChangeQty(s.quantity);
                          }}
                        >
                          {t("changeQty")}
                        </Button>
                      )}
                      {s.status === "active" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={action.busy}
                          onClick={() =>
                            post({
                              action: "updateSubscription",
                              id: s.id,
                              status: "paused",
                            })
                          }
                        >
                          {t("pause")}
                        </Button>
                      ) : s.status === "paused" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={action.busy}
                          onClick={() =>
                            post({
                              action: "updateSubscription",
                              id: s.id,
                              status: "active",
                            })
                          }
                        >
                          {t("resume")}
                        </Button>
                      ) : null}
                      {s.status !== "canceled" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={action.busy}
                          onClick={async () => {
                            const confirmed = await confirmDialog({
                              title: t("cancelConfirmTitle"),
                              message: t("cancelConfirmBody"),
                              confirmLabel: t("cancelSubscription"),
                              cancelLabel: t("keepSubscription"),
                              tone: "danger",
                            });
                            if (confirmed)
                              post({
                                action: "updateSubscription",
                                id: s.id,
                                status: "canceled",
                              });
                          }}
                        >
                          {t("cancelSub")}
                        </Button>
                      )}
                    </>
                  </>
                ),
              },
            ]}
          />
          <Drawer
            open={creating}
            onClose={onClose}
            title={newAction("subscriptions")}
            size="xl"
            headerActions={
              <Button
                disabled={action.busy || !subForm.customerId || !subForm.planId}
                onClick={async () => {
                  const r = await post({
                    action: "addSubscription",
                    ...subForm,
                    priceOverride: subForm.priceOverride || null,
                  });
                  if (!r) return;
                  onClose();
                  if (r.proration?.documentNumber)
                    setMsg(
                      t("toasts.firstInvoiceProrated", {
                        documentNumber: r.proration.documentNumber,
                        amount: money(r.proration.amount),
                      }),
                    );
                  setSubForm({
                    customerId: "",
                    planId: "",
                    quantity: "1",
                    priceOverride: "",
                    startOn: "",
                    firstBillOn: "",
                    prorateFirstPeriod: false,
                    autoPost: false,
                  });
                }}
              >
                {t("addSubscription")}
              </Button>
            }
          >
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="space-y-5">
              <InspectorPanel title={forms("subscriptionDetails")}>
                <Field label={t("subsTable.customer")} required>
                  <SearchSelect
                    searchable
                    value={subForm.customerId}
                    onChange={(value) =>
                      setSubForm({ ...subForm, customerId: value })
                    }
                    options={customers.map((c) => ({
                      value: c.id,
                      label: c.name ?? c.label ?? c.id,
                    }))}
                    placeholder={t("customerPlaceholder")}
                  />
                </Field>
                <Field label={t("subsTable.plan")} required>
                  <SearchSelect
                    searchable
                    value={subForm.planId}
                    onChange={(value) =>
                      setSubForm({ ...subForm, planId: value })
                    }
                    options={plans
                      .filter((p) => p.isActive)
                      .map((p) => ({
                        value: p.id,
                        label: p.name,
                        hint: money(p.amount, {
                          currency: p.currency ?? undefined,
                        }),
                      }))}
                    placeholder={t("planPlaceholder")}
                  />
                </Field>
              </InspectorPanel>
              <InspectorPanel title={forms("billing")}>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label={t("subsTable.qty")}>
                    <Input
                      inputMode="decimal"
                      value={subForm.quantity}
                      onChange={(e) =>
                        setSubForm({ ...subForm, quantity: e.target.value })
                      }
                    />
                  </Field>
                  <Field label={forms("priceOverride")}>
                    <Input
                      inputMode="decimal"
                      value={subForm.priceOverride}
                      onChange={(e) =>
                        setSubForm({
                          ...subForm,
                          priceOverride: e.target.value,
                        })
                      }
                      placeholder={t("priceOverridePlaceholder")}
                    />
                  </Field>
                  <Field label={forms("startOn")}>
                    <Input
                      type="date"
                      value={subForm.startOn}
                      onChange={(e) =>
                        setSubForm({ ...subForm, startOn: e.target.value })
                      }
                    />
                  </Field>
                  <Field label={t("firstFullBill")}>
                    <Input
                      type="date"
                      value={subForm.firstBillOn}
                      onChange={(e) =>
                        setSubForm({ ...subForm, firstBillOn: e.target.value })
                      }
                    />
                  </Field>
                </div>
                <SwitchField
                  label={t("prorateFirstPeriod")}
                  description={t("prorateHint")}
                  on={subForm.prorateFirstPeriod}
                  onToggle={() =>
                    setSubForm({
                      ...subForm,
                      prorateFirstPeriod: !subForm.prorateFirstPeriod,
                    })
                  }
                />
                <SwitchField
                  label={t("autoPostInvoices")}
                  on={subForm.autoPost}
                  onToggle={() =>
                    setSubForm({ ...subForm, autoPost: !subForm.autoPost })
                  }
                />
              </InspectorPanel>
            </div>
          </Drawer>
        </>
      )}
      <Drawer
        open={!!changing}
        onClose={() => setChanging(null)}
        title={t("changeQty")}
        description={subs.find((sub) => sub.id === changing)?.planName}
        size="lg"
        headerActions={
          <Button
            disabled={action.busy}
            onClick={async () => {
              const r = await post({
                action: "changeSubscription",
                id: changing,
                quantity: changeQty,
              });
              if (!r) return;
              setMsg(
                r.documentNumber
                  ? t("toasts.prorated", {
                      adjustment: money(r.adjustment),
                      documentNumber: r.documentNumber,
                    })
                  : t("toasts.qtyUpdatedNoProration"),
              );
              setChanging(null);
            }}
          >
            {t("apply")}
          </Button>
        }
      >
        {error && (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {error}
          </p>
        )}
        <InspectorPanel
          title={forms("subscriptionDetails")}
          description={subs.find((sub) => sub.id === changing)?.customerName}
        >
          <Field label={t("subsTable.qty")} required>
            <Input
              inputMode="decimal"
              value={changeQty}
              onChange={(e) => setChangeQty(e.target.value)}
            />
          </Field>
        </InspectorPanel>
      </Drawer>
    </div>
  );
}

function RecurringPanel({ creating, onClose }: EditorProps) {
  const forms = useTranslations("ar.collections.forms");
  const [rows, setRows] = useState<Schedule[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">(
    "loading",
  );
  const action = useAppAction();
  const busy = action.busy;
  const [form, setForm] = useState({
    templateDocumentNumber: "",
    cadence: "monthly",
    cron: "",
    nextRunOn: "",
    autoPost: false,
  });
  const [error, setError] = useState<string | null>(null);
  const t = useTranslations("ar.collections.recurring");
  const tErrors = useTranslations("ar.collections.errors");
  const common = useTranslations("common");

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body.
  const load = useCallback(() => {
    setLoadState("loading");
    return fetch("/api/recurring")
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            await readApiErrorMessage(r, common("feedback.loadFailed")),
          );
        const body = await r.json();
        setRows(body.schedules ?? []);
        setLoadState("loaded");
      })
      .catch((cause: unknown) => {
        setLoadState("failed");
        setError(
          cause instanceof Error
            ? cause.message
            : common("feedback.loadFailed"),
        );
      });
  }, [common]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const create = async () => {
    setError(null);
    await action.execute(
      () =>
        fetchAction("/api/recurring", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            templateDocumentNumber: form.templateDocumentNumber,
            cadence: form.cadence,
            cron: form.cadence === "custom_cron" ? form.cron : null,
            nextRunOn: form.nextRunOn || undefined,
            autoPost: form.autoPost,
          }),
        }),
      {
        fallbackMessage: tErrors("couldNotCreate"),
        onRefused: (refusal) =>
          setError(refusal.displayMessage(tErrors("couldNotCreate"))),
        onOk: () => {
          onClose();
          setForm({
            templateDocumentNumber: "",
            cadence: "monthly",
            cron: "",
            nextRunOn: "",
            autoPost: false,
          });
          void load();
        },
      },
    );
  };

  const act = async (
    id: string,
    method: "PATCH" | "DELETE" | "POST",
    body?: unknown,
  ) => {
    setError(null);
    await action.execute(
      async () => {
        const result = await fetchAction(`/api/recurring/${id}`, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        if (!result.ok && result.error.code === "generated_documents_exist") {
          return {
            ok: false as const,
            error: new ActionError({
              kind: "refused",
              code: result.error.code,
              serverMessage: t("generatedDocumentsDeleteConflict"),
            }),
          };
        }
        return result;
      },
      {
        fallbackMessage: t("actionFailed"),
        onRefused: (refusal) =>
          setError(refusal.displayMessage(t("actionFailed"))),
        onOk: () => {
          void load();
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <Drawer
        open={creating}
        onClose={onClose}
        title={t("newSchedule")}
        size="xl"
        headerActions={
          <Button
            onClick={create}
            disabled={busy || !form.templateDocumentNumber}
          >
            {t("createSchedule")}
          </Button>
        }
      >
        {error && (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="space-y-5">
          <InspectorPanel title={forms("scheduleDetails")}>
            <Field label={t("templateDocLabel")} required>
              <Input
                placeholder={t("templateDocPlaceholder")}
                value={form.templateDocumentNumber}
                onChange={(e) =>
                  setForm({ ...form, templateDocumentNumber: e.target.value })
                }
              />
            </Field>
          </InspectorPanel>
          <InspectorPanel title={forms("timing")}>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label={t("cadenceLabel")}>
                <Select
                  value={form.cadence}
                  onChange={(e) =>
                    setForm({ ...form, cadence: e.target.value })
                  }
                >
                  {CADENCES.map((c) => (
                    <option key={c} value={c}>
                      {t(`cadences.${c}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("firstRunLabel")}>
                <Input
                  type="date"
                  value={form.nextRunOn}
                  onChange={(e) =>
                    setForm({ ...form, nextRunOn: e.target.value })
                  }
                />
              </Field>
              {form.cadence === "custom_cron" && (
                <Field
                  label={t("cronLabel")}
                  className="sm:col-span-2"
                  required
                >
                  <Input
                    placeholder="0 9 1 * *"
                    value={form.cron}
                    onChange={(e) => setForm({ ...form, cron: e.target.value })}
                  />
                </Field>
              )}
            </div>
            <SwitchField
              label={t("autoPostCheckbox")}
              on={form.autoPost}
              onToggle={() => setForm({ ...form, autoPost: !form.autoPost })}
            />
          </InspectorPanel>
        </div>
      </Drawer>

      {error && !creating && (
        <p role="alert" className="text-sm text-destructive">
          {error}{" "}
          <Button variant="outline" onClick={() => void load()}>
            {common("actions.retry")}
          </Button>
        </p>
      )}
      <PagedTable
        source="collections_recurring"
        searchable
        rows={rows}
        rowKey={(row) => row.id}
        empty={
          loadState === "loaded"
            ? t("noneYet")
            : loadState === "failed"
              ? common("feedback.loadFailed")
              : common("feedback.loading")
        }
        columns={[
          {
            key: "template",
            headerClassName: "whitespace-nowrap",
            header: t("table.template"),
            search: (s) => s.templateNumber,
            cell: (s) => (
              <span className="font-medium">{s.templateNumber}</span>
            ),
          },
          {
            key: "customer",
            headerClassName: "whitespace-nowrap",
            header: t("table.customer"),
            search: (s) => s.partyName ?? "",
            cell: (s) => s.partyName ?? "—",
          },
          {
            key: "cadence",
            headerClassName: "whitespace-nowrap",
            header: t("table.cadence"),
            cell: (s) => (
              <>
                {t(`cadences.${s.cadence}`)}
                {s.cron ? ` (${s.cron})` : ""}
              </>
            ),
          },
          {
            key: "nextRun",
            headerClassName: "whitespace-nowrap",
            header: t("table.nextRun"),
            cell: (s) => s.nextRunOn,
          },
          {
            key: "runs",
            headerClassName: "whitespace-nowrap",
            header: t("table.runs"),
            cell: (s) => (
              <>
                {s.runCount}
                {s.lastError && (
                  <span className="ml-1 text-destructive" title={s.lastError}>
                    ⚠
                  </span>
                )}
              </>
            ),
          },
          {
            key: "autoPost",
            headerClassName: "whitespace-nowrap",
            header: t("table.autoPost"),
            cell: (s) => (s.autoPost ? t("yes") : t("no")),
          },
          {
            key: "status",
            headerClassName: "whitespace-nowrap",
            header: t("table.status"),
            cell: (s) => (
              <Badge variant={s.isActive ? "default" : "secondary"}>
                {s.isActive ? t("active") : t("paused")}
              </Badge>
            ),
          },
          {
            key: "actions",
            headerClassName: "whitespace-nowrap",
            header: "",
            cell: (s) => (
              <div className="flex justify-end gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => act(s.id, "POST")}
                >
                  {t("runNow")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => act(s.id, "PATCH", { isActive: !s.isActive })}
                >
                  {s.isActive ? t("pause") : t("resume")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => act(s.id, "DELETE")}
                >
                  {t("delete")}
                </Button>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

const policyEntity = BILLING_ENTITIES.find(
  (entity) => entity.key === "dunning-policies",
)!;

function DunningPanel() {
  const { money } = useMoney();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = useAppAction();
  const t = useTranslations("ar.collections.dunning");
  const common = useTranslations("common");
  const errors = useTranslations("ar.collections.errors");
  const search = useSearchParams();
  const router = useRouter();
  const policyId = search?.get("policy");
  const load = useCallback(async () => {
    const result = await fetchAction<{ policies: Policy[] }>("/api/dunning");
    if (!result.ok) {
      setError(result.error.displayMessage(errors("couldNotLoad")));
      return;
    }
    setPolicies(result.data.policies);
    setLoaded(true);
    setError(null);
  }, [errors]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load, policyId]);
  const remove = async (id: string) => {
    setError(null);
    await action.execute(
      () => fetchAction(`/api/dunning/${id}`, { method: "DELETE" }),
      {
        fallbackMessage: errors("couldNotDelete"),
        onRefused: (refusal) =>
          setError(refusal.displayMessage(errors("couldNotDelete"))),
        onOk: () => {
          void load();
        },
      },
    );
  };
  const selected = policies.find((policy) => policy.id === policyId);
  // The native editor owns its dialog. It mounts only when the full policy
  // and its stages are available, without an intermediate loading dialog.
  const row = selected
    ? {
        ...selected,
        grace_period_days: selected.gracePeriodDays,
        min_balance: selected.minBalance,
        reply_to: (selected as Policy & { replyTo?: string | null }).replyTo,
        is_active: selected.isActive,
        retryOffsetsDays: selected.retryOffsetsDays ?? [],
        finalAction: selected.finalAction ?? 'none',
      }
    : null;
  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}{" "}
          <Button variant="outline" onClick={() => void load()}>
            {common("actions.retry")}
          </Button>
        </p>
      )}
      <PagedTable
        source="collections_policies"
        searchable
        rows={policies}
        rowKey={(p) => p.id}
        onRowClick={(p) =>
          router.push(
            `/collections?view=policies&policy=${encodeURIComponent(p.id)}`,
          )
        }
        empty={loaded ? t("noneYet") : common("feedback.loading")}
        columns={[
          {
            key: "name",
            header: t("policyNameLabel"),
            search: (p) => p.name,
            cell: (p) => <span className="font-medium">{p.name}</span>,
          },
          {
            key: "stages",
            header: t("reminderLadder"),
            cell: (p) => (
              <span>
                {t("policySummary", {
                  count: p.stages.length,
                  grace: p.gracePeriodDays,
                })}
              </span>
            ),
          },
          {
            key: "minBalance",
            header: t("minimumBalance"),
            cell: (p) => money(p.minBalance),
          },
          {
            key: "status",
            header: common("labels.status"),
            cell: (p) => (
              <Badge variant={p.isActive ? "default" : "secondary"}>
                {p.isActive ? t("activeBadge") : t("off")}
              </Badge>
            ),
          },
          {
            key: "actions",
            header: "",
            cell: (p) => (
              <Button
                size="sm"
                variant="ghost"
                disabled={action.busy}
                onClick={() => void remove(p.id)}
              >
                {t("delete")}
              </Button>
            ),
          },
        ]}
      />
      {loaded && policyId && (policyId === "new" || selected) && (
        <SetupDrawer
          key={policyId}
          entity={policyEntity}
          row={row}
          members={[]}
          refOptions={{}}
          closeHref="/collections?view=policies"
          fixedValues={
            selected?.updatedAt
              ? { expectedUpdatedAt: selected.updatedAt }
              : undefined
          }
          initialValues={
            policyId === "new"
              ? {
                  stages: [
                    {
                      sequence: 1,
                      name: "",
                      offsetDays: 7,
                      subjectTemplate: "",
                      bodyTemplate: "",
                      escalate: false,
                    },
                  ],
                }
              : undefined
          }
        />
      )}
      {loaded && policyId && policyId !== "new" && !selected && (
        <p role="alert" className="text-sm text-destructive">
          {common("feedback.loadFailed")}
        </p>
      )}
    </div>
  );
}
