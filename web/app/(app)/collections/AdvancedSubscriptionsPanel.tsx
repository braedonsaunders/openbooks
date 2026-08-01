"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, Badge, Button, Card, Input, Label, Select, Skeleton } from "@openbooks/ui";
import { useMoney } from "@/components/money-provider";

type BasePlan = { id: string; name: string; interval: string; intervalCount: number; isActive: boolean };
type BaseSubscription = { id: string; customerName: string | null; planId: string; planName: string; status: string };
type Component = { componentKey: string; name: string; quantity: string; unitPrice: string; isOptional?: boolean; effectiveTo?: string | null };
type Version = { id: string; planId: string; versionNumber: number; status: string; effectiveFrom: string; name: string; interval: string; intervalCount: number; billingTiming: string; components: Component[] };
type Lifecycle = { subscriptionId: string; planVersionId: string; contractRevision: number; termStartsOn: string; termEndsOn: string | null; trialEndsOn: string | null; billingTiming: string; renewalPolicy: string; renewalTermMonths: number | null; components: Component[] };
type Amendment = { id: string; subscriptionId: string; amendmentNumber: number; amendmentType: string; effectiveOn: string; status: string; reason: string | null };

const today = () => new Date().toISOString().slice(0, 10);
const blankComponent = (): Component => ({ componentKey: "base", name: "Base subscription", quantity: "1", unitPrice: "0" });

