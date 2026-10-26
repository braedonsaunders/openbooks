"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button, Drawer, Input, Label, SearchSelect, Select } from "@openbooks/ui";
import { ApiResponseError, apiJson } from "../../../../lib/api-error";
import {
  FLOW_SUBJECT_LABEL_NAMESPACE,
  flowSubjectRefusedFeature,
  flowSubjectPickerOptions,
} from "../../../../lib/flows/subject-labels";

/**
 * One-step approval setup: "Require approval" wherever a record kind can be
 * governed by a flow. One dialog — subject, optional threshold, approver —
 * creating a complete, wired, ENABLED flow through POST
 * /api/admin/flows/quick-approval (the native lint + audited write). When
 * the setup already exists for the subject the dialog shows it and offers
 * removal, which disables the flow (history kept), never deletes it.
 *
 * The Flows list header mounts this next to New Flow; record-kind settings
 * deep-link it with ?quickApproval=<subjectKind>.
 */

type ProfileOption = { subjectKind: string; labelKey?: string; group?: string };

type QuickState = {
  flow: {
    id: string;
    name: string;
    enabled: boolean;
    updatedAt: string;
    subsidiaryIds?: string[];
  } | null;
  users: { id: string; name: string; email: string }[];
  roles: { key: string; name: string }[];
  subsidiaries: { id: string; name: string }[];
  amountField: string | null;
  subjectLabel: string;
};

const ERROR_CODES = ["bad-threshold", "no-amount-field", "unknown-role", "unknown-user"] as const;

