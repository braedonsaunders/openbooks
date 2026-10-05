"use client";

import { LineGrid, type LineGridColumn } from "@/components/line-grid";
import { PagedTable } from "@/components/paged-table";
import { useBusinessToday } from "@/components/business-date-provider";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  DisclosureSection,
  Drawer,
  Input,
  Select,
} from "@openbooks/ui";
import { Field } from "@/components/field";

type CatalogFeature = {
  id: string;
  key: string;
  name: string;
  featureType: "boolean" | "quantity" | "metered" | "custom";
  unit: string | null;
  meterKey: string | null;
  isActive: boolean;
};

type VersionGrant = {
  featureKey: string;
  featureType: string;
  enabled: boolean;
  limitQty: string | null;
  customValue: string | null;
  overagePolicy: string;
  meterKey: string | null;
};

type EffectiveFeature = {
  featureKey: string;
  featureType: string;
  unit: string | null;
  enabled: boolean;
  limit: string | null;
  customValue: string | null;
  overagePolicy: string;
  source: "plan" | "override";
};

type Snapshot = {
  subscriptionId: string;
  planVersionId: string | null;
  planVersionNumber: number | null;
  grandfathered: boolean;
  features: EffectiveFeature[];
  sourceHash: string;
  resolvedAt: string;
};

async function readJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

function grantDisplay(forms: (key: string) => string, feature: EffectiveFeature): string {
  if (feature.featureType === "boolean") return feature.enabled ? forms("yes") : forms("no");
  if (feature.featureType === "custom") return feature.enabled ? (feature.customValue ?? "—") : forms("no");
  if (!feature.enabled) return forms("no");
  return feature.limit ?? "—";
}

/** One editable grant row. A `type` alias (never an interface) so the grid generic accepts it. */
type GrantRow = {
  _row?: unknown;
  feature?: unknown;
  type?: unknown;
  enabled?: unknown;
  limit?: unknown;
  custom?: unknown;
  overage?: unknown;
  meter?: unknown;
};

/** The six cells the drawer edits, stripped of grid bookkeeping, for change detection. */
function canonicalGrant(row: GrantRow): string {
  return JSON.stringify({
    feature: String(row.feature ?? ""),
    enabled: String(row.enabled ?? "true"),
    limit: row.limit == null || row.limit === "" ? null : String(row.limit),
    custom: row.custom == null || row.custom === "" ? null : String(row.custom),
    overage: String(row.overage ?? "block"),
    meter: row.meter == null || row.meter === "" ? null : String(row.meter),
  });
}

const POLICY_LABEL: Record<string, string> = {
  block: "policyBlock",
  allow_and_bill: "policyAllowBill",
  alert: "policyAlert",
};

const TYPE_LABEL: Record<string, string> = {
  boolean: "typeBoolean",
  quantity: "typeQuantity",
  metered: "typeMetered",
  custom: "typeCustom",
};

