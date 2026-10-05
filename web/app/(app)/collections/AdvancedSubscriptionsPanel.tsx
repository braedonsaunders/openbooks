"use client";

import { PagedTable } from "@/components/paged-table";
import { readApiErrorMessage } from "@/lib/api-error";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  Drawer,
  Input,
  Select,
  Skeleton,
} from "@openbooks/ui";
import { InspectorPanel } from "@/components/builder/builder-kit";
import { Trash2, Plus } from "lucide-react";
import { Field } from "@/components/field";
import {
  PlanVersionEntitlementsDrawer,
  SubscriptionEntitlementsDrawer,
} from "./EntitlementDrawers";
import { useBusinessToday } from "@/components/business-date-provider";
import { useMoney } from "@/components/money-provider";
import { fetchAction } from "@braedonsaunders/appkit-errors";
import { useAppAction } from "../../../lib/use-app-action";

type BasePlan = {
  id: string;
  name: string;
  interval: string;
  intervalCount: number;
  isActive: boolean;
};
type BaseSubscription = {
  id: string;
  customerName: string | null;
  planId: string;
  planName: string;
  status: string;
};
type Component = {
  componentKey: string;
  name: string;
  quantity: string;
  unitPrice: string;
  isOptional?: boolean;
  effectiveTo?: string | null;
};
type Version = {
  id: string;
  planId: string;
  versionNumber: number;
  status: string;
  effectiveFrom: string;
  name: string;
  interval: string;
  intervalCount: number;
  billingTiming: string;
  components: Component[];
};
type Lifecycle = {
  subscriptionId: string;
  planVersionId: string;
  contractRevision: number;
  termStartsOn: string;
  termEndsOn: string | null;
  trialEndsOn: string | null;
  billingTiming: string;
  renewalPolicy: string;
  renewalTermMonths: number | null;
  components: Component[];
};
type Amendment = {
  id: string;
  subscriptionId: string;
  amendmentNumber: number;
  amendmentType: string;
  effectiveOn: string;
  status: string;
  reason: string | null;
};

const blankComponent = (name: string): Component => ({
  componentKey: "base",
  name,
  quantity: "1",
  unitPrice: "0",
});

