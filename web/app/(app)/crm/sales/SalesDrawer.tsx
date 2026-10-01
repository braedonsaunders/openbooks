"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Button,
  Input,
  Select,
  Textarea,
  UrlDrawer,
  Badge,
} from "@openbooks/ui";
import { apiJson } from "@/lib/api-error";
import type {
  SalesCommand,
  SalesOption,
  SalesWorkspaceData,
  TerritoryGeography,
} from "@openbooks/engine/crm/sales/contracts";
import { EMPTY_TERRITORY_GEOGRAPHY } from "@openbooks/engine/crm/sales/contracts";
import type { TerritoryRule } from "@openbooks/engine/crm/sales/contracts";
import type { TerritoryPreview } from "@openbooks/engine/crm/sales";
const TerritoryMap = dynamic(
  () => import("./TerritoryMap").then((m) => m.TerritoryMap),
  { ssr: false },
);
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function SalesDrawer({
  data,
  closeHref,
}: {
  data: SalesWorkspaceData;
  closeHref: string;
}) {
  const t = useTranslations("crm.sales");
  const router = useRouter();
  const source = data.selected;
  const row = data.creating ? null : data.selected;
  const [name, setName] = useState(source?.name ?? "");
  const [subsidiaryId, setSubsidiary] = useState(
    source?.subsidiary_id ?? data.subsidiaries[0]?.id ?? "",
  );
  const [employeeId, setEmployee] = useState(
    source?.employee_id ?? row?.default_employee_id ?? "",
  );
  const [manager, setManager] = useState(source?.manager_employee_id ?? "");
  const [teamId, setTeam] = useState(source?.sales_team_id ?? "");
  const [repId, setRep] = useState(source?.id ?? "");
  const [enabled, setEnabled] = useState(source?.is_sales_rep ?? true);
  const [since, setSince] = useState(source?.sales_rep_since ?? data.periodEnd);
  const [members, setMembers] = useState(source?.members ?? []);
  const [adding, setAdding] = useState("");
  const [memberDate, setMemberDate] = useState(data.periodEnd);
  const [amount, setAmount] = useState(source?.amount ?? "");
  const [currency, setCurrency] = useState(
    source?.currency ?? data.baseCurrency,
  );
  const [metric, setMetric] = useState<"closed_won" | "net_invoiced">(
    row?.metric ?? "closed_won",
  );
  const [start, setStart] = useState(source?.period_start ?? data.periodStart);
  const [end, setEnd] = useState(source?.period_end ?? data.periodEnd);
  const [reason, setReason] = useState(source?.reason ?? "");
  const [parentId, setParent] = useState(source?.parent_quota_id ?? "");
  const [supersedesId, setSupersedes] = useState(
    data.creating && source ? source.id : (source?.supersedes_id ?? ""),
  );
  const [description, setDescription] = useState(source?.description ?? "");
  const [priority, setPriority] = useState(source?.priority ?? 100);
  const [rules, setRules] = useState<TerritoryRule[]>(row?.rules ?? []);
  const [matchMode, setMatchMode] = useState<"all" | "any">(
    row?.match_mode ?? "all",
  );
  const [geography, setGeography] = useState<TerritoryGeography>(
    row?.geography ?? EMPTY_TERRITORY_GEOGRAPHY,
  );
  const [effective, setEffective] = useState(
    source?.effective_from ?? data.periodEnd,
  );
  const [lifecycle, setLifecycle] = useState<"draft" | "active" | "archived">(
    data.page === "territories"
      ? ((row?.lifecycle as "draft" | "active" | "archived") ?? "draft")
      : "draft",
  );
  const [isActive, setActive] = useState(source?.is_active ?? true);
  const [preview, setPreview] = useState<TerritoryPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editable =
    data.canManage &&
    (data.page !== "quotas" || !row || row.lifecycle === "draft");
  const options = (values: SalesOption[], blank = true) => (
    <>
      {blank ? <option value="">{t("none")}</option> : null}
      {values.map((v) => (
        <option key={v.id} value={v.id}>
          {v.name}
        </option>
      ))}
    </>
  );
  const reps = data.representatives.filter(
    (e) => e.subsidiary_id === subsidiaryId,
  );
  const selectedRep = data.rows.find((e) => e.id === repId);
  function territory(): Extract<SalesCommand, { action: "territory" }> {
    return {
      action: "territory",
      id: row?.id,
      expectedRevision: row?.revision,
      name,
      subsidiaryId,
      managerEmployeeId: manager || null,
      defaultEmployeeId: employeeId || null,
      salesTeamId: teamId || null,
      description,
      priority,
      rules,
      matchMode,
      geography,
      effectiveFrom: effective,
      lifecycle,
      previewRevision: preview?.revision,
    };
  }
  function requestBody(command: SalesCommand) {
    if (command.action !== "territory") return JSON.stringify(command);
    // Published geometry is resolved by the server from its versioned selector.
    // Sending selectors keeps multi-country requests bounded and prevents edits
    // to a publisher's boundary from changing authoritative coverage.
    const selector = ({
      geometry: _geometry,
      ...area
    }: (typeof command.geography.includes)[number]) => area;
    return JSON.stringify({
      ...command,
      geography: {
        ...command.geography,
        includes: command.geography.includes.map(selector),
        excludes: command.geography.excludes.map(selector),
      },
    });
  }
  async function perform(command: SalesCommand) {
    setBusy(true);
    setError("");
    try {
      await apiJson(
        "/api/crm/sales",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody(command),
        },
        t("saveFailed"),
      );
      router.push(closeHref);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (data.page === "representatives") {
      // Newly selected employees have their concurrency token fetched from the
      // native scoped record endpoint, not inferred from a name or login.
      const revision = row?.updated_at ?? selectedRep?.updated_at;
      if (!revision) {
        setError(t("openEmployeeFirst"));
        return;
      }
      return perform({
        action: "representative",
        employeeId: repId,
        enabled,
        since,
        expectedRevision: revision,
      });
    }
    if (data.page === "teams")
      return perform({
        action: "team",
        id: row?.id,
        expectedRevision: row?.revision,
        name,
        subsidiaryId,
        managerEmployeeId: manager || null,
        isActive,
        members: members.map((m) => ({
          employeeId: m.employeeId,
          role: m.employeeId === manager ? "manager" : m.role,
          validFrom: m.validFrom,
        })),
      });
    if (data.page === "quotas")
      return perform({
        action: "quota",
        id: row?.id,
        expectedRevision: row?.revision,
        name,
        subsidiaryId,
        employeeId: employeeId || null,
        salesTeamId: teamId || null,
        parentQuotaId: parentId || null,
        supersedesId: supersedesId || null,
        reason,
        periodStart: start,
        periodEnd: end,
        currency,
        amount,
        metric,
      });
    return perform(territory());
  }
  async function review() {
    setBusy(true);
    setError("");
    try {
      setPreview(
        await apiJson<TerritoryPreview>(
          "/api/crm/sales/preview",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody(territory()),
          },
          t("previewFailed"),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t("previewFailed"));
    } finally {
      setBusy(false);
    }
  }
  function transition(
    next: "draft" | "pending_approval" | "approved" | "closed",
  ) {
    if (row)
      return perform({
        action: "quota-transition",
        id: row.id,
        expectedRevision: row.revision,
        lifecycle: next,
        reason,
      });
  }
  return (
    <UrlDrawer
      open
      openKey={row?.id ?? "new"}
      closeHref={closeHref}
      title={row?.name ?? t(`tabs.${data.page}`)}
      description={t("drawerDescription")}
      size={data.page === "territories" ? "2xl" : "lg"}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Link href={closeHref}>
            <Button variant="outline">{t("cancel")}</Button>
          </Link>
          {editable ? (
            <Button disabled={busy} onClick={save}>
              {busy ? t("saving") : t("save")}
            </Button>
          ) : null}
          {row && data.page === "quotas" && data.canManage ? (
            <>
              {row.lifecycle === "draft" ? (
                <Button
                  disabled={busy}
                  onClick={() => transition("pending_approval")}
                >
                  {t("submitApproval")}
                </Button>
              ) : null}
              {row.lifecycle === "pending_approval" ? (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => transition("draft")}
                  >
                    {t("returnDraft")}
                  </Button>
                  {data.canApprove ? (
                    <Button
                      disabled={busy}
                      onClick={() => transition("approved")}
                    >
                      {t("approve")}
                    </Button>
                  ) : null}
                </>
              ) : null}
              {row.lifecycle === "approved" ? (
                <>
                  <Link href={`/crm/sales/quotas?row=new&revises=${row.id}`}>
                    <Button variant="outline">{t("reviseQuota")}</Button>
                  </Link>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => transition("closed")}
                  >
                    {t("closeQuota")}
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      }
    >
      <div className="space-y-5">
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            {error}
          </div>
        ) : null}
        {data.page === "representatives" ? (
          <>
            <Field label={t("employee")}>
              <Select
                value={repId}
                disabled={!!row || !editable}
                onChange={(e) => {
                  setRep(e.target.value);
                  router.push(
                    `/crm/sales/representatives?row=${e.target.value}`,
                  );
                }}
              >
                {options(data.employees)}
              </Select>
            </Field>
            <Link className="text-sm text-teal-700" href="/entities/employees">
              {t("manageEmployee")}
            </Link>
            <Field label={t("eligibility")}>
              <Select
                value={enabled ? "yes" : "no"}
                disabled={!editable}
                onChange={(e) => setEnabled(e.target.value === "yes")}
              >
                <option value="yes">{t("eligible")}</option>
                <option value="no">{t("notDesignated")}</option>
              </Select>
            </Field>
            <Field label={t("effectiveFrom")}>
              <Input
                type="date"
                value={since}
                disabled={!editable}
                onChange={(e) => setSince(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <fieldset disabled={!editable} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("name")}>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </Field>
                <Field label={t("legalEntity")}>
                  <Select
                    value={subsidiaryId}
                    onChange={(e) => setSubsidiary(e.target.value)}
                  >
                    {options(data.subsidiaries, false)}
                  </Select>
                </Field>
              </div>
              {data.page === "teams" ? (
                <>
                  <Field label={t("manager")}>
                    <Select
                      value={manager}
                      onChange={(e) => setManager(e.target.value)}
                    >
                      {options(reps)}
                    </Select>
                  </Field>
                  <Field label={t("status")}>
                    <Select
                      value={isActive ? "active" : "archived"}
                      onChange={(e) => setActive(e.target.value === "active")}
                    >
                      <option value="active">{t("active")}</option>
                      <option value="archived">{t("archived")}</option>
                    </Select>
                  </Field>
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold">{t("members")}</h3>
                    {members.map((m) => (
                      <div
                        key={m.employeeId}
                        className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
                      >
                        <span>
                          {data.employees.find((e) => e.id === m.employeeId)
                            ?.name ?? m.employeeId}{" "}
                          · {m.validFrom}
                        </span>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setMembers(
                              members.filter(
                                (v) => v.employeeId !== m.employeeId,
                              ),
                            )
                          }
                        >
                          {t("remove")}
                        </Button>
                      </div>
                    ))}
                    <div className="grid gap-2 sm:grid-cols-[1fr_10rem_auto]">
                      <Select
                        value={adding}
                        aria-label={t("employee")}
                        onChange={(e) => setAdding(e.target.value)}
                      >
                        {options(
                          reps.filter(
                            (e) => !members.some((m) => m.employeeId === e.id),
                          ),
                        )}
                      </Select>
                      <Input
                        type="date"
                        aria-label={t("effectiveFrom")}
                        value={memberDate}
                        onChange={(e) => setMemberDate(e.target.value)}
                      />
                      <Button
                        variant="outline"
                        disabled={!adding}
                        onClick={() => {
                          setMembers([
                            ...members,
                            {
                              employeeId: adding,
                              role: "member",
                              validFrom: memberDate,
                              validTo: null,
                            },
                          ]);
                          setAdding("");
                        }}
                      >
                        {t("add")}
                      </Button>
                    </div>
                  </div>
                </>
              ) : null}
              {data.page === "quotas" ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("representative")}>
                      <Select
                        value={employeeId}
                        onChange={(e) => {
                          setEmployee(e.target.value);
                          if (e.target.value) setTeam("");
                        }}
                      >
                        {options(reps)}
                      </Select>
                    </Field>
                    <Field label={t("team")}>
                      <Select
                        value={teamId}
                        onChange={(e) => {
                          setTeam(e.target.value);
                          if (e.target.value) setEmployee("");
                        }}
                      >
                        {options(
                          data.teams.filter(
                            (e) => e.subsidiary_id === subsidiaryId,
                          ),
                        )}
                      </Select>
                    </Field>
                    <Field label={t("from")}>
                      <Input
                        type="date"
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                      />
                    </Field>
                    <Field label={t("to")}>
                      <Input
                        type="date"
                        value={end}
                        onChange={(e) => setEnd(e.target.value)}
                      />
                    </Field>
                    <Field label={t("quota")}>
                      <Input
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                      />
                    </Field>
                    <Field label={t("currency")}>
                      <Select
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value)}
                      >
                        {data.currencies
                          .filter(
                            (c) =>
                              data.multiCurrency ||
                              c.code === data.baseCurrency,
                          )
                          .map((c) => (
                            <option key={c.code} value={c.code}>
                              {c.code} · {c.name}
                            </option>
                          ))}
                      </Select>
                    </Field>
                  </div>
                  <Field label={t("metric")}>
                    <Select
                      value={metric}
                      onChange={(e) =>
                        setMetric(e.target.value as typeof metric)
                      }
                    >
                      <option value="closed_won">{t("closed_won")}</option>
                      <option value="net_invoiced">{t("net_invoiced")}</option>
                    </Select>
                  </Field>
                  <Field label={t("parentQuota")}>
                    <Select
                      value={parentId}
                      onChange={(e) => setParent(e.target.value)}
                    >
                      {options(
                        data.quotaOptions.filter(
                          (q) =>
                            q.lifecycle === "draft" &&
                            q.sales_team_id &&
                            q.subsidiary_id === subsidiaryId &&
                            q.id !== row?.id,
                        ),
                      )}
                    </Select>
                  </Field>
                  <Field label={t("supersedes")}>
                    <Select
                      value={supersedesId}
                      onChange={(e) => setSupersedes(e.target.value)}
                    >
                      {options(
                        data.quotaOptions.filter(
                          (q) =>
                            q.lifecycle === "approved" &&
                            q.subsidiary_id === subsidiaryId,
                        ),
                      )}
                    </Select>
                  </Field>
                </>
              ) : null}
              {data.page === "territories" ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label={t("representative")}>
                      <Select
                        value={employeeId}
                        onChange={(e) => setEmployee(e.target.value)}
                      >
                        {options(reps)}
                      </Select>
                    </Field>
                    <Field label={t("manager")}>
                      <Select
                        value={manager}
                        onChange={(e) => setManager(e.target.value)}
                      >
                        {options(reps)}
                      </Select>
                    </Field>
                    <Field label={t("team")}>
                      <Select
                        value={teamId}
                        onChange={(e) => setTeam(e.target.value)}
                      >
                        {options(
                          data.teams.filter(
                            (e) => e.subsidiary_id === subsidiaryId,
                          ),
                        )}
                      </Select>
                    </Field>
                    <Field label={t("effectiveFrom")}>
                      <Input
                        type="date"
                        value={effective}
                        onChange={(e) => setEffective(e.target.value)}
                      />
                    </Field>
                    <Field label={t("priority")}>
                      <Input
                        type="number"
                        min="0"
                        value={priority}
                        onChange={(e) => setPriority(Number(e.target.value))}
                      />
                    </Field>
                    <Field label={t("status")}>
                      <Select
                        value={lifecycle}
                        onChange={(e) =>
                          setLifecycle(e.target.value as typeof lifecycle)
                        }
                      >
                        {["draft", "active", "archived"].map((v) => (
                          <option key={v} value={v}>
                            {t(v)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Field label={t("descriptionLabel")}>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </Field>
                  {data.mapEnabled ? (
                    <TerritoryMap
                      value={geography}
                      onChange={editable ? setGeography : undefined}
                      territories={source ? [source] : []}
                    />
                  ) : (
                    <Link
                      className="text-sm text-teal-700"
                      href="/admin/features"
                    >
                      {t("enableMap")}
                    </Link>
                  )}
                  <Field label={t("match")}>
                    <Select
                      value={matchMode}
                      onChange={(e) =>
                        setMatchMode(e.target.value as "all" | "any")
                      }
                    >
                      <option value="all">{t("allRules")}</option>
                      <option value="any">{t("anyRule")}</option>
                    </Select>
                  </Field>
                  <div className="space-y-2">
                    {rules.map((rule, i) => (
                      <div
                        key={i}
                        className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2"
                      >
                        <Select
                          aria-label={t("ruleField")}
                          value={rule.field}
                          onChange={(e) =>
                            setRules(
                              rules.map((r, j) =>
                                j === i
                                  ? {
                                      ...r,
                                      field: e.target
                                        .value as TerritoryRule["field"],
                                    }
                                  : r,
                              ),
                            )
                          }
                        >
                          {[
                            "country",
                            "region",
                            "industry",
                            "lifecycleStage",
                            "leadSourceId",
                            "annualRevenue",
                            "employeeCount",
                          ].map((f) => (
                            <option key={f} value={f}>
                              {t(f)}
                            </option>
                          ))}
                        </Select>
                        <Select
                          aria-label={t("ruleOperator")}
                          value={rule.operator}
                          onChange={(e) =>
                            setRules(
                              rules.map((r, j) =>
                                j === i
                                  ? {
                                      ...r,
                                      operator: e.target
                                        .value as TerritoryRule["operator"],
                                      value: e.target.value === "in" ? [] : "",
                                    }
                                  : r,
                              ),
                            )
                          }
                        >
                          {["equals", "in", "contains", "gte", "lte"].map(
                            (v) => (
                              <option key={v} value={v}>
                                {t(v)}
                              </option>
                            ),
                          )}
                        </Select>
                        <Input
                          aria-label={t("ruleValue")}
                          value={
                            Array.isArray(rule.value)
                              ? rule.value.join(",")
                              : String(rule.value)
                          }
                          onChange={(e) =>
                            setRules(
                              rules.map((r, j) =>
                                j === i
                                  ? {
                                      ...r,
                                      value:
                                        r.operator === "in"
                                          ? e.target.value
                                              .split(",")
                                              .map((v) => v.trim())
                                          : r.field === "employeeCount"
                                            ? Number(e.target.value)
                                            : e.target.value,
                                    }
                                  : r,
                              ),
                            )
                          }
                        />
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setRules(rules.filter((_, j) => i !== j))
                          }
                        >
                          {t("remove")}
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      onClick={() =>
                        setRules([
                          ...rules,
                          { field: "country", operator: "equals", value: "" },
                        ])
                      }
                    >
                      {t("addRule")}
                    </Button>
                  </div>
                  <Button variant="outline" disabled={busy} onClick={review}>
                    {t("preview")}
                  </Button>
                  {preview ? (
                    <div className="space-y-3 rounded-xl bg-slate-50 p-4 dark:bg-slate-950">
                      <p className="text-sm">
                        {t("previewCounts", {
                          matched: preview.matched,
                          changed: preview.changed,
                          conflicts: preview.conflicts,
                          missing: preview.missingLocations,
                        })}
                      </p>
                      <p className="text-xs text-slate-500">
                        {t("manualProtected")}
                      </p>
                      {preview.accounts.length > 50 ? (
                        <p className="text-xs text-muted-foreground">
                          {t("previewLimit", {
                            shown: 50,
                            total: preview.accounts.length,
                          })}
                        </p>
                      ) : null}
                      {preview.accounts.slice(0, 50).map((a) => (
                        <div
                          key={a.id}
                          className="flex flex-wrap items-center justify-between gap-2 border-t py-2 text-sm"
                        >
                          <Link href={`/entities/customers?row=${a.partyId}`}>
                            {a.name}
                          </Link>
                          <Badge>{t(a.status)}</Badge>
                          {a.status === "missing_location" && a.addressId ? (
                            <LocationVerification
                              addressId={a.addressId}
                              revision={a.addressRevision!}
                              onSaved={() => setPreview(null)}
                            />
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}
            </fieldset>
          </>
        )}
        {data.page === "quotas" ? (
          <Field label={t("reason")}>
            <Textarea
              value={reason}
              disabled={!data.canManage}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        ) : null}
      </div>
    </UrlDrawer>
  );
}
function LocationVerification({
  addressId,
  revision,
  onSaved,
}: {
  addressId: string;
  revision: string;
  onSaved: () => void;
}) {
  const t = useTranslations("crm.sales");
  const [longitude, setLongitude] = useState("");
  const [latitude, setLatitude] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await apiJson(
        `/api/crm/sales/locations/${addressId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            longitude: Number(longitude),
            latitude: Number(latitude),
            expectedRevision: revision,
            reason,
          }),
        },
        t("saveFailed"),
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="w-full space-y-2">
      {error ? (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-3">
        <Input
          aria-label={t("longitude")}
          placeholder={t("longitude")}
          value={longitude}
          onChange={(e) => setLongitude(e.target.value)}
        />
        <Input
          aria-label={t("latitude")}
          placeholder={t("latitude")}
          value={latitude}
          onChange={(e) => setLatitude(e.target.value)}
        />
        <Input
          aria-label={t("reason")}
          placeholder={t("reason")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <Button
        disabled={
          busy || !longitude.trim() || !latitude.trim() || !reason.trim()
        }
        variant="outline"
        onClick={save}
      >
        {t("verifyLocation")}
      </Button>
    </div>
  );
}