/** Plan-version grants: the everyday grant grid, one effective-dated row per feature. */
export function PlanVersionEntitlementsDrawer({
  versionId,
  versionName,
  open,
  onClose,
}: {
  versionId: string | null;
  versionName: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("ar.collections.subscriptions.advanced");
  const et = useTranslations("ar.collections.subscriptions.advanced.entitlements");
  const forms = useTranslations("ar.collections.forms");
  const today = useBusinessToday();
  const [catalog, setCatalog] = useState<CatalogFeature[]>([]);
  const [rows, setRows] = useState<GrantRow[]>([]);
  const [baseline, setBaseline] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const catalogByKey = useMemo(() => new Map(catalog.map((f) => [f.key, f])), [catalog]);

  const typeLabel = (featureType: string): string => et(TYPE_LABEL[featureType] ?? "typeCustom");

  useEffect(() => {
    if (!open || !versionId) return;
    const version = versionId;
    const asOf = today;
    void (async () => {
      setLoading(true);
      setNotice(null);
      setFailure(null);
      setEffectiveFrom(asOf);
      try {
        const [featuresBody, grantsBody] = (await Promise.all([
          readJson("/api/subscriptions/entitlements?features=1"),
          readJson(`/api/subscriptions/entitlements?planVersionId=${version}`),
        ])) as [{ features: CatalogFeature[] }, { entitlements: VersionGrant[] }];
        const active = featuresBody.features.filter((f) => f.isActive);
        setCatalog(active);
        const labels = new Map(active.map((f) => [f.key, et(TYPE_LABEL[f.featureType] ?? "typeCustom")]));
        const next = grantsBody.entitlements.map((g) => ({
          _row: g.featureKey,
          feature: g.featureKey,
          type: labels.get(g.featureKey) ?? "",
          enabled: g.enabled ? "true" : "false",
          limit: g.limitQty ?? "",
          custom: g.customValue ?? "",
          overage: g.overagePolicy,
          meter: g.meterKey ?? "",
        }));
        setRows(next);
        setBaseline(JSON.stringify(next.map((r) => [String(r.feature), canonicalGrant(r)])));
      } catch (error) {
        setFailure(error instanceof Error && error.message ? error.message : t("loadFailedFallback"));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, versionId, today, et, t]);

  const usedKeys = useMemo(() => new Set(rows.map((r) => String(r.feature ?? ""))), [rows]);

  const columns: LineGridColumn<GrantRow>[] = useMemo(() => [
    {
      key: "feature",
      label: et("colFeature"),
      type: "search-select",
      width: "200px",
      optionsFor: (row) => catalog
        .filter((f) => !usedKeys.has(f.key) || f.key === String(row.feature ?? ""))
        .map((f) => ({ value: f.key, label: `${f.name} (${f.key})` })),
    },
    { key: "type", label: et("colType"), type: "readonly", width: "110px" },
    {
      key: "enabled",
      label: et("enabled"),
      type: "select",
      width: "110px",
      options: [
        { value: "true", label: forms("yes") },
        { value: "false", label: forms("no") },
      ],
    },
    { key: "limit", label: et("limit"), type: "decimal", decimalScale: 8, width: "130px" },
    { key: "custom", label: et("customValue"), type: "text", width: "150px" },
    {
      key: "overage",
      label: et("colPolicy"),
      type: "select",
      width: "140px",
      optionsFor: (row) => {
        const feature = catalogByKey.get(String(row.feature ?? ""));
        if (feature && (feature.featureType === "boolean" || feature.featureType === "custom")) {
          return [{ value: "block", label: et("policyBlock") }];
        }
        return [
          { value: "block", label: et("policyBlock") },
          { value: "allow_and_bill", label: et("policyAllowBill") },
          { value: "alert", label: et("policyAlert") },
        ];
      },
    },
    { key: "meter", label: et("colMeter"), type: "text", width: "140px" },
  ], [catalog, catalogByKey, et, forms, usedKeys]);

  const handleRowsChange = (next: GrantRow[]) => {
    setRows(next.map((row) => {
      const feature = catalogByKey.get(String(row.feature ?? ""));
      const label = feature ? typeLabel(feature.featureType) : "";
      if (row.type === label) return row;
      return { ...row, type: label };
    }));
  };

  const changedCount = useMemo(() => {
    if (!baseline) return 0;
    const before = new Map<string, string>(JSON.parse(baseline) as Array<[string, string]>);
    let count = 0;
    for (const row of rows) {
      const key = String(row.feature ?? "");
      if (!key) continue;
      if (before.get(key) !== canonicalGrant(row)) count += 1;
    }
    return count;
  }, [rows, baseline]);

  const save = async () => {
    if (!versionId) return;
    setSaving(true);
    setNotice(null);
    setFailure(null);
    try {
      const before = new Map<string, string>(JSON.parse(baseline || "[]") as Array<[string, string]>);
      const changed = rows
        .filter((row) => String(row.feature ?? "").length > 0)
        .filter((row) => before.get(String(row.feature)) !== canonicalGrant(row))
        .map((row) => {
          const parsed = JSON.parse(canonicalGrant(row)) as {
            feature: string;
            enabled: string;
            limit: string | null;
            custom: string | null;
            overage: string;
            meter: string | null;
          };
          return {
            featureKey: parsed.feature,
            enabled: parsed.enabled !== "false",
            limit: parsed.limit ?? undefined,
            customValue: parsed.custom ?? undefined,
            overagePolicy: parsed.overage,
            meterKey: parsed.meter ?? undefined,
          };
        });
      await readJson("/api/subscriptions/entitlements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "saveVersionEntitlements", planVersionId: versionId, effectiveFrom, rows: changed }),
      });
      setNotice(et("grantsSaved"));
      const grantsBody = (await readJson(
        `/api/subscriptions/entitlements?planVersionId=${versionId}`,
      )) as { entitlements: VersionGrant[] };
      const next = grantsBody.entitlements.map((g) => ({
        _row: g.featureKey,
        feature: g.featureKey,
        type: typeLabel(catalogByKey.get(g.featureKey)?.featureType ?? "custom"),
        enabled: g.enabled ? "true" : "false",
        limit: g.limitQty ?? "",
        custom: g.customValue ?? "",
        overage: g.overagePolicy,
        meter: g.meterKey ?? "",
      }));
      setRows(next);
      setBaseline(JSON.stringify(next.map((r) => [String(r.feature), canonicalGrant(r)])));
    } catch (error) {
      setFailure(error instanceof Error && error.message ? error.message : t("loadFailedFallback"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`${et("versionTitle")} · ${versionName}`}
      description={et("versionDescription")}
      footer={
        <>
          <Field label={et("effectiveFrom")}>
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </Field>
          <Button variant="outline" onClick={onClose}>{t("cancel")}</Button>
          <Button onClick={save} disabled={saving || loading || changedCount === 0}>
            {saving ? t("saving") : `${et("saveGrants")} (${changedCount})`}
          </Button>
        </>
      }
    >
      {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
      {notice ? <p className="text-sm text-success">{notice}</p> : null}
      {rows.every((row) => String(row.feature ?? "") === "") ? (
        <p className="text-sm text-muted-foreground">{et("emptyGrants")}</p>
      ) : null}
      <LineGrid
        columns={columns}
        rows={rows}
        onRowsChange={handleRowsChange}
        getRowKey={(row, index) => String(row._row ?? row.feature ?? `row-${index}`)}
        emptyRow={() => ({ feature: "", type: "", enabled: "true", limit: "", custom: "", overage: "block", meter: "" })}
        addLabel={et("addGrant")}
        readOnly={loading}
      />
    </Drawer>
  );
}

/** Subscription effective entitlements with the override action beside each row. */
export function SubscriptionEntitlementsDrawer({
  subscriptionId,
  subscriptionLabel,
  open,
  onClose,
}: {
  subscriptionId: string | null;
  subscriptionLabel: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("ar.collections.subscriptions.advanced");
  const et = useTranslations("ar.collections.subscriptions.advanced.entitlements");
  const forms = useTranslations("ar.collections.forms");
  const today = useBusinessToday();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [catalog, setCatalog] = useState<CatalogFeature[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [form, setForm] = useState({
    featureKey: "",
    enabled: "true",
    limit: "",
    customValue: "",
    overagePolicy: "",
    reason: "",
    effectiveFrom: today,
    effectiveTo: "",
  });

  const reload = async (id: string) => {
    const body = (await readJson(
      `/api/subscriptions/entitlements?subscriptionId=${id}`,
    )) as { snapshot: Snapshot };
    setSnapshot(body.snapshot);
  };

  useEffect(() => {
    if (!open || !subscriptionId) return;
    const id = subscriptionId;
    const asOf = today;
    void (async () => {
      setLoading(true);
      setNotice(null);
      setFailure(null);
      setForm((f) => ({ ...f, effectiveFrom: asOf }));
      try {
        const featuresBody = (await readJson("/api/subscriptions/entitlements?features=1")) as {
          features: CatalogFeature[];
        };
        setCatalog(featuresBody.features.filter((f) => f.isActive));
        await reload(id);
      } catch (error) {
        setFailure(error instanceof Error && error.message ? error.message : t("loadFailedFallback"));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, subscriptionId, today, t]);

  const saveOverride = async () => {
    if (!subscriptionId) return;
    setSaving(true);
    setNotice(null);
    setFailure(null);
    try {
      await readJson("/api/subscriptions/entitlements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "saveOverride",
          subscriptionId,
          featureKey: form.featureKey,
          enabled: form.enabled === "" ? undefined : form.enabled !== "false",
          limit: form.limit === "" ? undefined : form.limit,
          customValue: form.customValue === "" ? undefined : form.customValue,
          overagePolicy: form.overagePolicy === "" ? undefined : form.overagePolicy,
          reason: form.reason,
          effectiveFrom: form.effectiveFrom === "" ? undefined : form.effectiveFrom,
          effectiveTo: form.effectiveTo === "" ? undefined : form.effectiveTo,
        }),
      });
      setNotice(et("overrideSaved"));
      await reload(subscriptionId);
    } catch (error) {
      setFailure(error instanceof Error && error.message ? error.message : t("loadFailedFallback"));
    } finally {
      setSaving(false);
    }
  };

  const expireOverride = async (featureKey: string) => {
    if (!subscriptionId) return;
    setSaving(true);
    setNotice(null);
    setFailure(null);
    try {
      await readJson("/api/subscriptions/entitlements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "expireOverride", subscriptionId, featureKey }),
      });
      setNotice(et("overrideExpired"));
      await reload(subscriptionId);
    } catch (error) {
      setFailure(error instanceof Error && error.message ? error.message : t("loadFailedFallback"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`${et("subscriptionTitle")} · ${subscriptionLabel}`}
      description={et("subscriptionDescription")}
      footer={<Button variant="outline" onClick={onClose}>{t("close")}</Button>}
    >
      {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
      {notice ? <p className="text-sm text-success">{notice}</p> : null}
      {snapshot?.grandfathered ? (
        <p className="text-sm text-warning">{et("pinnedNote")}</p>
      ) : null}
      <PagedTable
        searchable
        columns={[
          {
            key: "feature",
            header: <>{et("colFeature")}</>,
            search: (f: EffectiveFeature) => f.featureKey,
            cell: (f: EffectiveFeature) => <>{f.featureKey}</>,
          },
          {
            key: "type",
            header: <>{et("colType")}</>,
            cell: (f: EffectiveFeature) => <>{et(TYPE_LABEL[f.featureType] ?? "typeCustom")}</>,
          },
          {
            key: "grant",
            header: <>{et("colGrant")}</>,
            cell: (f: EffectiveFeature) => <>{grantDisplay(forms, f)}</>,
          },
          {
            key: "policy",
            header: <>{et("colPolicy")}</>,
            cell: (f: EffectiveFeature) => <>{et(POLICY_LABEL[f.overagePolicy] ?? "policyBlock")}</>,
          },
          {
            key: "source",
            header: <>{et("colSource")}</>,
            cell: (f: EffectiveFeature) => (
              <Badge variant={f.source === "override" ? "warning" : "secondary"}>
                {et(f.source === "override" ? "sourceOverride" : "sourcePlan")}
              </Badge>
            ),
          },
          {
            key: "actions",
            header: <></>,
            cell: (f: EffectiveFeature) =>
              f.source === "override" ? (
                <Button variant="outline" size="sm" onClick={() => expireOverride(f.featureKey)} disabled={saving}>
                  {et("expireOverride")}
                </Button>
              ) : null,
          },
        ]}
        rows={snapshot?.features ?? []}
        rowKey={(f: EffectiveFeature) => f.featureKey}
        empty={loading ? et("emptyGrants") : et("noOverride")}
      />
      <DisclosureSection title={et("overrideTitle")} summary={et("overrideDescription")}>
        <div className="grid gap-3">
          <Field label={et("feature")}>
            <Select searchable value={form.featureKey} onChange={(e) => setForm({ ...form, featureKey: e.target.value })}>
              <option value="">{et("feature")}</option>
              {catalog.map((f) => (
                <option key={f.key} value={f.key}>{`${f.name} (${f.key})`}</option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={et("enabled")}>
              <Select value={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.value })}>
                <option value="true">{forms("yes")}</option>
                <option value="false">{forms("no")}</option>
              </Select>
            </Field>
            <Field label={et("overagePolicy")}>
              <Select value={form.overagePolicy} onChange={(e) => setForm({ ...form, overagePolicy: e.target.value })}>
                <option value="">{et("overagePolicy")}</option>
                <option value="block">{et("policyBlock")}</option>
                <option value="allow_and_bill">{et("policyAllowBill")}</option>
                <option value="alert">{et("policyAlert")}</option>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={et("limit")}>
              <Input value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} placeholder="100" />
            </Field>
            <Field label={et("customValue")}>
              <Input value={form.customValue} onChange={(e) => setForm({ ...form, customValue: e.target.value })} />
            </Field>
          </div>
          <Field label={et("reason")}>
            <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={et("effectiveFrom")}>
              <Input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
            </Field>
            <Field label={et("effectiveTo")}>
              <Input type="date" value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} />
            </Field>
          </div>
          <div>
            <Button onClick={saveOverride} disabled={saving || form.featureKey === "" || form.reason.trim() === ""}>
              {saving ? t("saving") : et("saveOverride")}
            </Button>
          </div>
        </div>
      </DisclosureSection>
      {snapshot ? (
        <DisclosureSection
          title={snapshot.planVersionId ?? "—"}
          summary={`${et("colSource")}: ${snapshot.sourceHash.slice(0, 8)}`}
        >
          <p className="text-sm text-muted-foreground">{snapshot.resolvedAt}</p>
        </DisclosureSection>
      ) : null}
    </Drawer>
  );
}