export function AdvancedSubscriptionsPanel({
  view = "versions",
  creating = false,
  onClose = () => {},
}: {
  view?: "versions" | "contracts" | "amendments";
  creating?: boolean;
  onClose?: () => void;
}) {
  const t = useTranslations("ar.collections.subscriptions.advanced");
  const et = useTranslations("ar.collections.subscriptions.advanced.entitlements");
  const forms = useTranslations("ar.collections.forms");
  const newAction = useTranslations("ar.collections.actions");
  const common = useTranslations("common");
  const { money } = useMoney();
  const today = useBusinessToday();
  const [plans, setPlans] = useState<BasePlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<BaseSubscription[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [lifecycles, setLifecycles] = useState<Lifecycle[]>([]);
  const [amendments, setAmendments] = useState<Amendment[]>([]);
  const [entVersion, setEntVersion] = useState<{ id: string; name: string } | null>(null);
  const [entSub, setEntSub] = useState<{ id: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const tErrors = useTranslations("ar.collections.errors");
  const action = useAppAction();
  const busy = action.busy;
  const [loading, setLoading] = useState(true);
  const [versionForm, setVersionForm] = useState({
    planId: "",
    effectiveFrom: today,
    billingTiming: "advance",
    changeSummary: "",
    components: [blankComponent(t("baseSubscription"))],
  });
  const [lifecycleForm, setLifecycleForm] = useState({
    subscriptionId: "",
    planVersionId: "",
    termStartsOn: today,
    termEndsOn: "",
    trialEndsOn: "",
    renewalPolicy: "auto",
    renewalTermMonths: "12",
  });
  const [amendForm, setAmendForm] = useState({
    subscriptionId: "",
    type: "add_component",
    effectiveOn: today,
    componentKey: "",
    name: "",
    quantity: "1",
    unitPrice: "0",
    termEndsOn: "",
    billingTiming: "advance",
    renewalTermMonths: "12",
    anchorSubscriptionId: "",
    reason: "",
  });

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body. Memoized on the
  // catalog text so the mount effect below stays single-shot per locale.
  const load = useCallback(() => {
    return Promise.all([
      fetch("/api/subscriptions"),
      fetch("/api/subscriptions/advanced"),
    ])
      .then(async ([baseResponse, advancedResponse]) => {
        if (!baseResponse.ok)
          throw new Error(
            await readApiErrorMessage(baseResponse, t("loadFailed")),
          );
        if (!advancedResponse.ok)
          throw new Error(
            await readApiErrorMessage(advancedResponse, t("loadFailed")),
          );
        setError(null);
        return Promise.all([baseResponse.json(), advancedResponse.json()]).then(
          ([base, advanced]) => {
            setPlans(base.plans ?? []);
            setSubscriptions(base.subscriptions ?? []);
            setVersions(advanced.versions ?? []);
            setLifecycles(advanced.lifecycles ?? []);
            setAmendments(advanced.amendments ?? []);
          },
        );
      })
      .catch((loadError: unknown) => {
        setError(
          loadError instanceof Error
            ? loadError.message
            : t("loadFailedFallback"),
        );
      })
      .finally(() => {
        setLoading(false);
      });
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  const post = async (payload: Record<string, unknown>) => {
    setError(null);
    setMessage(null);
    let body: Record<string, unknown> | null = null;
    const ok = await action.execute(
      async () => {
        const result = await fetchAction<Record<string, unknown>>(
          "/api/subscriptions/advanced",
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

  const lifecycleIds = useMemo(
    () => new Set(lifecycles.map((row) => row.subscriptionId)),
    [lifecycles],
  );
  const selectedSubscription = subscriptions.find(
    (row) => row.id === lifecycleForm.subscriptionId,
  );
  const eligibleVersions = versions.filter(
    (row) =>
      row.status === "published" &&
      (!selectedSubscription || row.planId === selectedSubscription.planId),
  );
  const amendmentSubscription = subscriptions.find(
    (row) => row.id === amendForm.subscriptionId,
  );

  /** Stored timing/renewal enums render through the catalog; unknown values stay raw. */
  const timingLabel = (value: string) =>
    value === "advance"
      ? t("timingAdvance")
      : value === "arrears"
        ? t("timingArrears")
        : value;
  const renewalLabel = (value: string) =>
    value === "auto"
      ? t("renewalAuto")
      : value === "manual"
        ? t("renewalManual")
        : value === "none"
          ? t("renewalNone")
          : value;
  const changeTypeLabel = (value: string) => {
    const key = `changeType_${value}`;
    return t.has(key) ? t(key) : value.replaceAll("_", " ");
  };

  if (loading)
    return (
      <Card className="space-y-3 p-4" aria-label={t("loading")}>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );

  return (
    <div className="space-y-6">
      {error && !creating && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}{" "}
            <Button variant="outline" onClick={() => void load()}>
              {common("actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert variant="success">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      {view === "versions" && (
        <div className="space-y-4">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{t("catalogTitle")}</h3>
              <p className="text-xs text-muted-foreground">
                {t("catalogDescription")}
              </p>
            </div>
            <Badge variant="secondary">
              {t("publishedCount", {
                count: versions.filter((v) => v.status === "published").length,
              })}
            </Badge>
          </div>

          <PagedTable
            source="collections_versions"
            searchable
            rows={versions}
            rowKey={(version) => version.id}
            empty={t("noVersions")}
            columns={[
              {
                key: "name",
                header: <>{t("colVersion")}</>,
                cell: (version) => (
                  <>
                    <span className="font-medium">{version.name}</span>{" "}
                    <Badge
                      variant={
                        version.status === "published" ? "default" : "secondary"
                      }
                    >
                      v{version.versionNumber} {version.status}
                    </Badge>
                  </>
                ),
                search: (version) => version.name ?? "",
              },
              {
                key: "effectiveFrom",
                header: <>{t("colEffective")}</>,
                cell: (version) => <>{version.effectiveFrom}</>,
              },
              {
                key: "billingTiming",
                header: <>{t("colTiming")}</>,
                cell: (version) => <>{timingLabel(version.billingTiming)}</>,
              },
              {
                key: "components",
                header: <>{t("colComponents")}</>,
                cell: (version) => (
                  <>{version.components.map((c) => c.name).join(", ")}</>
                ),
              },
              {
                key: "actions",
                header: <></>,
                cell: (version) => (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        setEntVersion({ id: version.id, name: version.name })
                      }
                    >
                      {et("versionTitle")}
                    </Button>
                    {version.status === "draft" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={async () => {
                          if (
                            await post({
                              action: "publishVersion",
                              versionId: version.id,
                            })
                          )
                            setMessage(
                              t("publishedMessage", {
                                name: version.name,
                                version: version.versionNumber,
                              }),
                            );
                        }}
                      >
                        {t("publish")}
                      </Button>
                    )}
                  </>
                ),
              },
            ]}
          />
          <Drawer
            open={creating}
            onClose={onClose}
            title={newAction("versions")}
            size="xl"
            headerActions={
              <Button
                disabled={
                  busy ||
                  !versionForm.planId ||
                  versionForm.components.some((c) => !c.componentKey || !c.name)
                }
                onClick={async () => {
                  const result = await post({
                    action: "createVersion",
                    ...versionForm,
                  });
                  if (result) {
                    onClose();
                    setMessage(t("draftCreated"));
                    setVersionForm({
                      planId: "",
                      effectiveFrom: today,
                      billingTiming: "advance",
                      changeSummary: "",
                      components: [blankComponent(t("baseSubscription"))],
                    });
                  }
                }}
              >
                {t("createDraft")}
              </Button>
            }
          >
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-5">
              <InspectorPanel title={forms("versionDetails")}>
                <Field label={t("basePlan")} required>
                  <Select
                    searchable
                    value={versionForm.planId}
                    onChange={(e) =>
                      setVersionForm({ ...versionForm, planId: e.target.value })
                    }
                  >
                    <option value="">{t("choosePlan")}</option>
                    {plans
                      .filter((p) => p.isActive)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label={t("effectiveFrom")} required>
                    <Input
                      type="date"
                      value={versionForm.effectiveFrom}
                      onChange={(e) =>
                        setVersionForm({
                          ...versionForm,
                          effectiveFrom: e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field label={t("invoiceTiming")}>
                    <Select
                      value={versionForm.billingTiming}
                      onChange={(e) =>
                        setVersionForm({
                          ...versionForm,
                          billingTiming: e.target.value,
                        })
                      }
                    >
                      <option value="advance">{t("advance")}</option>
                      <option value="arrears">{t("arrears")}</option>
                    </Select>
                  </Field>
                </div>
                <Field label={t("changeSummary")}>
                  <Input
                    value={versionForm.changeSummary}
                    onChange={(e) =>
                      setVersionForm({
                        ...versionForm,
                        changeSummary: e.target.value,
                      })
                    }
                    placeholder={t("initialCatalog")}
                  />
                </Field>
              </InspectorPanel>
              {versionForm.components.map((component, index) => (
                <InspectorPanel
                  key={index}
                  title={component.name || t("fallbackComponent")}
                  eyebrow={forms("componentNumber", { number: index + 1 })}
                  actions={
                    versionForm.components.length > 1 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("removeComponent", {
                          name: component.name || t("fallbackComponent"),
                        })}
                        onClick={() =>
                          setVersionForm({
                            ...versionForm,
                            components: versionForm.components.filter(
                              (_, i) => i !== index,
                            ),
                          })
                        }
                      >
                        <Trash2 size={16} />
                      </Button>
                    ) : undefined
                  }
                >
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field label={t("componentName")} required>
                      <Input
                        value={component.name}
                        onChange={(e) =>
                          setVersionForm({
                            ...versionForm,
                            components: versionForm.components.map((c, i) =>
                              i === index ? { ...c, name: e.target.value } : c,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Field label={t("componentKey")} required>
                      <Input
                        value={component.componentKey}
                        onChange={(e) =>
                          setVersionForm({
                            ...versionForm,
                            components: versionForm.components.map((c, i) =>
                              i === index
                                ? { ...c, componentKey: e.target.value }
                                : c,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Field label={t("quantity")} required>
                      <Input
                        inputMode="decimal"
                        value={component.quantity}
                        onChange={(e) =>
                          setVersionForm({
                            ...versionForm,
                            components: versionForm.components.map((c, i) =>
                              i === index
                                ? { ...c, quantity: e.target.value }
                                : c,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Field label={t("unitPrice")} required>
                      <Input
                        inputMode="decimal"
                        value={component.unitPrice}
                        onChange={(e) =>
                          setVersionForm({
                            ...versionForm,
                            components: versionForm.components.map((c, i) =>
                              i === index
                                ? { ...c, unitPrice: e.target.value }
                                : c,
                            ),
                          })
                        }
                      />
                    </Field>
                  </div>
                </InspectorPanel>
              ))}
              <Button
                variant="outline"
                onClick={() =>
                  setVersionForm({
                    ...versionForm,
                    components: [
                      ...versionForm.components,
                      {
                        ...blankComponent(t("baseSubscription")),
                        componentKey: `addon-${versionForm.components.length}`,
                        name: t("addonName"),
                      },
                    ],
                  })
                }
              >
                <Plus size={16} />
                {t("addComponent")}
              </Button>
            </div>
          </Drawer>
        </div>
      )}

      {view === "contracts" && (
        <div className="space-y-4">
          <PagedTable
            source="collections_contracts"
            searchable
            rows={lifecycles}
            rowKey={(l) => l.subscriptionId}
            empty={common("labels.none")}
            columns={[
              {
                key: "customer",
                header: t("customerFallback"),
                search: (l) =>
                  subscriptions.find((s) => s.id === l.subscriptionId)
                    ?.customerName ?? "",
                cell: (l) =>
                  subscriptions.find((s) => s.id === l.subscriptionId)
                    ?.customerName ?? t("customerFallback"),
              },
              {
                key: "plan",
                header: t("basePlan"),
                cell: (l) =>
                  subscriptions.find((s) => s.id === l.subscriptionId)
                    ?.planName ?? t("subscriptionFallback"),
              },
              {
                key: "revision",
                header: common("labels.reference"),
                cell: (l) => t("revision", { rev: l.contractRevision }),
              },
              {
                key: "term",
                header: t("termStarts"),
                cell: (l) =>
                  t("termLine", {
                    start: l.termStartsOn,
                    end: l.termEndsOn ?? t("openEnd"),
                  }),
              },
              {
                key: "timing",
                header: t("colTiming"),
                cell: (l) => timingLabel(l.billingTiming),
              },
              {
                key: "renewal",
                header: t("renewal"),
                cell: (l) => renewalLabel(l.renewalPolicy),
              },
              {
                key: "components",
                header: t("colComponents"),
                cell: (l) => (
                  <div className="space-y-1">
                    {l.components
                      .filter((c) => !c.effectiveTo)
                      .map((c) => (
                        <p key={c.componentKey}>
                          {c.name}: {c.quantity} × {money(c.unitPrice)}
                        </p>
                      ))}
                  </div>
                ),
              },
              {
                key: "entitlements",
                header: <></>,
                cell: (l) => (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      setEntSub({
                        id: l.subscriptionId,
                        label:
                          subscriptions.find((s) => s.id === l.subscriptionId)
                            ?.customerName ?? t("customerFallback"),
                      })
                    }
                  >
                    {et("subscriptionTitle")}
                  </Button>
                ),
              },
            ]}
          />
          <Drawer
            open={creating}
            onClose={onClose}
            title={newAction("contracts")}
            size="xl"
            headerActions={
              <Button
                disabled={
                  busy ||
                  !lifecycleForm.subscriptionId ||
                  !lifecycleForm.planVersionId
                }
                onClick={async () => {
                  if (
                    await post({
                      action: "activateLifecycle",
                      ...lifecycleForm,
                    })
                  ) {
                    onClose();
                    setMessage(t("lifecycleActivated"));
                    setLifecycleForm({
                      subscriptionId: "",
                      planVersionId: "",
                      termStartsOn: today,
                      termEndsOn: "",
                      trialEndsOn: "",
                      renewalPolicy: "auto",
                      renewalTermMonths: "12",
                    });
                  }
                }}
              >
                {t("activateLifecycle")}
              </Button>
            }
          >
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-5">
              <InspectorPanel title={forms("subscriptionDetails")}>
                <Field label={t("subscription")} required>
                  <Select
                    searchable
                    value={lifecycleForm.subscriptionId}
                    onChange={(e) =>
                      setLifecycleForm({
                        ...lifecycleForm,
                        subscriptionId: e.target.value,
                        planVersionId: "",
                      })
                    }
                  >
                    <option value="">{t("choose")}</option>
                    {subscriptions
                      .filter(
                        (s) =>
                          !lifecycleIds.has(s.id) && s.status !== "canceled",
                      )
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.customerName ?? t("customerFallback")} ·{" "}
                          {s.planName}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label={t("publishedVersion")} required>
                  <Select
                    searchable
                    value={lifecycleForm.planVersionId}
                    onChange={(e) =>
                      setLifecycleForm({
                        ...lifecycleForm,
                        planVersionId: e.target.value,
                      })
                    }
                  >
                    <option value="">{t("choose")}</option>
                    {eligibleVersions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} · v{v.versionNumber}
                      </option>
                    ))}
                  </Select>
                </Field>
              </InspectorPanel>
              <InspectorPanel title={forms("contractTerm")}>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label={t("termStarts")} required>
                    <Input
                      type="date"
                      value={lifecycleForm.termStartsOn}
                      onChange={(e) =>
                        setLifecycleForm({
                          ...lifecycleForm,
                          termStartsOn: e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field label={t("termEnds")}>
                    <Input
                      type="date"
                      value={lifecycleForm.termEndsOn}
                      onChange={(e) =>
                        setLifecycleForm({
                          ...lifecycleForm,
                          termEndsOn: e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field label={t("trialEnds")}>
                    <Input
                      type="date"
                      value={lifecycleForm.trialEndsOn}
                      onChange={(e) =>
                        setLifecycleForm({
                          ...lifecycleForm,
                          trialEndsOn: e.target.value,
                        })
                      }
                    />
                  </Field>
                </div>
              </InspectorPanel>
              <InspectorPanel title={forms("renewal")}>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label={t("renewal")}>
                    <Select
                      value={lifecycleForm.renewalPolicy}
                      onChange={(e) =>
                        setLifecycleForm({
                          ...lifecycleForm,
                          renewalPolicy: e.target.value,
                        })
                      }
                    >
                      <option value="auto">{t("renewAuto")}</option>
                      <option value="manual">{t("renewManual")}</option>
                      <option value="none">{t("renewNone")}</option>
                    </Select>
                  </Field>
                  <Field label={t("renewalTermMonths")}>
                    <Input
                      type="number"
                      min="1"
                      value={lifecycleForm.renewalTermMonths}
                      onChange={(e) =>
                        setLifecycleForm({
                          ...lifecycleForm,
                          renewalTermMonths: e.target.value,
                        })
                      }
                    />
                  </Field>
                </div>
              </InspectorPanel>
            </div>
          </Drawer>
        </div>
      )}

      {view === "amendments" && (
        <div className="space-y-4">
          <PagedTable
            source="collections_amendments"
            searchable
            rows={amendments}
            rowKey={(a) => a.id}
            empty={t("noAmendments")}
            columns={[
              {
                key: "amendmentNumber",
                header: <>{t("colNumber")}</>,
                cell: (a) => <>{a.amendmentNumber}</>,
              },
              {
                key: "subscriptionId",
                header: <>{t("colSubscription")}</>,
                cell: (a) => (
                  <>
                    {subscriptions.find((s) => s.id === a.subscriptionId)
                      ?.planName ?? t("subscriptionFallback")}
                  </>
                ),
              },
              {
                key: "amendmentType",
                header: <>{t("colChange")}</>,
                cell: (a) => <>{changeTypeLabel(a.amendmentType)}</>,
              },
              {
                key: "effectiveOn",
                header: <>{t("colEffective")}</>,
                cell: (a) => <>{a.effectiveOn}</>,
              },
              {
                key: "reason",
                header: <>{t("colReason")}</>,
                cell: (a) => <>{a.reason ?? "—"}</>,
                search: (a) => a.reason ?? "",
              },
            ]}
          />
          <Drawer
            open={creating}
            onClose={onClose}
            title={newAction("amendments")}
            size="xl"
            headerActions={
              <Button
                disabled={busy || !amendForm.subscriptionId}
                onClick={async () => {
                  const result = await post({
                    action: "amend",
                    ...amendForm,
                    idempotencyKey: crypto.randomUUID(),
                    renewalTermMonths: Number(
                      amendForm.renewalTermMonths || 12,
                    ),
                  });
                  if (result) {
                    onClose();
                    setMessage(t("amendmentApplied"));
                  }
                }}
              >
                {t("applyAmendment")}
              </Button>
            }
          >
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-5">
              <InspectorPanel title={forms("amendmentDetails")}>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label={t("subscription")}>
                    <Select
                      searchable
                      value={amendForm.subscriptionId}
                      onChange={(e) =>
                        setAmendForm({
                          ...amendForm,
                          subscriptionId: e.target.value,
                        })
                      }
                    >
                      <option value="">{t("choose")}</option>
                      {subscriptions
                        .filter((s) => lifecycleIds.has(s.id))
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.customerName ?? t("customerFallback")} ·{" "}
                            {s.planName}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <Field label={t("change")}>
                    <Select
                      value={amendForm.type}
                      onChange={(e) =>
                        setAmendForm({ ...amendForm, type: e.target.value })
                      }
                    >
                      <option value="add_component">{t("changeAdd")}</option>
                      <option value="change_component">
                        {t("changeChange")}
                      </option>
                      <option value="remove_component">
                        {t("changeRemove")}
                      </option>
                      <option value="change_term">{t("changeTerm")}</option>
                      <option value="change_timing">{t("changeTiming")}</option>
                      <option value="renew">{t("changeRenew")}</option>
                      <option value="coterm">{t("changeCoterm")}</option>
                    </Select>
                  </Field>
                  <Field label={t("effectiveOn")}>
                    <Input
                      type="date"
                      value={amendForm.effectiveOn}
                      onChange={(e) =>
                        setAmendForm({
                          ...amendForm,
                          effectiveOn: e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field label={t("reason")}>
                    <Input
                      value={amendForm.reason}
                      onChange={(e) =>
                        setAmendForm({ ...amendForm, reason: e.target.value })
                      }
                    />
                  </Field>
                </div>
              </InspectorPanel>
              <InspectorPanel title={changeTypeLabel(amendForm.type)}>
                <div className="grid gap-5 sm:grid-cols-2">
                  {" "}
                  {[
                    "add_component",
                    "change_component",
                    "remove_component",
                  ].includes(amendForm.type) && (
                    <>
                      <Field label={t("componentKey")}>
                        <Input
                          value={amendForm.componentKey}
                          onChange={(e) =>
                            setAmendForm({
                              ...amendForm,
                              componentKey: e.target.value,
                            })
                          }
                        />
                      </Field>
                      {amendForm.type !== "remove_component" && (
                        <>
                          <Field label={t("name")}>
                            <Input
                              value={amendForm.name}
                              onChange={(e) =>
                                setAmendForm({
                                  ...amendForm,
                                  name: e.target.value,
                                })
                              }
                            />
                          </Field>
                          <Field label={t("quantity")}>
                            <Input
                              inputMode="decimal"
                              value={amendForm.quantity}
                              onChange={(e) =>
                                setAmendForm({
                                  ...amendForm,
                                  quantity: e.target.value,
                                })
                              }
                            />
                          </Field>
                          <Field label={t("unitPrice")}>
                            <Input
                              inputMode="decimal"
                              value={amendForm.unitPrice}
                              onChange={(e) =>
                                setAmendForm({
                                  ...amendForm,
                                  unitPrice: e.target.value,
                                })
                              }
                            />
                          </Field>
                        </>
                      )}
                    </>
                  )}
                  {amendForm.type === "change_term" && (
                    <Field label={t("newTermEnd")}>
                      <Input
                        type="date"
                        value={amendForm.termEndsOn}
                        onChange={(e) =>
                          setAmendForm({
                            ...amendForm,
                            termEndsOn: e.target.value,
                          })
                        }
                      />
                    </Field>
                  )}
                  {amendForm.type === "change_timing" && (
                    <Field label={t("timing")}>
                      <Select
                        value={amendForm.billingTiming}
                        onChange={(e) =>
                          setAmendForm({
                            ...amendForm,
                            billingTiming: e.target.value,
                          })
                        }
                      >
                        <option value="advance">{t("advance")}</option>
                        <option value="arrears">{t("arrears")}</option>
                      </Select>
                    </Field>
                  )}
                  {amendForm.type === "renew" && (
                    <Field label={t("renewalMonths")}>
                      <Input
                        type="number"
                        value={amendForm.renewalTermMonths}
                        onChange={(e) =>
                          setAmendForm({
                            ...amendForm,
                            renewalTermMonths: e.target.value,
                          })
                        }
                      />
                    </Field>
                  )}
                  {amendForm.type === "coterm" && (
                    <Field label={t("anchorSubscription")}>
                      <Select
                        searchable
                        value={amendForm.anchorSubscriptionId}
                        onChange={(e) =>
                          setAmendForm({
                            ...amendForm,
                            anchorSubscriptionId: e.target.value,
                          })
                        }
                      >
                        <option value="">{t("choose")}</option>
                        {subscriptions
                          .filter(
                            (s) =>
                              s.id !== amendForm.subscriptionId &&
                              lifecycleIds.has(s.id) &&
                              (!amendmentSubscription ||
                                s.customerName ===
                                  amendmentSubscription.customerName),
                          )
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.planName}
                            </option>
                          ))}
                      </Select>
                    </Field>
                  )}
                </div>
              </InspectorPanel>
            </div>
          </Drawer>
        </div>
      )}
      <PlanVersionEntitlementsDrawer
        versionId={entVersion?.id ?? null}
        versionName={entVersion?.name ?? ""}
        open={entVersion !== null}
        onClose={() => setEntVersion(null)}
      />
      <SubscriptionEntitlementsDrawer
        subscriptionId={entSub?.id ?? null}
        subscriptionLabel={entSub?.label ?? ""}
        open={entSub !== null}
        onClose={() => setEntSub(null)}
      />
    </div>
  );
}