export function QuickApprovalButton() {
  const t = useTranslations("admin.flows");
  const tSubjects = useTranslations(FLOW_SUBJECT_LABEL_NAMESPACE);
  const tFeatures = useTranslations("admin.features");
  // Existing catalog labels, reused so every locale renders them: the
  // legal-entity name and the organization-wide option.
  const tLegalEntity = useTranslations("accounting.provisions");
  const tAllEntities = useTranslations("crm.sales");
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [subjectKind, setSubjectKind] = useState("");
  const [profiles, setProfiles] = useState<ProfileOption[] | null>(null);
  const [state, setState] = useState<QuickState | null>(null);
  const [loading, setLoading] = useState(false);
  const [threshold, setThreshold] = useState("");
  const [subsidiaryId, setSubsidiaryId] = useState("");
  const [approverKind, setApproverKind] = useState<"role" | "user">("role");
  const [approver, setApprover] = useState("");
  const [preventSelfApproval, setPreventSelfApproval] = useState(true);
  const [busy, setBusy] = useState(false);
  const [autoSubject, setAutoSubject] = useState<string | null>(null);
  const currentSubject = useRef(subjectKind);
  useLayoutEffect(() => {
    currentSubject.current = subjectKind;
  }, [subjectKind]);

  useEffect(() => {
    if (profiles !== null) return;
    fetch("/api/admin/flows/profiles")
      .then((r) => (r.ok ? r.json() : { profiles: [] }))
      .then((d) =>
        setProfiles(
          (d.profiles ?? []).map((p: ProfileOption) => ({
            subjectKind: p.subjectKind,
            labelKey: p.labelKey,
            group: p.group,
          })),
        ),
      )
      .catch(() => setProfiles([]));
  }, [profiles]);

  // Offer the supported deep link once after the subject catalog arrives.
  const preset = params.get("quickApproval");
  if (
    autoSubject === null &&
    profiles !== null &&
    preset &&
    profiles.some((p) => p.subjectKind === preset)
  ) {
    setAutoSubject(preset);
    setOpen(true);
    setSubjectKind(preset);
    setLoading(true);
  }
  useEffect(() => {
    if (!autoSubject) return;
    const controller = new AbortController();
    fetch(`/api/admin/flows/quick-approval?subjectKind=${encodeURIComponent(autoSubject)}`, {
      signal: controller.signal,
    })
      .then(async (response) => (response.ok ? ((await response.json()) as QuickState) : null))
      .then((data) => {
        if (controller.signal.aborted || currentSubject.current !== autoSubject) return;
        setState(data);
        if (!data) return;
        setApproverKind("role");
        setApprover(
          data.roles.some((r) => r.key === "admin") ? "admin" : (data.roles[0]?.key ?? ""),
        );
        setThreshold("");
        setSubsidiaryId("");
        setPreventSelfApproval(true);
      })
      .catch(() => {
        if (!controller.signal.aborted && currentSubject.current === autoSubject) setState(null);
      })
      .finally(() => {
        if (!controller.signal.aborted && currentSubject.current === autoSubject) setLoading(false);
      });
    return () => controller.abort();
  }, [autoSubject]);

  async function loadState(kind: string) {
    setLoading(true);
    setState(null);
    try {
      const res = await fetch(
        `/api/admin/flows/quick-approval?subjectKind=${encodeURIComponent(kind)}`,
      );
      if (!res.ok) {
        setState(null);
        return;
      }
      const data = (await res.json()) as QuickState;
      setState(data);
      // Sensible single default: the org's admins (minus the submitter,
      // enforced by preventSelfApproval) — never a broadcast, never blank.
      const adminRole = data.roles.some((r) => r.key === "admin")
        ? "admin"
        : (data.roles[0]?.key ?? "");
      setApproverKind("role");
      setApprover(adminRole);
      setThreshold("");
      setSubsidiaryId("");
      setPreventSelfApproval(true);
    } finally {
      setLoading(false);
    }
  }

  function pickSubject(kind: string) {
    setSubjectKind(kind);
    if (kind) void loadState(kind);
    else setState(null);
  }

  function errorMessage(error: unknown, fallback: string): string {
    if (
      error instanceof ApiResponseError &&
      error.code &&
      (ERROR_CODES as readonly string[]).includes(error.code)
    ) {
      const key = `quick.errors.${error.code}` as const;
      if (t.has(key as never)) return t(key as never);
    }
    const feature = flowSubjectRefusedFeature(error, tFeatures);
    if (feature) return t("new.featureOff", { feature });
    return error instanceof ApiResponseError ? error.message : fallback;
  }

  async function create() {
    setBusy(true);
    try {
      const parsed = threshold.trim() === "" ? undefined : Number(threshold);
      const data = await apiJson<{ id: string }>(
        "/api/admin/flows/quick-approval",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subjectKind,
            ...(subsidiaryId !== "" ? { subsidiaryIds: [subsidiaryId] } : {}),
            ...(parsed !== undefined ? { threshold: parsed } : {}),
            approver:
              approverKind === "user"
                ? { type: "user", userId: approver }
                : { type: "role", role: approver },
            preventSelfApproval,
          }),
        },
        t("quick.failed"),
      );
      toast.success(t("quick.created"));
      setOpen(false);
      router.push(`/admin/flows/${data.id}`);
    } catch (error) {
      toast.error(errorMessage(error, t("quick.failed")));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!state?.flow) return;
    setBusy(true);
    try {
      await apiJson<unknown>(
        `/api/admin/flows/${state.flow.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false, expectedUpdatedAt: state.flow.updatedAt }),
        },
        t("quick.removeFailed"),
      );
      toast.success(t("quick.removed"));
      router.refresh();
      await loadState(subjectKind);
    } catch (error) {
      toast.error(error instanceof ApiResponseError ? error.message : t("quick.removeFailed"));
    } finally {
      setBusy(false);
    }
  }

  const options = flowSubjectPickerOptions(profiles ?? [], t, tSubjects);
  const canCreate =
    subjectKind !== "" &&
    state !== null &&
    state.flow === null &&
    approver !== "" &&
    !loading &&
    !busy;

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <ShieldCheck size={15} /> {t("quick.button")}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title={t("quick.title")}
        description={t("quick.description")}
        footer={
          <div className="flex w-full justify-end gap-2">
            {state?.flow ? (
              <Button
                variant="outline"
                disabled={busy || !state.flow.enabled}
                onClick={() => void remove()}
              >
                {t("quick.remove")}
              </Button>
            ) : (
              <Button disabled={!canCreate} onClick={() => void create()}>
                {t("quick.create")}
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("new.subject")}</Label>
            <SearchSelect
              value={subjectKind}
              options={options}
              placeholder={t("new.subjectPlaceholder")}
              loading={profiles === null}
              onChange={(value) => pickSubject(value)}
            />
          </div>
          {state?.flow ? (
            <div className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-700">
              <p className="text-sm text-slate-600 dark:text-slate-300">{t("quick.existing")}</p>
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {state.flow.name}
              </p>
              {state.flow.subsidiaryIds && state.flow.subsidiaryIds.length > 0 ? (
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  {tLegalEntity("subsidiary")}:{" "}
                  {state.flow.subsidiaryIds
                    .map((id) => state.subsidiaries?.find((s) => s.id === id)?.name ?? id)
                    .join(", ")}
                </p>
              ) : null}
              <Link
                href={`/admin/flows/${state.flow.id}`}
                className="inline-block text-sm font-medium text-teal-700 hover:underline dark:text-teal-300"
              >
                {t("quick.openFlow")}
              </Link>
            </div>
          ) : state !== null ? (
            <>
              {state.amountField ? (
                <div className="space-y-1.5">
                  <Label>{t("quick.threshold")}</Label>
                  <Input
                    inputMode="decimal"
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    placeholder={t("quick.thresholdPlaceholder")}
                  />
                </div>
              ) : (
                <p className="rounded-md border border-dashed border-slate-200 p-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  {t("quick.noAmount")}
                </p>
              )}
              {(state.subsidiaries?.length ?? 0) > 0 ? (
                <div className="space-y-1.5">
                  <Label>{tLegalEntity("subsidiary")}</Label>
                  <Select value={subsidiaryId} onChange={(e) => setSubsidiaryId(e.target.value)}>
                    <option value="">{tAllEntities("allEntities")}</option>
                    {state.subsidiaries.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label>{t("quick.approver")}</Label>
                <Select
                  value={approverKind}
                  onChange={(e) => setApproverKind(e.target.value === "user" ? "user" : "role")}
                >
                  <option value="role">{t("targets.types.role")}</option>
                  <option value="user">{t("targets.types.user")}</option>
                </Select>
                {approverKind === "role" ? (
                  <Select value={approver} onChange={(e) => setApprover(e.target.value)}>
                    <option value="">{t("targets.pickRole")}</option>
                    {state.roles.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <SearchSelect
                    value={approver}
                    options={state.users.map((u) => ({
                      value: u.id,
                      label: u.name,
                      hint: u.email,
                    }))}
                    placeholder={t("targets.pickUser")}
                    onChange={(value) => setApprover(value)}
                  />
                )}
              </div>
              <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={preventSelfApproval}
                  onChange={(e) => setPreventSelfApproval(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                />
                <span>
                  <span className="block font-medium">{t("gate.preventSelfApproval")}</span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {t("gate.preventSelfApprovalHint")}
                  </span>
                </span>
              </label>
            </>
          ) : null}
        </div>
      </Drawer>
    </>
  );
}
