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
  maxOccurrences: number | null;
  skippedRunOns: string[] | null;
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
  // Activation catch-up uses the same explicit choice as recurring
  // schedules: a past first bill date previews its periods with totals,
  // and creation carries the chosen mode instead of letting the scheduler
  // silently bulk-generate them.
  const [subPreview, setSubPreview] = useState<SubCatchUpPreview | null>(null);
  const [subCatchUpMode, setSubCatchUpMode] = useState<CatchUpChoice | null>(null);
  const [subSelectedPeriods, setSubSelectedPeriods] = useState<string[]>([]);
  const [subPicker, setSubPicker] = useState<{ id: string; preview: SubCatchUpPreview } | null>(null);

  const reportSubCatchUp = (data: unknown) => {
    const outcome = (data as { catchUp?: { results?: { status?: string }[]; stopped?: string; error?: string } } | null)?.catchUp;
    if (!outcome) return;
    if (outcome.stopped === "failed") {
      setError(outcome.error ?? tErrors("actionFailed"));
      return;
    }
    const counts = { posted: 0, draft: 0, skipped: 0 };
    for (const row of outcome.results ?? []) {
      if (row.status === "posted") counts.posted += 1;
      else if (row.status === "draft") counts.draft += 1;
      else if (row.status === "skipped") counts.skipped += 1;
    }
    // A non-caught-up stop (canceled, paused, suspended) still reports its
    // counts; the row's own status names where generation stopped.
    setMsg(
      t("catchUpDone", {
        posted: String(counts.posted),
        drafts: String(counts.draft),
        skipped: String(counts.skipped),
      }),
    );
  };

  const resumeSubscriptionWithChoice = async (id: string) => {
    setError(null);
    const params = new URLSearchParams({ subscriptionId: id });
    const res = await fetch(`/api/subscriptions/preview?${params.toString()}`);
    if (!res.ok) {
      setError(tErrors("actionFailed"));
      return;
    }
    const previewed = (await res.json()) as SubCatchUpPreview;
    if (previewed.periods.length < 2) {
      await post({ action: "updateSubscription", id, status: "active" });
      return;
    }
    // A backlog resumes through the picker: the exact missed periods with
    // tick boxes, so some bill, some draft, all post, or all skip.
    setSubPicker({ id, preview: previewed });
  };

  const pickSubCatchUp = async (pick: CatchUpPick) => {
    if (!subPicker) return;
    const r = await post({
      action: "updateSubscription",
      id: subPicker.id,
      status: "active",
      catchUp:
        pick.mode === "selected"
          ? { mode: "selected", dates: pick.dates, post: pick.post }
          : { mode: pick.mode },
    });
    if (!r) return;
    setSubPicker(null);
    reportSubCatchUp(r);
  };
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
                          onClick={() => void resumeSubscriptionWithChoice(s.id)}
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
                disabled={
                  action.busy ||
                  !subForm.customerId ||
                  !subForm.planId ||
                  (subPreview !== null &&
                    subPreview.periods.length >= 2 &&
                    (subCatchUpMode === null ||
                      ((subCatchUpMode === "selected_post" ||
                        subCatchUpMode === "selected_drafts") &&
                        subSelectedPeriods.length === 0)))
                }
                onClick={async () => {
                  // A past first bill date means backlog: preview it first so
                  // the operator chooses with the periods and totals in front
                  // of them, instead of the scheduler silently bulk-billing it.
                  if (!subCatchUpMode && subForm.firstBillOn && subForm.planId) {
                    const params = new URLSearchParams({
                      planId: subForm.planId,
                      nextBillOn: subForm.firstBillOn,
                      quantity: subForm.quantity || "1",
                      ...(subForm.priceOverride
                        ? { priceOverride: subForm.priceOverride }
                        : {}),
                    });
                    const res = await fetch(
                      `/api/subscriptions/preview?${params.toString()}`,
                    );
                    if (res.ok) {
                      const previewed = (await res.json()) as SubCatchUpPreview;
                      if (previewed.periods.length >= 2) {
                        setSubPreview(previewed);
                        setSubSelectedPeriods(previewed.periods);
                        return;
                      }
                    }
                  }
                  const r = await post({
                    action: "addSubscription",
                    ...subForm,
                    priceOverride: subForm.priceOverride || null,
                    ...(subCatchUpMode
                      ? { catchUp: catchUpRequestBody(subCatchUpMode, subSelectedPeriods) }
                      : {}),
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
                  reportSubCatchUp(r);
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
                  setSubPreview(null);
                  setSubCatchUpMode(null);
                  setSubSelectedPeriods([]);
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
              {subPreview !== null && subPreview.periods.length >= 2 && (
                <InspectorPanel title={t("catchUpTitle")}>
                  <p className="text-sm text-muted-foreground">
                    {t("catchUpCreateMessage", {
                      count: String(subPreview.periods.length),
                      total: `${subPreview.estimatedTotal} ${subPreview.currency ?? ""}`.trim(),
                    })}
                  </p>
                  <p className="mb-2 text-sm text-muted-foreground">{t("catchUpSelectHint")}</p>
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-sm">
                    {subPreview.periods.map((date) => (
                      <li key={date}>
                        <label className="flex cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            checked={subSelectedPeriods.includes(date)}
                            onChange={() =>
                              setSubSelectedPeriods((prev) =>
                                prev.includes(date)
                                  ? prev.filter((d) => d !== date)
                                  : [...prev, date],
                              )
                            }
                            className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                          />
                          <span className="tabular-nums">{date}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <Field label={t("catchUpLabel")}>
                    <Select
                      value={subCatchUpMode ?? ""}
                      onChange={(e) =>
                        setSubCatchUpMode(e.target.value as CatchUpChoice)
                      }
                    >
                      <option value="">{t("catchUpChoose")}</option>
                      <option value="post_all">{t("catchUpPostAll")}</option>
                      <option value="drafts">{t("catchUpDrafts")}</option>
                      <option value="skip">{t("catchUpSkip")}</option>
                      <option value="selected_post">{t("catchUpSelectedPost")}</option>
                      <option value="selected_drafts">{t("catchUpSelectedDrafts")}</option>
                    </Select>
                  </Field>
                </InspectorPanel>
              )}
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
      <CatchUpPickerDialog
        open={subPicker !== null}
        title={t("catchUpTitle")}
        message={
          subPicker
            ? t("catchUpResumeMessage", {
                count: String(subPicker.preview.periods.length),
                total: `${subPicker.preview.estimatedTotal} ${subPicker.preview.currency ?? ""}`.trim(),
              })
            : ""
        }
        selectHint={t("catchUpSelectHint")}
        dates={subPicker?.preview.periods ?? []}
        postSelectedLabel={t("catchUpSelectedPost")}
        draftSelectedLabel={t("catchUpSelectedDrafts")}
        postAllLabel={t("catchUpPostAll")}
        draftsLabel={t("catchUpDrafts")}
        skipLabel={t("catchUpSkip")}
        cancelLabel={tc("confirm.cancel")}
        busy={action.busy}
        onPick={(pick) => void pickSubCatchUp(pick)}
        onClose={() => setSubPicker(null)}
      />
    </div>
  );
}

type CatchUpPreview = {
  occurrences: string[];
  truncated: boolean;
  templateTotal: string;
  currency: string;
  estimatedTotal: string;
  sample: { occurrenceOn: string; description: string | null; memo: string | null } | null;
  maxOccurrences: number | null;
  skippedRunOns: string[];
};

type SubCatchUpPreview = {
  periods: string[];
  truncated: boolean;
  perPeriodAmount: string;
  currency: string | null;
  estimatedTotal: string;
};

type CatchUpChoice = "post_all" | "drafts" | "skip" | "selected_post" | "selected_drafts";

type CatchUpPick =
  | { mode: "post_all" | "drafts" | "skip" }
  | { mode: "selected"; post: boolean; dates: string[] };

/** Map a dialog choice to the catch-up request body the API routes accept. */
function catchUpRequestBody(choice: CatchUpChoice, selectedDates: string[]): unknown {
  if (choice === "selected_post") return { mode: "selected", dates: selectedDates, post: true };
  if (choice === "selected_drafts") return { mode: "selected", dates: selectedDates, post: false };
  return { mode: choice };
}

/**
 * The resume catch-up picker: the exact missed periods with tick boxes, so
 * the operator bills all of them, drafts them, skips them, or ticks a
 * subset to generate. Shared by recurring schedules and subscriptions —
 * both catch-up runs take the same choice shape.
 */
function CatchUpPickerDialog({
  open,
  title,
  message,
  selectHint,
  dates,
  postSelectedLabel,
  draftSelectedLabel,
  postAllLabel,
  draftsLabel,
  skipLabel,
  cancelLabel,
  busy,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  selectHint: string;
  dates: string[];
  postSelectedLabel: string;
  draftSelectedLabel: string;
  postAllLabel: string;
  draftsLabel: string;
  skipLabel: string;
  cancelLabel: string;
  busy: boolean;
  onPick: (pick: CatchUpPick) => void;
  onClose: () => void;
}) {
  // Every period starts ticked: the usual resume bills all of them, and
  // unticking the out-of-season ones is the shortcut to a partial run.
  // Reset while rendering when a new backlog opens (same committed value,
  // no extra render).
  const datesKey = dates.join(",");
  const [checked, setChecked] = useState<string[]>(dates);
  const [seenKey, setSeenKey] = useState(datesKey);
  if (seenKey !== datesKey) {
    setSeenKey(datesKey);
    setChecked(dates);
  }
  const toggle = (date: string) =>
    setChecked((prev) => (prev.includes(date) ? prev.filter((d) => d !== date) : [...prev, date]));
  return (
    <Drawer open={open} onClose={onClose} title={title} size="lg">
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">{message}</p>
        <div>
          <p className="mb-2 text-sm text-muted-foreground">{selectHint}</p>
          <ul className="max-h-56 space-y-1 overflow-y-auto text-sm">
            {dates.map((date) => (
              <li key={date}>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checked.includes(date)}
                    onChange={() => toggle(date)}
                    className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  />
                  <span className="tabular-nums">{date}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <Button disabled={busy || checked.length === 0} onClick={() => onPick({ mode: "selected", post: true, dates: checked })}>
            {postSelectedLabel}
          </Button>
          <Button disabled={busy || checked.length === 0} variant="outline" onClick={() => onPick({ mode: "selected", post: false, dates: checked })}>
            {draftSelectedLabel}
          </Button>
          <Button disabled={busy} variant="outline" onClick={() => onPick({ mode: "post_all" })}>
            {postAllLabel}
          </Button>
          <Button disabled={busy} variant="outline" onClick={() => onPick({ mode: "drafts" })}>
            {draftsLabel}
          </Button>
          <Button disabled={busy} variant="outline" onClick={() => onPick({ mode: "skip" })}>
            {skipLabel}
          </Button>
          <Button disabled={busy} variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </Drawer>
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
  const blankForm = {
    templateDocumentNumber: "",
    cadence: "monthly",
    cron: "",
    nextRunOn: "",
    endsOn: "",
    maxOccurrences: "",
    skippedRunOns: [] as string[],
    autoPost: false,
  };
  const [form, setForm] = useState(blankForm);
  const [error, setError] = useState<string | null>(null);
  // Editing reuses the create drawer prefilled from the row; the catch-up
  // preview below belongs to creates, where a past first run means backlog.
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [preview, setPreview] = useState<CatchUpPreview | null>(null);
  const [catchUpMode, setCatchUpMode] = useState<CatchUpChoice | null>(null);
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [skipDateInput, setSkipDateInput] = useState("");
  const [schedPicker, setSchedPicker] = useState<{ id: string; preview: CatchUpPreview } | null>(null);
  const [tokenSample, setTokenSample] = useState<CatchUpPreview["sample"]>(null);
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

  // Live token sample for the edit drawer: the next run's resolved text for
  // the opened schedule. Guarded so a slow response cannot paint another
  // schedule's sample.
  const editingScheduleId = editingSchedule?.id ?? null;
  useEffect(() => {
    if (!editingScheduleId) return;
    let live = true;
    void fetch(
      `/api/recurring/preview?${new URLSearchParams({ scheduleId: editingScheduleId }).toString()}`,
    )
      .then(async (res) => {
        if (!live || !res.ok) return;
        const previewed = (await res.json()) as CatchUpPreview;
        if (live) setTokenSample(previewed.sample);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [editingScheduleId]);

  const closeDrawer = () => {
    setEditingSchedule(null);
    setPreview(null);
    setCatchUpMode(null);
    setSelectedDates([]);
    setSkipDateInput("");
    setTokenSample(null);
    onClose();
  };

  const create = async () => {
    setError(null);
    // A past first run means backlog: preview it first so the operator
    // chooses post-all/drafts/skip with the list and totals in front of
    // them, instead of the scheduler silently bulk-posting it.
    if (!editingSchedule && !catchUpMode && form.nextRunOn) {
      const previewed = await action.execute(
        async () => {
          const params = new URLSearchParams({
            templateDocumentNumber: form.templateDocumentNumber,
            cadence: form.cadence,
            ...(form.cadence === "custom_cron" ? { cron: form.cron } : {}),
            nextRunOn: form.nextRunOn,
            ...(form.endsOn ? { endsOn: form.endsOn } : {}),
            ...(form.maxOccurrences.trim() ? { maxOccurrences: form.maxOccurrences.trim() } : {}),
          });
          for (const skipped of form.skippedRunOns) params.append("skippedRunOn", skipped);
          const res = await fetch(`/api/recurring/preview?${params.toString()}`);
          if (!res.ok) return { ok: false as const, error: new ActionError({ kind: "unexpected" }) };
          const data = (await res.json()) as CatchUpPreview;
          return { ok: true as const, data };
        },
        {
          fallbackMessage: tErrors("couldNotCreate"),
          onRefused: (refusal) =>
            setError(refusal.displayMessage(tErrors("couldNotCreate"))),
        },
      );
      if (!previewed) return;
      setTokenSample(previewed.sample);
      if (previewed.occurrences.length >= 2) {
        setPreview(previewed);
        setSelectedDates(previewed.occurrences);
        return;
      }
    }
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
            endsOn: form.endsOn || null,
            maxOccurrences: form.maxOccurrences.trim() ? Number(form.maxOccurrences.trim()) : null,
            skippedRunOns: form.skippedRunOns,
            autoPost: form.autoPost,
            ...(catchUpMode ? { catchUp: catchUpRequestBody(catchUpMode, selectedDates) } : {}),
          }),
        }),
      {
        fallbackMessage: tErrors("couldNotCreate"),
        onRefused: (refusal) => {
          // A backlog that landed between preview and create still refuses:
          // reload the preview so the choice surfaces instead of failing.
          if (refusal.code === "catch_up_choice_required") {
            void refreshPreview();
            return;
          }
          setError(refusal.displayMessage(tErrors("couldNotCreate")));
        },
        onOk: (data) => {
          reportCatchUp(data);
          closeDrawer();
          setForm(blankForm);
          void load();
        },
      },
    );
  };

  const refreshPreview = async () => {
    if (!form.templateDocumentNumber || !form.nextRunOn) return;
    const params = new URLSearchParams({
      templateDocumentNumber: form.templateDocumentNumber,
      cadence: form.cadence,
      ...(form.cadence === "custom_cron" ? { cron: form.cron } : {}),
      nextRunOn: form.nextRunOn,
      ...(form.endsOn ? { endsOn: form.endsOn } : {}),
      ...(form.maxOccurrences.trim() ? { maxOccurrences: form.maxOccurrences.trim() } : {}),
    });
    for (const skipped of form.skippedRunOns) params.append("skippedRunOn", skipped);
    const res = await fetch(`/api/recurring/preview?${params.toString()}`);
    if (!res.ok) return;
    const previewed = (await res.json()) as CatchUpPreview;
    setPreview(previewed);
    setSelectedDates(previewed.occurrences);
    setTokenSample(previewed.sample);
  };

  const saveEdit = async () => {
    if (!editingSchedule) return;
    setError(null);
    await action.execute(
      () =>
        fetchAction(`/api/recurring/${editingSchedule.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            nextRunOn: form.nextRunOn || undefined,
            endsOn: form.endsOn || null,
            maxOccurrences: form.maxOccurrences.trim() ? Number(form.maxOccurrences.trim()) : null,
            skippedRunOns: form.skippedRunOns,
            autoPost: form.autoPost,
          }),
        }),
      {
        fallbackMessage: tErrors("couldNotCreate"),
        onRefused: (refusal) =>
          setError(refusal.displayMessage(tErrors("couldNotCreate"))),
        onOk: () => {
          closeDrawer();
          setForm(blankForm);
          void load();
        },
      },
    );
  };

  const resumeWithChoice = async (id: string) => {
    setError(null);
    const params = new URLSearchParams({ scheduleId: id });
    const res = await fetch(`/api/recurring/preview?${params.toString()}`);
    if (!res.ok) {
      setError(tErrors("couldNotCreate"));
      return;
    }
    const previewed = (await res.json()) as CatchUpPreview;
    if (previewed.occurrences.length < 2) {
      await act(id, "PATCH", { isActive: true });
      return;
    }
    // A backlog resumes through the picker: the exact missed periods with
    // tick boxes, so some generate, some draft, all post, or all skip.
    setSchedPicker({ id, preview: previewed });
  };

  const pickSchedCatchUp = async (pick: CatchUpPick) => {
    if (!schedPicker) return;
    await action.execute(
      () =>
        fetchAction(`/api/recurring/${schedPicker.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            isActive: true,
            catchUp:
              pick.mode === "selected"
                ? { mode: "selected", dates: pick.dates, post: pick.post }
                : { mode: pick.mode },
          }),
        }),
      {
        fallbackMessage: tErrors("actionFailed"),
        onRefused: (refusal) =>
          setError(refusal.displayMessage(tErrors("actionFailed"))),
        onOk: (data) => {
          setSchedPicker(null);
          reportCatchUp(data);
          void load();
        },
      },
    );
  };

  const [notice, setNotice] = useState<string | null>(null);

  const reportCatchUp = (data: unknown) => {
    const outcome = (data as { catchUp?: { results?: { status?: string }[]; stopped?: string; error?: string } } | null)?.catchUp;
    if (!outcome) return;
    if (outcome.stopped === "failed") {
      setError(outcome.error ?? tErrors("actionFailed"));
      return;
    }
    const counts = { posted: 0, draft: 0, skipped: 0 };
    for (const row of outcome.results ?? []) {
      if (row.status === "posted") counts.posted += 1;
      else if (row.status === "draft") counts.draft += 1;
      else if (row.status === "skipped") counts.skipped += 1;
    }
    setError(null);
    // The stop names itself: an ended schedule, a limited one, or a plain
    // catch-up — the counts ride along either way.
    const doneKey =
      outcome.stopped === "reached_end"
        ? "catchUpEnded"
        : outcome.stopped === "reached_limit"
          ? "catchUpLimited"
          : "catchUpDone";
    setNotice(
      t(doneKey, {
        posted: String(counts.posted),
        drafts: String(counts.draft),
        skipped: String(counts.skipped),
      }),
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
        open={creating || editingSchedule !== null}
        onClose={closeDrawer}
        title={editingSchedule ? t("editSchedule") : t("newSchedule")}
        size="xl"
        headerActions={
          <Button
            onClick={editingSchedule ? saveEdit : create}
            disabled={
              busy ||
              (!editingSchedule && !form.templateDocumentNumber) ||
              (preview !== null &&
                preview.occurrences.length >= 2 &&
                (catchUpMode === null ||
                  ((catchUpMode === "selected_post" ||
                    catchUpMode === "selected_drafts") &&
                    selectedDates.length === 0)))
            }
          >
            {editingSchedule ? common("actions.save") : t("createSchedule")}
          </Button>
        }
      >
        {error && (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="space-y-5">
          {!editingSchedule && (
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
          )}
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
              <Field label={t("endsOnLabel")}>
                <Input
                  type="date"
                  value={form.endsOn}
                  onChange={(e) =>
                    setForm({ ...form, endsOn: e.target.value })
                  }
                />
              </Field>
              <Field label={t("maxOccurrencesLabel")}>
                <Input
                  inputMode="numeric"
                  min={1}
                  placeholder={t("maxOccurrencesPlaceholder")}
                  value={form.maxOccurrences}
                  onChange={(e) =>
                    setForm({ ...form, maxOccurrences: e.target.value.replace(/[^0-9]/g, "") })
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
          <InspectorPanel title={t("skippedDatesTitle")}>
            <p className="text-sm text-muted-foreground">{t("skippedDatesHint")}</p>
            <div className="flex items-end gap-2">
              <Field label={t("skippedDatesLabel")}>
                <Input
                  type="date"
                  value={skipDateInput}
                  onChange={(e) => setSkipDateInput(e.target.value)}
                />
              </Field>
              <Button
                variant="outline"
                disabled={!skipDateInput || form.skippedRunOns.includes(skipDateInput)}
                onClick={() => {
                  setForm({ ...form, skippedRunOns: [...form.skippedRunOns, skipDateInput].sort() });
                  setSkipDateInput("");
                }}
              >
                {common("actions.add")}
              </Button>
            </div>
            {form.skippedRunOns.length > 0 && (
              <ul className="max-h-40 space-y-1 overflow-y-auto text-sm">
                {form.skippedRunOns.map((date) => (
                  <li key={date} className="flex items-center justify-between gap-2">
                    <span className="tabular-nums">{date}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setForm({ ...form, skippedRunOns: form.skippedRunOns.filter((d) => d !== date) })
                      }
                    >
                      {common("actions.remove")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </InspectorPanel>
          <InspectorPanel title={t("tokensTitle")}>
            <p className="whitespace-pre-line text-sm text-muted-foreground">
              {t("tokensHelp")}
            </p>
            {tokenSample?.description ? (
              <p className="text-sm">
                {t("tokensPreview")}:{" "}
                <span className="font-medium">{tokenSample.description}</span>
              </p>
            ) : null}
          </InspectorPanel>
          {preview !== null && preview.occurrences.length >= 2 && (
            <InspectorPanel title={t("catchUpTitle")}>
              <p className="text-sm text-muted-foreground">
                {t("catchUpCreateMessage", {
                  count: String(preview.occurrences.length),
                  total: `${preview.estimatedTotal} ${preview.currency}`,
                })}
              </p>
              <p className="mb-2 text-sm text-muted-foreground">{t("catchUpSelectHint")}</p>
              <ul className="max-h-40 space-y-1 overflow-y-auto text-sm">
                {preview.occurrences.map((date) => (
                  <li key={date}>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedDates.includes(date)}
                        onChange={() =>
                          setSelectedDates((prev) =>
                            prev.includes(date)
                              ? prev.filter((d) => d !== date)
                              : [...prev, date],
                          )
                        }
                        className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                      />
                      <span className="tabular-nums">{date}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <Field label={t("catchUpLabel")}>
                <Select
                  value={catchUpMode ?? ""}
                  onChange={(e) =>
                    setCatchUpMode(e.target.value as CatchUpChoice)
                  }
                >
                  <option value="">{t("catchUpChoose")}</option>
                  <option value="post_all">{t("catchUpPostAll")}</option>
                  <option value="drafts">{t("catchUpDrafts")}</option>
                  <option value="skip">{t("catchUpSkip")}</option>
                  <option value="selected_post">{t("catchUpSelectedPost")}</option>
                  <option value="selected_drafts">{t("catchUpSelectedDrafts")}</option>
                </Select>
              </Field>
            </InspectorPanel>
          )}
        </div>
      </Drawer>
      {notice && <p className="text-sm text-teal-700 dark:text-teal-300">{notice}</p>}

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
                  onClick={() => {
                    setForm({
                      templateDocumentNumber: s.templateNumber,
                      cadence: s.cadence,
                      cron: s.cron ?? "",
                      nextRunOn: s.nextRunOn,
                      endsOn: s.endsOn ?? "",
                      maxOccurrences: s.maxOccurrences == null ? "" : String(s.maxOccurrences),
                      skippedRunOns: [...(s.skippedRunOns ?? [])].sort(),
                      autoPost: s.autoPost,
                    });
                    setPreview(null);
                    setCatchUpMode(null);
                    setSelectedDates([]);
                    setSkipDateInput("");
                    setTokenSample(null);
                    setEditingSchedule(s);
                  }}
                >
                  {t("editSchedule")}
                </Button>
                {s.isActive ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => act(s.id, "PATCH", { isActive: false })}
                  >
                    {t("pause")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void resumeWithChoice(s.id)}
                  >
                    {t("resume")}
                  </Button>
                )}
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
      <CatchUpPickerDialog
        open={schedPicker !== null}
        title={t("catchUpTitle")}
        message={
          schedPicker
            ? t("catchUpResumeMessage", {
                count: String(schedPicker.preview.occurrences.length),
                total: `${schedPicker.preview.estimatedTotal} ${schedPicker.preview.currency}`,
              })
            : ""
        }
        selectHint={t("catchUpSelectHint")}
        dates={schedPicker?.preview.occurrences ?? []}
        postSelectedLabel={t("catchUpSelectedPost")}
        draftSelectedLabel={t("catchUpSelectedDrafts")}
        postAllLabel={t("catchUpPostAll")}
        draftsLabel={t("catchUpDrafts")}
        skipLabel={t("catchUpSkip")}
        cancelLabel={common("actions.cancel")}
        busy={busy}
        onPick={(pick) => void pickSchedCatchUp(pick)}
        onClose={() => setSchedPicker(null)}
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
