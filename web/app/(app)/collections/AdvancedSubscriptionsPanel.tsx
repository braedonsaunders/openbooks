"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Badge, Button, Card, Input, Label, Select, Skeleton } from "@openbooks/ui";
import { Field } from "@/components/field";
import { useBusinessToday } from "@/components/business-date-provider";
import { useMoney } from "@/components/money-provider";

type BasePlan = { id: string; name: string; interval: string; intervalCount: number; isActive: boolean };
type BaseSubscription = { id: string; customerName: string | null; planId: string; planName: string; status: string };
type Component = { componentKey: string; name: string; quantity: string; unitPrice: string; isOptional?: boolean; effectiveTo?: string | null };
type Version = { id: string; planId: string; versionNumber: number; status: string; effectiveFrom: string; name: string; interval: string; intervalCount: number; billingTiming: string; components: Component[] };
type Lifecycle = { subscriptionId: string; planVersionId: string; contractRevision: number; termStartsOn: string; termEndsOn: string | null; trialEndsOn: string | null; billingTiming: string; renewalPolicy: string; renewalTermMonths: number | null; components: Component[] };
type Amendment = { id: string; subscriptionId: string; amendmentNumber: number; amendmentType: string; effectiveOn: string; status: string; reason: string | null };

const blankComponent = (name: string): Component => ({ componentKey: "base", name, quantity: "1", unitPrice: "0" });