export function AdvancedSubscriptionsPanel() {
  const { money } = useMoney();
  const [plans, setPlans] = useState<BasePlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<BaseSubscription[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [lifecycles, setLifecycles] = useState<Lifecycle[]>([]);
  const [amendments, setAmendments] = useState<Amendment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [versionForm, setVersionForm] = useState({ planId: "", effectiveFrom: today(), billingTiming: "advance", changeSummary: "", components: [blankComponent()] });
  const [lifecycleForm, setLifecycleForm] = useState({ subscriptionId: "", planVersionId: "", termStartsOn: today(), termEndsOn: "", trialEndsOn: "", renewalPolicy: "auto", renewalTermMonths: "12" });
  const [amendForm, setAmendForm] = useState({ subscriptionId: "", type: "add_component", effectiveOn: today(), componentKey: "", name: "", quantity: "1", unitPrice: "0", termEndsOn: "", billingTiming: "advance", renewalTermMonths: "12", anchorSubscriptionId: "", reason: "" });

  const load = async () => {
    try {
      const [baseResponse, advancedResponse] = await Promise.all([fetch("/api/subscriptions"), fetch("/api/subscriptions/advanced")]);
      if (!baseResponse.ok || !advancedResponse.ok) throw new Error("Could not load advanced subscription lifecycle data");
      const [base, advanced] = await Promise.all([baseResponse.json(), advancedResponse.json()]);
      setPlans(base.plans ?? []); setSubscriptions(base.subscriptions ?? []);
      setVersions(advanced.versions ?? []); setLifecycles(advanced.lifecycles ?? []); setAmendments(advanced.amendments ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load advanced subscriptions");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const post = async (payload: Record<string, unknown>) => {
    setBusy(true); setError(null); setMessage(null);
    const response = await fetch("/api/subscriptions/advanced", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) { setError(body.error ?? "Action failed"); return null; }
    await load();
    return body;
  };

  const lifecycleIds = useMemo(() => new Set(lifecycles.map((row) => row.subscriptionId)), [lifecycles]);
  const selectedSubscription = subscriptions.find((row) => row.id === lifecycleForm.subscriptionId);
  const eligibleVersions = versions.filter((row) => row.status === "published" && (!selectedSubscription || row.planId === selectedSubscription.planId));
  const amendmentSubscription = subscriptions.find((row) => row.id === amendForm.subscriptionId);

  if (loading) return <Card className="space-y-3 p-4" aria-label="Loading advanced subscriptions"><Skeleton className="h-5 w-48" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></Card>;

  return (
    <div className="space-y-6">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {message && <Alert variant="success"><AlertDescription>{message}</AlertDescription></Alert>}

      <Card className="p-4">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div><h3 className="text-sm font-semibold">Effective-dated catalog</h3><p className="text-xs text-muted-foreground">Published versions are immutable. Create a new version when commercial terms change.</p></div>
          <Badge variant="secondary">{versions.filter((v) => v.status === "published").length} published</Badge>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground"><tr><th className="py-1">Version</th><th>Effective</th><th>Timing</th><th>Components</th><th></th></tr></thead>
            <tbody>
              {versions.map((version) => <tr key={version.id} className="border-t align-top"><td className="py-2"><span className="font-medium">{version.name}</span> <Badge variant={version.status === "published" ? "default" : "secondary"}>v{version.versionNumber} {version.status}</Badge></td><td>{version.effectiveFrom}</td><td className="capitalize">{version.billingTiming}</td><td>{version.components.map((c) => c.name).join(", ")}</td><td className="text-right">{version.status === "draft" && <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { if (await post({ action: "publishVersion", versionId: version.id })) setMessage(`Published ${version.name} v${version.versionNumber}`); }}>Publish</Button>}</td></tr>)}
              {!versions.length && <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">No catalog versions yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <div><Label>Base plan</Label><Select value={versionForm.planId} onChange={(e) => setVersionForm({ ...versionForm, planId: e.target.value })}><option value="">Choose a plan…</option>{plans.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
          <div><Label>Effective from</Label><Input type="date" value={versionForm.effectiveFrom} onChange={(e) => setVersionForm({ ...versionForm, effectiveFrom: e.target.value })} /></div>
          <div><Label>Invoice timing</Label><Select value={versionForm.billingTiming} onChange={(e) => setVersionForm({ ...versionForm, billingTiming: e.target.value })}><option value="advance">In advance</option><option value="arrears">In arrears</option></Select></div>
          <div><Label>Change summary</Label><Input value={versionForm.changeSummary} onChange={(e) => setVersionForm({ ...versionForm, changeSummary: e.target.value })} placeholder="Initial catalog" /></div>
        </div>
        <div className="mt-3 space-y-2">
          {versionForm.components.map((component, index) => <div key={index} className="grid gap-2 rounded-md border p-2 sm:grid-cols-5"><div><Label className="sr-only" htmlFor={`catalog-component-key-${index}`}>Component key</Label><Input id={`catalog-component-key-${index}`} placeholder="Key" value={component.componentKey} onChange={(e) => setVersionForm({ ...versionForm, components: versionForm.components.map((c, i) => i === index ? { ...c, componentKey: e.target.value } : c) })} /></div><div className="sm:col-span-2"><Label className="sr-only" htmlFor={`catalog-component-name-${index}`}>Component name</Label><Input id={`catalog-component-name-${index}`} placeholder="Component name" value={component.name} onChange={(e) => setVersionForm({ ...versionForm, components: versionForm.components.map((c, i) => i === index ? { ...c, name: e.target.value } : c) })} /></div><div><Label className="sr-only" htmlFor={`catalog-component-quantity-${index}`}>Quantity</Label><Input id={`catalog-component-quantity-${index}`} type="number" placeholder="Qty" value={component.quantity} onChange={(e) => setVersionForm({ ...versionForm, components: versionForm.components.map((c, i) => i === index ? { ...c, quantity: e.target.value } : c) })} /></div><div className="flex gap-1"><div className="flex-1"><Label className="sr-only" htmlFor={`catalog-component-price-${index}`}>Unit price</Label><Input id={`catalog-component-price-${index}`} type="number" placeholder="Price" value={component.unitPrice} onChange={(e) => setVersionForm({ ...versionForm, components: versionForm.components.map((c, i) => i === index ? { ...c, unitPrice: e.target.value } : c) })} /></div>{versionForm.components.length > 1 && <Button size="sm" variant="ghost" aria-label={`Remove ${component.name || "component"}`} onClick={() => setVersionForm({ ...versionForm, components: versionForm.components.filter((_, i) => i !== index) })}>×</Button>}</div></div>)}
        </div>
        <div className="mt-3 flex gap-2"><Button size="sm" variant="secondary" onClick={() => setVersionForm({ ...versionForm, components: [...versionForm.components, { ...blankComponent(), componentKey: `addon-${versionForm.components.length}`, name: "Add-on" }] })}>Add component</Button><Button size="sm" disabled={busy || !versionForm.planId || versionForm.components.some((c) => !c.componentKey || !c.name)} onClick={async () => { const result = await post({ action: "createVersion", ...versionForm }); if (result) { setMessage("Draft catalog version created"); setVersionForm({ planId: "", effectiveFrom: today(), billingTiming: "advance", changeSummary: "", components: [blankComponent()] }); } }}>Create draft</Button></div>
      </Card>

      <Card className="p-4">
        <h3 className="text-sm font-semibold">Contract lifecycle</h3><p className="mb-3 text-xs text-muted-foreground">Attach a published version, optional trial, term and renewal policy to an existing subscription.</p>
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
          <div><Label>Subscription</Label><Select value={lifecycleForm.subscriptionId} onChange={(e) => setLifecycleForm({ ...lifecycleForm, subscriptionId: e.target.value, planVersionId: "" })}><option value="">Choose…</option>{subscriptions.filter((s) => !lifecycleIds.has(s.id) && s.status !== "canceled").map((s) => <option key={s.id} value={s.id}>{s.customerName ?? "Customer"} · {s.planName}</option>)}</Select></div>
          <div><Label>Published version</Label><Select value={lifecycleForm.planVersionId} onChange={(e) => setLifecycleForm({ ...lifecycleForm, planVersionId: e.target.value })}><option value="">Choose…</option>{eligibleVersions.map((v) => <option key={v.id} value={v.id}>{v.name} · v{v.versionNumber}</option>)}</Select></div>
          <div><Label>Term starts</Label><Input type="date" value={lifecycleForm.termStartsOn} onChange={(e) => setLifecycleForm({ ...lifecycleForm, termStartsOn: e.target.value })} /></div>
          <div><Label>Term ends</Label><Input type="date" value={lifecycleForm.termEndsOn} onChange={(e) => setLifecycleForm({ ...lifecycleForm, termEndsOn: e.target.value })} /></div>
          <div><Label>Trial ends</Label><Input type="date" value={lifecycleForm.trialEndsOn} onChange={(e) => setLifecycleForm({ ...lifecycleForm, trialEndsOn: e.target.value })} /></div>
          <div><Label>Renewal</Label><Select value={lifecycleForm.renewalPolicy} onChange={(e) => setLifecycleForm({ ...lifecycleForm, renewalPolicy: e.target.value })}><option value="auto">Auto-renew</option><option value="manual">Manual renewal</option><option value="none">No renewal</option></Select></div>
          <div><Label>Renewal term (months)</Label><Input type="number" value={lifecycleForm.renewalTermMonths} onChange={(e) => setLifecycleForm({ ...lifecycleForm, renewalTermMonths: e.target.value })} /></div>
          <div className="flex items-end"><Button disabled={busy || !lifecycleForm.subscriptionId || !lifecycleForm.planVersionId} onClick={async () => { if (await post({ action: "activateLifecycle", ...lifecycleForm })) { setMessage("Advanced lifecycle activated"); setLifecycleForm({ subscriptionId: "", planVersionId: "", termStartsOn: today(), termEndsOn: "", trialEndsOn: "", renewalPolicy: "auto", renewalTermMonths: "12" }); } }}>Activate lifecycle</Button></div>
        </div>
        <div className="mt-4 space-y-2">{lifecycles.map((lifecycle) => { const sub = subscriptions.find((s) => s.id === lifecycle.subscriptionId); return <div key={lifecycle.subscriptionId} className="rounded-md border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><span className="font-medium">{sub?.customerName ?? "Customer"} · {sub?.planName ?? "Subscription"}</span><span className="ml-2 text-xs text-muted-foreground">revision {lifecycle.contractRevision}</span></div><div className="flex gap-1"><Badge variant="secondary">{lifecycle.billingTiming}</Badge><Badge variant="secondary">{lifecycle.renewalPolicy}</Badge></div></div><div className="mt-1 text-xs text-muted-foreground">{lifecycle.trialEndsOn ? `Trial through ${lifecycle.trialEndsOn} · ` : ""}Term {lifecycle.termStartsOn} → {lifecycle.termEndsOn ?? "open"}</div><div className="mt-2 flex flex-wrap gap-2">{lifecycle.components.filter((c) => !c.effectiveTo).map((c) => <span key={c.componentKey} className="rounded bg-muted px-2 py-1 text-xs">{c.name}: {c.quantity} × {money(c.unitPrice)}</span>)}</div></div>; })}</div>
      </Card>

      <Card className="p-4">
        <h3 className="text-sm font-semibold">Amend contract</h3><p className="mb-3 text-xs text-muted-foreground">Every applied amendment is append-only and increments the contract revision.</p>
        <div className="grid gap-3 md:grid-cols-4">
          <div><Label>Subscription</Label><Select value={amendForm.subscriptionId} onChange={(e) => setAmendForm({ ...amendForm, subscriptionId: e.target.value })}><option value="">Choose…</option>{subscriptions.filter((s) => lifecycleIds.has(s.id)).map((s) => <option key={s.id} value={s.id}>{s.customerName ?? "Customer"} · {s.planName}</option>)}</Select></div>
          <div><Label>Change</Label><Select value={amendForm.type} onChange={(e) => setAmendForm({ ...amendForm, type: e.target.value })}><option value="add_component">Add component</option><option value="change_component">Change component</option><option value="remove_component">Remove component</option><option value="change_term">Change term</option><option value="change_timing">Change billing timing</option><option value="renew">Renew</option><option value="coterm">Co-term</option></Select></div>
          <div><Label>Effective on</Label><Input type="date" value={amendForm.effectiveOn} onChange={(e) => setAmendForm({ ...amendForm, effectiveOn: e.target.value })} /></div>
          <div><Label>Reason</Label><Input value={amendForm.reason} onChange={(e) => setAmendForm({ ...amendForm, reason: e.target.value })} /></div>
          {["add_component", "change_component", "remove_component"].includes(amendForm.type) && <><div><Label>Component key</Label><Input value={amendForm.componentKey} onChange={(e) => setAmendForm({ ...amendForm, componentKey: e.target.value })} /></div>{amendForm.type !== "remove_component" && <><div><Label>Name</Label><Input value={amendForm.name} onChange={(e) => setAmendForm({ ...amendForm, name: e.target.value })} /></div><div><Label>Quantity</Label><Input type="number" value={amendForm.quantity} onChange={(e) => setAmendForm({ ...amendForm, quantity: e.target.value })} /></div><div><Label>Unit price</Label><Input type="number" value={amendForm.unitPrice} onChange={(e) => setAmendForm({ ...amendForm, unitPrice: e.target.value })} /></div></>}</>}
          {amendForm.type === "change_term" && <div><Label>New term end</Label><Input type="date" value={amendForm.termEndsOn} onChange={(e) => setAmendForm({ ...amendForm, termEndsOn: e.target.value })} /></div>}
          {amendForm.type === "change_timing" && <div><Label>Timing</Label><Select value={amendForm.billingTiming} onChange={(e) => setAmendForm({ ...amendForm, billingTiming: e.target.value })}><option value="advance">In advance</option><option value="arrears">In arrears</option></Select></div>}
          {amendForm.type === "renew" && <div><Label>Renewal months</Label><Input type="number" value={amendForm.renewalTermMonths} onChange={(e) => setAmendForm({ ...amendForm, renewalTermMonths: e.target.value })} /></div>}
          {amendForm.type === "coterm" && <div><Label>Anchor subscription</Label><Select value={amendForm.anchorSubscriptionId} onChange={(e) => setAmendForm({ ...amendForm, anchorSubscriptionId: e.target.value })}><option value="">Choose…</option>{subscriptions.filter((s) => s.id !== amendForm.subscriptionId && lifecycleIds.has(s.id) && (!amendmentSubscription || s.customerName === amendmentSubscription.customerName)).map((s) => <option key={s.id} value={s.id}>{s.planName}</option>)}</Select></div>}
        </div>
        <Button className="mt-3" size="sm" disabled={busy || !amendForm.subscriptionId} onClick={async () => { const result = await post({ action: "amend", ...amendForm, idempotencyKey: crypto.randomUUID(), renewalTermMonths: Number(amendForm.renewalTermMonths || 12) }); if (result) { setMessage("Contract amendment applied"); } }}>Apply amendment</Button>
        <div className="mt-4 overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-muted-foreground"><tr><th className="py-1">#</th><th>Subscription</th><th>Change</th><th>Effective</th><th>Reason</th></tr></thead><tbody>{amendments.map((a) => <tr key={a.id} className="border-t"><td className="py-2">{a.amendmentNumber}</td><td>{subscriptions.find((s) => s.id === a.subscriptionId)?.planName ?? "Subscription"}</td><td>{a.amendmentType.replaceAll("_", " ")}</td><td>{a.effectiveOn}</td><td>{a.reason ?? "—"}</td></tr>)}{!amendments.length && <tr><td colSpan={5} className="py-4 text-center text-muted-foreground">No amendments yet.</td></tr>}</tbody></table></div>
      </Card>
    </div>
  );
}