export function AdvancedSubscriptionsPanel() {
  const t = useTranslations("ar.collections.subscriptions.advanced");
  const { money } = useMoney();
  const today = useBusinessToday();
  const [plans, setPlans] = useState<BasePlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<BaseSubscription[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [lifecycles, setLifecycles] = useState<Lifecycle[]>([]);
  const [amendments, setAmendments] = useState<Amendment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [versionForm, setVersionForm] = useState({ planId: "", effectiveFrom: today, billingTiming: "advance", changeSummary: "", components: [blankComponent(t("baseSubscription"))] });
  const [lifecycleForm, setLifecycleForm] = useState({ subscriptionId: "", planVersionId: "", termStartsOn: today, termEndsOn: "", trialEndsOn: "", renewalPolicy: "auto", renewalTermMonths: "12" });
  const [amendForm, setAmendForm] = useState({ subscriptionId: "", type: "add_component", effectiveOn: today, componentKey: "", name: "", quantity: "1", unitPrice: "0", termEndsOn: "", billingTiming: "advance", renewalTermMonths: "12", anchorSubscriptionId: "", reason: "" });

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body. Memoized on the
  // catalog text so the mount effect below stays single-shot per locale.
  const load = useCallback(() => {
    return Promise.all([fetch("/api/subscriptions"), fetch("/api/subscriptions/advanced")])
      .then(([baseResponse, advancedResponse]) => {
        if (!baseResponse.ok || !advancedResponse.ok) throw new Error(t("loadFailed"));
        return Promise.all([baseResponse.json(), advancedResponse.json()]).then(([base, advanced]) => {
          setPlans(base.plans ?? []); setSubscriptions(base.subscriptions ?? []);
          setVersions(advanced.versions ?? []); setLifecycles(advanced.lifecycles ?? []); setAmendments(advanced.amendments ?? []);
        });
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : t("loadFailedFallback"));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const post = async (payload: Record<string, unknown>) => {
    setBusy(true); setError(null); setMessage(null);
    const response = await fetch("/api/subscriptions/advanced", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) { setError(body.error ?? t("actionFailed")); return null; }
    await load();
    return body;
  };

  const lifecycleIds = useMemo(() => new Set(lifecycles.map((row) => row.subscriptionId)), [lifecycles]);
  const selectedSubscription = subscriptions.find((row) => row.id === lifecycleForm.subscriptionId);
  const eligibleVersions = versions.filter((row) => row.status === "published" && (!selectedSubscription || row.planId === selectedSubscription.planId));
  const amendmentSubscription = subscriptions.find((row) => row.id === amendForm.subscriptionId);

  /** Stored timing/renewal enums render through the catalog; unknown values stay raw. */
  const timingLabel = (value: string) => value === "advance" ? t("timingAdvance") : value === "arrears" ? t("timingArrears") : value;
  const renewalLabel = (value: string) => value === "auto" ? t("renewalAuto") : value === "manual" ? t("renewalManual") : value === "none" ? t("renewalNone") : value;
  const changeTypeLabel = (value: string) => {
    const key = `changeType_${value}`;
    return t.has(key) ? t(key) : value.replaceAll("_", " ");
  };

  if (loading) return <Card className="space-y-3 p-4" aria-label={t("loading")}><Skeleton className="h-5 w-48" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></Card>;

  return (
    <div className="space-y-6">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {message && <Alert variant="success"><AlertDescription>{message}</AlertDescription></Alert>}

      <Card className="p-4">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div><h3 className="text-sm font-semibold">{t("catalogTitle")}</h3><p className="text-xs text-muted-foreground">{t("catalogDescription")}</p></div>
          <Badge variant="secondary">{t("publishedCount", { count: versions.filter((v) => v.status === "published").length })}</Badge>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground"><tr><th className="py-1">{t("colVersion")}</th><th>{t("colEffective")}</th><th>{t("colTiming")}</th><th>{t("colComponents")}</th><th></th></tr></thead>
            <tbody>
              {versions.map((version) => <tr key={version.id} className="border-t align-top"><td className="py-2"><span className="font-medium">{version.name}</span> <Badge variant={version.status === "published" ? "default" : "secondary"}>v{version.versionNumber} {version.status}</Badge></td><td>{version.effectiveFrom}</td><td>{timingLabel(version.billingTiming)}</td><td>{version.components.map((c) => c.name).join(", ")}</td><td className="text-right">{version.status === "draft" && <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { if (await post({ action: "publishVersion", versionId: version.id })) setMessage(t("publishedMessage", { name: version.name, version: version.versionNumber })); }}>{t("publish")}</Button>}</td></tr>)}
              {!versions.length && <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">{t("noVersions")}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <Field label={t("basePlan")}><Select value={versionForm.planId} onChange={(e) => setVersionForm({ ...versionForm, planId: e.target.value })}><option value="">{t("choosePlan")}</option>{plans.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label={t("effectiveFrom")}><Input type="date" value={versionForm.effectiveFrom} onChange={(e) => setVersionForm({ ...versionForm, effectiveFrom: e.target.value })} /></Field>
          <Field label={t("invoiceTiming")}><Select value={versionForm.billingTiming} onChange={(e) => setVersionForm({ ...versionForm, billingTiming: e.target.value })}><option value="advance">{t("advance")}</option><option value="arrears">{t("arrears")}</option></Select></Field>
          <Field label={t("changeSummary")}><Input value={versionForm.changeSummary} onChange={(e) => setVersionForm({ ...versionForm, changeSummary: e.target.value })} placeholder={t("initialCatalog")} /></Field>
        </div>
        <div className="mt-3 space-y-2">
          {versionForm.components.map((component, index) => <div key={index} className="grid gap-2 rounded-md border p-2 sm:grid-cols-5"><div><Label htmlFor={`catalog-component-key-${index}`}>{t("componentKey")}</Label><Input id={`catalog-component-key-${index}`} placeholder={t("keyPlaceholder")} value={component.componentKey} onChange={(e) => setVersionForm({ ...versionForm, components: versionForm.components.map((c, i) => i === index ? { ...c, componentKey: e.target.value } : c) })} /></div><div className="sm:col-span-2"><Label htmlFor={`catalog-component-name-${index}`}>{t("componentName")}</Label><Input id={`catalog-component-name-${index}`} placeholder={t("namePlaceholder")} value={component.name} onChange={(e) => setVersionForm({ ...versionForm, components: versionForm.components.map((c, i) => i === index ? { ...c, name: e.target.value } : c) })} /></div><div><Label htmlFor={`catalog-component-quantity-${index}`}>{t("quantity")}</Label><Input id={`catalog-component-quantity-${index}`} type="number" placeholder={t("qtyPlaceholder")} value={component.quantity} onChange={(e) => setVersionForm({ ...versionForm, components: versionForm.components.map((c, i) => i === index ? { ...c, quantity: e.target.value } : c) })} /></div><div className="flex gap-1"><div className="flex-1"><Label htmlFor={`catalog-component-price-${index}`}>{t("unitPrice")}</Label><Input id={`catalog-component-price-${index}`} type="number" placeholder={t("pricePlaceholder")} value={component.unitPrice} onChange={(e) => setVersionForm({ ...versionForm, components: versionForm.components.map((c, i) => i === index ? { ...c, unitPrice: e.target.value } : c) })} /></div>{versionForm.components.length > 1 && <Button size="sm" variant="ghost" aria-label={t("removeComponent", { name: component.name || t("fallbackComponent") })} onClick={() => setVersionForm({ ...versionForm, components: versionForm.components.filter((_, i) => i !== index) })}>×</Button>}</div></div>)}
        </div>
        <div className="mt-3 flex gap-2"><Button size="sm" variant="secondary" onClick={() => setVersionForm({ ...versionForm, components: [...versionForm.components, { ...blankComponent(t("baseSubscription")), componentKey: `addon-${versionForm.components.length}`, name: t("addonName") }] })}>{t("addComponent")}</Button><Button size="sm" disabled={busy || !versionForm.planId || versionForm.components.some((c) => !c.componentKey || !c.name)} onClick={async () => { const result = await post({ action: "createVersion", ...versionForm }); if (result) { setMessage(t("draftCreated")); setVersionForm({ planId: "", effectiveFrom: today, billingTiming: "advance", changeSummary: "", components: [blankComponent(t("baseSubscription"))] }); } }}>{t("createDraft")}</Button></div>
      </Card>

      <Card className="p-4">
        <h3 className="text-sm font-semibold">{t("lifecycleTitle")}</h3><p className="mb-3 text-xs text-muted-foreground">{t("lifecycleDescription")}</p>
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
          <Field label={t("subscription")}><Select value={lifecycleForm.subscriptionId} onChange={(e) => setLifecycleForm({ ...lifecycleForm, subscriptionId: e.target.value, planVersionId: "" })}><option value="">{t("choose")}</option>{subscriptions.filter((s) => !lifecycleIds.has(s.id) && s.status !== "canceled").map((s) => <option key={s.id} value={s.id}>{s.customerName ?? t("customerFallback")} · {s.planName}</option>)}</Select></Field>
          <Field label={t("publishedVersion")}><Select value={lifecycleForm.planVersionId} onChange={(e) => setLifecycleForm({ ...lifecycleForm, planVersionId: e.target.value })}><option value="">{t("choose")}</option>{eligibleVersions.map((v) => <option key={v.id} value={v.id}>{v.name} · v{v.versionNumber}</option>)}</Select></Field>
          <Field label={t("termStarts")}><Input type="date" value={lifecycleForm.termStartsOn} onChange={(e) => setLifecycleForm({ ...lifecycleForm, termStartsOn: e.target.value })} /></Field>
          <Field label={t("termEnds")}><Input type="date" value={lifecycleForm.termEndsOn} onChange={(e) => setLifecycleForm({ ...lifecycleForm, termEndsOn: e.target.value })} /></Field>
          <Field label={t("trialEnds")}><Input type="date" value={lifecycleForm.trialEndsOn} onChange={(e) => setLifecycleForm({ ...lifecycleForm, trialEndsOn: e.target.value })} /></Field>
          <Field label={t("renewal")}><Select value={lifecycleForm.renewalPolicy} onChange={(e) => setLifecycleForm({ ...lifecycleForm, renewalPolicy: e.target.value })}><option value="auto">{t("renewAuto")}</option><option value="manual">{t("renewManual")}</option><option value="none">{t("renewNone")}</option></Select></Field>
          <Field label={t("renewalTermMonths")}><Input type="number" value={lifecycleForm.renewalTermMonths} onChange={(e) => setLifecycleForm({ ...lifecycleForm, renewalTermMonths: e.target.value })} /></Field>
          <div className="flex items-end"><Button disabled={busy || !lifecycleForm.subscriptionId || !lifecycleForm.planVersionId} onClick={async () => { if (await post({ action: "activateLifecycle", ...lifecycleForm })) { setMessage(t("lifecycleActivated")); setLifecycleForm({ subscriptionId: "", planVersionId: "", termStartsOn: today, termEndsOn: "", trialEndsOn: "", renewalPolicy: "auto", renewalTermMonths: "12" }); } }}>{t("activateLifecycle")}</Button></div>
        </div>
        <div className="mt-4 space-y-2">{lifecycles.map((lifecycle) => { const sub = subscriptions.find((s) => s.id === lifecycle.subscriptionId); return <div key={lifecycle.subscriptionId} className="rounded-md border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><span className="font-medium">{sub?.customerName ?? t("customerFallback")} · {sub?.planName ?? t("subscriptionFallback")}</span><span className="ml-2 text-xs text-muted-foreground">{t("revision", { rev: lifecycle.contractRevision })}</span></div><div className="flex gap-1"><Badge variant="secondary">{timingLabel(lifecycle.billingTiming)}</Badge><Badge variant="secondary">{renewalLabel(lifecycle.renewalPolicy)}</Badge></div></div><div className="mt-1 text-xs text-muted-foreground">{lifecycle.trialEndsOn ? `${t("trialThrough", { date: lifecycle.trialEndsOn })} · ` : ""}{t("termLine", { start: lifecycle.termStartsOn, end: lifecycle.termEndsOn ?? t("openEnd") })}</div><div className="mt-2 flex flex-wrap gap-2">{lifecycle.components.filter((c) => !c.effectiveTo).map((c) => <span key={c.componentKey} className="rounded bg-muted px-2 py-1 text-xs">{c.name}: {c.quantity} × {money(c.unitPrice)}</span>)}</div></div>; })}</div>
      </Card>

      <Card className="p-4">
        <h3 className="text-sm font-semibold">{t("amendTitle")}</h3><p className="mb-3 text-xs text-muted-foreground">{t("amendDescription")}</p>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label={t("subscription")}><Select value={amendForm.subscriptionId} onChange={(e) => setAmendForm({ ...amendForm, subscriptionId: e.target.value })}><option value="">{t("choose")}</option>{subscriptions.filter((s) => lifecycleIds.has(s.id)).map((s) => <option key={s.id} value={s.id}>{s.customerName ?? t("customerFallback")} · {s.planName}</option>)}</Select></Field>
          <Field label={t("change")}><Select value={amendForm.type} onChange={(e) => setAmendForm({ ...amendForm, type: e.target.value })}><option value="add_component">{t("changeAdd")}</option><option value="change_component">{t("changeChange")}</option><option value="remove_component">{t("changeRemove")}</option><option value="change_term">{t("changeTerm")}</option><option value="change_timing">{t("changeTiming")}</option><option value="renew">{t("changeRenew")}</option><option value="coterm">{t("changeCoterm")}</option></Select></Field>
          <Field label={t("effectiveOn")}><Input type="date" value={amendForm.effectiveOn} onChange={(e) => setAmendForm({ ...amendForm, effectiveOn: e.target.value })} /></Field>
          <Field label={t("reason")}><Input value={amendForm.reason} onChange={(e) => setAmendForm({ ...amendForm, reason: e.target.value })} /></Field>
          {["add_component", "change_component", "remove_component"].includes(amendForm.type) && <><Field label={t("componentKey")}><Input value={amendForm.componentKey} onChange={(e) => setAmendForm({ ...amendForm, componentKey: e.target.value })} /></Field>{amendForm.type !== "remove_component" && <><Field label={t("name")}><Input value={amendForm.name} onChange={(e) => setAmendForm({ ...amendForm, name: e.target.value })} /></Field><Field label={t("quantity")}><Input type="number" value={amendForm.quantity} onChange={(e) => setAmendForm({ ...amendForm, quantity: e.target.value })} /></Field><Field label={t("unitPrice")}><Input type="number" value={amendForm.unitPrice} onChange={(e) => setAmendForm({ ...amendForm, unitPrice: e.target.value })} /></Field></>}</>}
          {amendForm.type === "change_term" && <Field label={t("newTermEnd")}><Input type="date" value={amendForm.termEndsOn} onChange={(e) => setAmendForm({ ...amendForm, termEndsOn: e.target.value })} /></Field>}
          {amendForm.type === "change_timing" && <Field label={t("timing")}><Select value={amendForm.billingTiming} onChange={(e) => setAmendForm({ ...amendForm, billingTiming: e.target.value })}><option value="advance">{t("advance")}</option><option value="arrears">{t("arrears")}</option></Select></Field>}
          {amendForm.type === "renew" && <Field label={t("renewalMonths")}><Input type="number" value={amendForm.renewalTermMonths} onChange={(e) => setAmendForm({ ...amendForm, renewalTermMonths: e.target.value })} /></Field>}
          {amendForm.type === "coterm" && <Field label={t("anchorSubscription")}><Select value={amendForm.anchorSubscriptionId} onChange={(e) => setAmendForm({ ...amendForm, anchorSubscriptionId: e.target.value })}><option value="">{t("choose")}</option>{subscriptions.filter((s) => s.id !== amendForm.subscriptionId && lifecycleIds.has(s.id) && (!amendmentSubscription || s.customerName === amendmentSubscription.customerName)).map((s) => <option key={s.id} value={s.id}>{s.planName}</option>)}</Select></Field>}
        </div>
        <Button className="mt-3" size="sm" disabled={busy || !amendForm.subscriptionId} onClick={async () => { const result = await post({ action: "amend", ...amendForm, idempotencyKey: crypto.randomUUID(), renewalTermMonths: Number(amendForm.renewalTermMonths || 12) }); if (result) { setMessage(t("amendmentApplied")); } }}>{t("applyAmendment")}</Button>
        <div className="mt-4 overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-muted-foreground"><tr><th className="py-1">{t("colNumber")}</th><th>{t("colSubscription")}</th><th>{t("colChange")}</th><th>{t("colEffective")}</th><th>{t("colReason")}</th></tr></thead><tbody>{amendments.map((a) => <tr key={a.id} className="border-t"><td className="py-2">{a.amendmentNumber}</td><td>{subscriptions.find((s) => s.id === a.subscriptionId)?.planName ?? t("subscriptionFallback")}</td><td>{changeTypeLabel(a.amendmentType)}</td><td>{a.effectiveOn}</td><td>{a.reason ?? "—"}</td></tr>)}{!amendments.length && <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">{t("noAmendments")}</td></tr>}</tbody></table></div>
      </Card>
    </div>
  );
}
