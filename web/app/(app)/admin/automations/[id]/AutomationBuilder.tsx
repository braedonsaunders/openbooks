"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Input,
  Label,
  PageHeader,
  SearchSelect,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@openbooks/ui";
import { ModuleHomeTabs } from "@/components/module-home/ui";
import { useDirtyClose } from "@/lib/use-dirty-close";
import { readApiErrorMessage } from "../../../../../lib/api-error";

/**
 * The automation recipe builder — the brief-sanctioned linear recipe mode.
 *
 * The flows builder is graph-based (nodes.tsx cards over TriggerData /
 * ActionData); the six automation trigger kinds and the changed_to /
 * contains / is_null condition ops have no vocabulary there, so the recipe
 * edits as three linear panels — Trigger, Who and When (rules + the
 * all/any condition tree), Actions (ordered) — over the same @openbooks/ui
 * primitives. No new graph node or card components: this is the recipe
 * mode, not a second builder. Every save PATCHes the recipe (version
 * bumps); res.ok is checked before any body is parsed.
 */

export type BuilderAutomation = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  version: number;
  trigger: Record<string, unknown>;
  rules: Record<string, unknown>;
  conditions: Record<string, unknown>;
  actions: Record<string, unknown>[];
  errorMessage: string | null;
};

export type BuilderRun = {
  id: string;
  status: string;
  version: number;
  subjectKind: string | null;
  createdAt: string;
};

const TRIGGER_KINDS = [
  "schedule",
  "date_relative",
  "field_change",
  "event",
  "document",
  "manual",
] as const;
// field_change, event and document are not offered: no production writer
// stages their events, so enabling a recipe on one is refused by the API —
// offering them would report success for work that never happened.
const UNAVAILABLE_TRIGGER_KINDS = ["field_change", "event", "document"] as const;
// delay, approve_step and start_flow are not offered: none has real
// execution semantics (no continuation store, no gate minting, no flow
// dispatch), so offering them would report success for work that never
// happened. The API refuses them at publish with the remedy named; stored
// legacy rows still render as JSON below. webhook IS offered: it delivers
// through the signed outbound webhook transport to the subscriber endpoint
// named by the action's endpointKey (Settings → Developers → Webhooks).
const ACTION_KINDS = [
  "create_task",
  "send_email",
  "send_notification",
  "start_process",
  "update_field",
  "webhook",
] as const;
const CONDITION_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
  "is_null",
  "changed_to",
] as const;
type AutomationActionKind = (typeof ACTION_KINDS)[number];

function newAction(
  kind: AutomationActionKind,
  firstProcessTemplateId = "",
): Record<string, unknown> {
  switch (kind) {
    case "create_task":
      return { kind, ownerKind: "manager", title: "", dueOffsetDays: 0 };
    case "send_email":
      return { kind, templateKey: "automation_notice", to: "initiator" };
    case "send_notification":
      return { kind, to: "initiator", body: "" };
    case "start_process":
      return { kind, templateId: firstProcessTemplateId };
    case "update_field":
      return { kind, entity: "", field: "", value: "" };
    case "webhook":
      return { kind, endpointKey: "" };
  }
}

type ConditionLeaf = { field: string; op: string; value: string };

function toLeaves(conditions: Record<string, unknown>): {
  mode: "all" | "any";
  leaves: ConditionLeaf[];
} {
  const root = conditions.root as { all?: unknown[]; any?: unknown[] } | undefined;
  const list = Array.isArray(root?.all) ? root.all : Array.isArray(root?.any) ? root.any : [];
  const mode = Array.isArray(root?.any) ? "any" : "all";
  const leaves = (list as Record<string, unknown>[])
    .filter((n) => typeof n.field === "string")
    .map((n) => ({
      field: String(n.field),
      op: typeof n.op === "string" ? n.op : "eq",
      value:
        n.value === undefined || n.value === null
          ? ""
          : typeof n.value === "string"
            ? n.value
            : JSON.stringify(n.value),
    }));
  return { mode, leaves };
}

function fromLeaves(mode: "all" | "any", leaves: ConditionLeaf[]): Record<string, unknown> {
  if (leaves.length === 0) return {};
  const nodes = leaves
    .filter((l) => l.field.trim())
    .map((l) => {
      let value: unknown = l.value;
      if (l.value !== "") {
        try {
          value = JSON.parse(l.value);
        } catch {
          value = l.value;
        }
      }
      return { field: l.field.trim(), op: l.op, ...(l.op === "is_null" ? {} : { value }) };
    });
  return { root: { [mode]: nodes } };
}

export function AutomationBuilder({
  automation,
  runs,
  scopeOptions,
  canSimulate,
  canManage,
  saveFailed,
  backHref,
  backLabel,
}: {
  automation: BuilderAutomation;
  runs: BuilderRun[];
  scopeOptions: {
    subsidiaries: { value: string; label: string }[];
    departments: { value: string; label: string }[];
    locations: { value: string; label: string }[];
    positions: { value: string; label: string }[];
    users: { value: string; label: string; hint: string }[];
    roles: { value: string; label: string }[];
    processTemplates: { value: string; label: string; kind: string }[];
  };
  canSimulate: boolean;
  canManage: boolean;
  saveFailed: string;
  backHref: string;
  backLabel: string;
}) {
  const t = useTranslations("admin.automations");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [name, setName] = useState(automation.name);
  const [version, setVersion] = useState(automation.version);
  const [trigger, setTrigger] = useState<Record<string, unknown>>({ ...automation.trigger });
  // Per-kind trigger config: replacing the whole trigger on a kind switch
  // discarded everything typed for the previous kind (a schedule cron did
  // not survive a round-trip through manual). The cache stashes each kind's
  // fields as it is left and restores them on return; a kind never visited
  // starts clean. Only the current kind's fields ever save.
  const triggerCache = useRef<Record<string, Record<string, unknown>>>({
    [String(automation.trigger.kind ?? "manual")]: { ...automation.trigger },
  });

  function setTriggerKind(nextKind: string) {
    setTrigger((prev) => {
      const prevKind = String(prev.kind ?? "manual");
      triggerCache.current[prevKind] = { ...prev };
      const cached = triggerCache.current[nextKind];
      return cached ? { ...cached, kind: nextKind } : { kind: nextKind };
    });
  }
  const [rules, setRules] = useState<Record<string, unknown>>({ ...(automation.rules ?? {}) });
  const cond = toLeaves((automation.conditions ?? {}) as Record<string, unknown>);
  const [condMode, setCondMode] = useState<"all" | "any">(cond.mode);
  const [leaves, setLeaves] = useState<ConditionLeaf[]>(cond.leaves);
  const [actions, setActions] = useState<Record<string, unknown>[]>([...automation.actions]);
  const [valueDrafts, setValueDrafts] = useState<Record<number, string>>({});
  const [valueErrors, setValueErrors] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const tab = searchParams.get("tab") === "runs" ? "runs" : "build";
  const [simSubject, setSimSubject] = useState("");
  const [simSteps, setSimSteps] = useState<
    { index: number; kind: string; status: string; output?: string; error?: string }[] | null
  >(null);
  // A refused save names what happened and offers the way back. Local edits
  // stay until the editor chooses Reload, which re-seeds from the loader
  // (the WeeklyGrid stale-revision arrangement).
  const [conflict, setConflict] = useState<string | null>(null);
  const seededVersion = useRef(automation.version);
  useEffect(() => {
    if (seededVersion.current === automation.version) return;
    seededVersion.current = automation.version;
    setName(automation.name);
    setTrigger({ ...automation.trigger });
    triggerCache.current = {
      [String(automation.trigger.kind ?? "manual")]: { ...automation.trigger },
    };
    setRules({ ...(automation.rules ?? {}) });
    const reseeded = toLeaves((automation.conditions ?? {}) as Record<string, unknown>);
    setCondMode(reseeded.mode);
    setLeaves(reseeded.leaves);
    setActions([...automation.actions]);
    setValueDrafts({});
    setValueErrors({});
    setVersion(automation.version);
    setConflict(null);
  }, [automation]);

  const kind = String(trigger.kind ?? "manual");
  // Readers (automations.read without automations.manage) see the whole
  // recipe but change nothing: every input below takes disabled={ro} and
  // every mutating button renders only for managers. Simulate stays: its
  // API is read-guarded, so running it changes no stored state.
  const ro = !canManage;

  const serializedConditions = fromLeaves(condMode, leaves);
  const dirty =
    name !== automation.name ||
    JSON.stringify(trigger) !== JSON.stringify(automation.trigger) ||
    JSON.stringify(rules) !== JSON.stringify(automation.rules ?? {}) ||
    JSON.stringify(serializedConditions) !== JSON.stringify(automation.conditions ?? {}) ||
    JSON.stringify(actions) !== JSON.stringify(automation.actions) ||
    Object.keys(valueDrafts).length > 0;
  const closeGuard = useDirtyClose({
    dirty,
    busy,
    onClose: () => router.push(backHref),
    message: tCommon("feedback.unsavedChanges"),
    confirmLabel: tCommon("confirm.discardChanges"),
  });

  function handleBack(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    void closeGuard.close();
  }

  async function patch(body: Record<string, unknown>, success: string) {
    setBusy(true);
    setConflict(null);
    try {
      const res = await fetch(`/api/automations/${automation.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, expectedVersion: version }),
      });
      if (res.status === 409) {
        // Another editor saved first: nothing was written. Park the named
        // refusal as a notice with a Reload path and keep the local edits
        // until the editor reloads.
        const message = await readApiErrorMessage(res, saveFailed);
        setConflict(message);
        toast.error(message);
        return;
      }
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, saveFailed));
        return;
      }
      const payload = (await res.json().catch(() => ({}))) as {
        automation?: { version?: unknown };
      };
      if (typeof payload.automation?.version === "number") setVersion(payload.automation.version);
      toast.success(success);
      router.refresh();
    } catch {
      toast.error(saveFailed);
    } finally {
      setBusy(false);
    }
  }

  function setTriggerField(key: string, value: string) {
    setTrigger((prev) => ({ ...prev, [key]: value }));
  }

  function setRuleField(key: string, value: string) {
    setRules((prev) => ({ ...prev, [key]: value === "" ? null : value }));
  }

  function updateLeaf(index: number, patchLeaf: Partial<ConditionLeaf>) {
    setLeaves((prev) => prev.map((l, i) => (i === index ? { ...l, ...patchLeaf } : l)));
  }

  function updateAction(index: number, patchAction: Record<string, unknown>) {
    setActions((prev) =>
      prev.map((action, i) => (i === index ? { ...action, ...patchAction } : action)),
    );
  }

  function changeActionKind(index: number, kind: string) {
    if (!(ACTION_KINDS as readonly string[]).includes(kind)) return;
    setActions((prev) =>
      prev.map((action, i) =>
        i === index
          ? newAction(kind as AutomationActionKind, scopeOptions.processTemplates[0]?.value ?? "")
          : action,
      ),
    );
    setValueDrafts((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    setValueErrors((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }

  function recipientOptions(
    selected = "",
  ): { value: string; label: string; hint?: string; disabled?: boolean }[] {
    const options: { value: string; label: string; hint?: string; disabled?: boolean }[] = [
      { value: "initiator", label: t("builder.recipientInitiator") },
      { value: "manager", label: t("builder.recipientManager") },
      ...scopeOptions.roles.map((role) => ({
        value: `role:${role.value}`,
        label: t("builder.recipientRole", { role: role.label }),
      })),
      ...scopeOptions.users.map((user) => ({
        value: user.value,
        label: user.label,
        hint: user.hint,
      })),
    ];
    if (selected && !options.some((option) => option.value === selected)) {
      options.push({
        value: selected,
        label: t("builder.recipientUnavailable"),
        hint: selected,
        disabled: true,
      });
    }
    return options;
  }

  function actionIsValid(action: Record<string, unknown>): boolean {
    const textValue = (key: string) =>
      typeof action[key] === "string" && (action[key] as string).length > 0;
    switch (action.kind) {
      case "send_email":
        return textValue("to") && textValue("templateKey");
      case "send_notification":
        return textValue("to") && textValue("body");
      case "create_task": {
        const ownerKind = action.ownerKind;
        return (
          textValue("title") &&
          ["role", "person", "manager", "initiator"].includes(String(ownerKind)) &&
          (!["role", "person"].includes(String(ownerKind)) || textValue("owner")) &&
          Number.isSafeInteger(action.dueOffsetDays) &&
          Number(action.dueOffsetDays) >= 0
        );
      }
      case "start_process":
        return textValue("templateId");
      case "update_field":
        return textValue("entity") && textValue("field");
      case "webhook":
        return textValue("endpointKey");
      default:
        return false;
    }
  }

  function setActionField(index: number, key: string, value: string) {
    updateAction(index, { [key]: value });
  }

  function moveAction(index: number, delta: -1 | 1) {
    const next = [...actions];
    const j = index + delta;
    if (j < 0 || j >= next.length) return;
    const tmp = next[index]!;
    next[index] = next[j]!;
    next[j] = tmp;
    setActions(next);
    const reorder = <T,>(items: Record<number, T>) => {
      const result = { ...items };
      const left = result[index];
      const right = result[j];
      if (right === undefined) delete result[index];
      else result[index] = right;
      if (left === undefined) delete result[j];
      else result[j] = left;
      return result;
    };
    setValueDrafts(reorder);
    setValueErrors(reorder);
  }

  function removeAction(index: number) {
    setActions((prev) => prev.filter((_, i) => i !== index));
    const shift = <T,>(items: Record<number, T>) =>
      Object.fromEntries(
        Object.entries(items).flatMap(([key, value]) => {
          const current = Number(key);
          if (current === index) return [];
          return [[current > index ? current - 1 : current, value]];
        }),
      ) as Record<number, T>;
    setValueDrafts(shift);
    setValueErrors(shift);
  }

  function changeValueType(index: number, valueType: string) {
    const value =
      valueType === "number"
        ? 0
        : valueType === "boolean"
          ? false
          : valueType === "json"
            ? null
            : "";
    updateAction(index, { value });
    setValueDrafts((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    setValueErrors((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  }

  function commitValueDraft(index: number, valueType: string, draft: string) {
    try {
      const value =
        valueType === "number" ? Number(draft) : valueType === "json" ? JSON.parse(draft) : draft;
      if (valueType === "number" && (!draft.trim() || !Number.isFinite(value)))
        throw new Error("invalid number");
      updateAction(index, { value });
      setValueDrafts((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      setValueErrors((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
    } catch {
      setValueErrors((prev) => ({ ...prev, [index]: true }));
    }
  }

  async function simulate() {
    setBusy(true);
    setSimSteps(null);
    try {
      const [entity, id] = simSubject.includes(":")
        ? (simSubject.split(":", 2) as [string, string])
        : [simSubject || undefined, undefined];
      const res = await fetch(`/api/automations/${automation.id}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(entity ? { subjectEntity: entity } : {}),
          ...(id ? { subjectId: id } : {}),
        }),
      });
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, saveFailed));
        return;
      }
      const payload = (await res.json().catch(() => ({}))) as {
        simulations?: {
          steps?: {
            index: number;
            kind: string;
            status: string;
            output?: string;
            error?: string;
          }[];
        }[];
      };
      setSimSteps(payload.simulations?.[0]?.steps ?? []);
    } catch {
      toast.error(saveFailed);
    } finally {
      setBusy(false);
    }
  }

  const saveRecipe = () =>
    patch(
      {
        name,
        trigger,
        rules,
        conditions: serializedConditions,
        actions,
      },
      t("builder.saved"),
    );

  const unsupportedAction = actions.some(
    (action) => !(ACTION_KINDS as readonly string[]).includes(String(action.kind ?? "")),
  );
  const invalidActions =
    actions.length === 0 ||
    actions.some((action) => !actionIsValid(action)) ||
    Object.values(valueErrors).some(Boolean);
  const actionKindLabel = (value: string) =>
    (ACTION_KINDS as readonly string[]).includes(value)
      ? t(`builder.actionKinds.${value}`)
      : t("builder.otherStep");
  const runStatusLabel = (value: string) =>
    ["succeeded", "failed", "simulated", "skipped", "running", "queued"].includes(value)
      ? t(`builder.runStatuses.${value}`)
      : t("builder.otherStatus");
  const tabs = [
    { href: `${pathname}?tab=build`, label: t("builder.buildTab"), active: tab === "build" },
    { href: `${pathname}?tab=runs`, label: t("builder.runsTab"), active: tab === "runs" },
  ];

  return (
    <div className="grid gap-4">
      <PageHeader
        title={name}
        description={t("builder.description")}
        titleContent={
          <span className="flex flex-wrap items-center gap-2">
            {name}
            <Badge
              variant={
                automation.status === "enabled"
                  ? "success"
                  : automation.status === "error"
                    ? "destructive"
                    : "secondary"
              }
            >
              {t(`status.${automation.status}`)}
            </Badge>
            <span className="text-xs font-normal text-slate-500 tabular-nums">v{version}</span>
          </span>
        }
        back={{ href: backHref, label: backLabel, onClick: handleBack }}
        actions={
          canManage ? (
            <Button
              disabled={busy || !dirty || invalidActions || unsupportedAction}
              onClick={() => void saveRecipe()}
            >
              {tCommon("actions.save")}
            </Button>
          ) : null
        }
      />
      {conflict ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
          role="alert"
        >
          <span className="min-w-52 flex-1">{conflict}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (await closeGuard.beforeClose()) router.refresh();
            }}
          >
            {tCommon("actions.refresh")}
          </Button>
        </div>
      ) : null}
      {automation.errorMessage ? (
        <p className="text-sm text-red-600 dark:text-red-400">{automation.errorMessage}</p>
      ) : null}
      {canManage ? null : (
        <p className="text-sm text-slate-600 dark:text-slate-300">{t("builder.readOnlyNotice")}</p>
      )}
      <ModuleHomeTabs tabs={tabs} placement="local" ariaLabel={t("builder.tabsAria")} />

      {tab === "build" ? (
        <>
          <section className="rounded-lg border bg-white p-4 dark:bg-slate-900">
            <h2 className="text-sm font-semibold">{t("builder.nameTitle")}</h2>
            <div className="mt-2 grid gap-2">
              <Label htmlFor="ab-name">{t("list.nameLabel")}</Label>
              <Input
                id="ab-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={ro}
              />
            </div>
          </section>

          <section className="rounded-lg border bg-white p-4 dark:bg-slate-900">
            <h2 className="text-sm font-semibold">{t("builder.triggerTitle")}</h2>
            <div className="mt-2 grid gap-2">
              <Label htmlFor="ab-trigger-kind">{t("list.triggerLabel")}</Label>
              <Select
                id="ab-trigger-kind"
                value={kind}
                onChange={(e) => setTriggerKind(e.target.value)}
                disabled={ro}
              >
                {TRIGGER_KINDS.map((k) => {
                  const unavailable = (UNAVAILABLE_TRIGGER_KINDS as readonly string[]).includes(k);
                  return (
                    <option key={k} value={k} disabled={unavailable}>
                      {t(`triggerKinds.${k}`)}
                      {unavailable ? ` (${t("triggerKindUnavailable")})` : ""}
                    </option>
                  );
                })}
              </Select>
              {(UNAVAILABLE_TRIGGER_KINDS as readonly string[]).includes(kind) ? (
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  {t("triggerKindUnavailableNote")}
                </p>
              ) : null}
              {kind === "schedule" ? (
                <>
                  <Label htmlFor="ab-cron">{t("builder.cronLabel")}</Label>
                  <Input
                    id="ab-cron"
                    value={String(trigger.cron ?? "")}
                    onChange={(e) => setTriggerField("cron", e.target.value)}
                    placeholder="0 9 * * MON"
                    disabled={ro}
                  />
                  <Label htmlFor="ab-tz">{t("builder.timezoneLabel")}</Label>
                  <Input
                    id="ab-tz"
                    value={String(trigger.timezone ?? "UTC")}
                    onChange={(e) => setTriggerField("timezone", e.target.value)}
                    disabled={ro}
                  />
                </>
              ) : null}
              {kind === "date_relative" ? (
                <>
                  <Label htmlFor="ab-entity">{t("builder.entityLabel")}</Label>
                  <Input
                    id="ab-entity"
                    value={String(trigger.entity ?? "")}
                    onChange={(e) => setTriggerField("entity", e.target.value)}
                    disabled={ro}
                  />
                  <Label htmlFor="ab-datefield">{t("builder.dateFieldLabel")}</Label>
                  <Input
                    id="ab-datefield"
                    value={String(trigger.dateField ?? "")}
                    onChange={(e) => setTriggerField("dateField", e.target.value)}
                    disabled={ro}
                  />
                  <Label htmlFor="ab-offset">{t("builder.offsetLabel")}</Label>
                  <Input
                    id="ab-offset"
                    value={String(trigger.offsetDays ?? 0)}
                    onChange={(e) => setTriggerField("offsetDays", e.target.value)}
                    disabled={ro}
                  />
                  <Label htmlFor="ab-direction">{t("builder.directionLabel")}</Label>
                  <Select
                    id="ab-direction"
                    value={String(trigger.direction ?? "before")}
                    onChange={(e) => setTriggerField("direction", e.target.value)}
                    disabled={ro}
                  >
                    <option value="before">{t("builder.before")}</option>
                    <option value="after">{t("builder.after")}</option>
                  </Select>
                  <Label htmlFor="ab-attime">{t("builder.atTimeLabel")}</Label>
                  <Input
                    id="ab-attime"
                    value={String(trigger.atTime ?? "09:00")}
                    onChange={(e) => setTriggerField("atTime", e.target.value)}
                    placeholder="09:00"
                    disabled={ro}
                  />
                </>
              ) : null}
              {kind === "field_change" ? (
                <>
                  <Label htmlFor="ab-fc-entity">{t("builder.entityLabel")}</Label>
                  <Input
                    id="ab-fc-entity"
                    value={String(trigger.entity ?? "")}
                    onChange={(e) => setTriggerField("entity", e.target.value)}
                    disabled={ro}
                  />
                  <Label htmlFor="ab-fc-field">{t("builder.fieldLabel")}</Label>
                  <Input
                    id="ab-fc-field"
                    value={String(trigger.field ?? "")}
                    onChange={(e) => setTriggerField("field", e.target.value)}
                    disabled={ro}
                  />
                  <Label htmlFor="ab-fc-to">{t("builder.changedToLabel")}</Label>
                  <Input
                    id="ab-fc-to"
                    value={String(trigger.to ?? "")}
                    onChange={(e) => setTriggerField("to", e.target.value)}
                    disabled={ro}
                  />
                </>
              ) : null}
              {kind === "event" ? (
                <>
                  <Label htmlFor="ab-ev-subject">{t("builder.subjectKindLabel")}</Label>
                  <Input
                    id="ab-ev-subject"
                    value={String(trigger.subjectKind ?? "")}
                    onChange={(e) => setTriggerField("subjectKind", e.target.value)}
                    disabled={ro}
                  />
                  <Label htmlFor="ab-ev-kind">{t("builder.eventKindLabel")}</Label>
                  <Input
                    id="ab-ev-kind"
                    value={String(trigger.eventKind ?? "")}
                    onChange={(e) => setTriggerField("eventKind", e.target.value)}
                    disabled={ro}
                  />
                </>
              ) : null}
              {kind === "document" ? (
                <>
                  <Label htmlFor="ab-doc-event">{t("builder.eventKindLabel")}</Label>
                  <Select
                    id="ab-doc-event"
                    value={String(trigger.event ?? "signed")}
                    onChange={(e) => setTriggerField("event", e.target.value)}
                    disabled={ro}
                  >
                    <option value="uploaded">{t("builder.documentUploaded")}</option>
                    <option value="signed">{t("builder.documentSigned")}</option>
                    <option value="created_from_template">{t("builder.documentTemplated")}</option>
                  </Select>
                </>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg border bg-white p-4 dark:bg-slate-900">
            <h2 className="text-sm font-semibold">{t("builder.whoWhenTitle")}</h2>
            <p className="mt-1 text-xs text-slate-500">{t("builder.whoWhenHelp")}</p>
            <div className="mt-2 grid gap-2">
              {(
                ["subsidiaryId", "departmentId", "locationId", "workerType", "positionId"] as const
              ).map((key) => {
                const optionSets = {
                  subsidiaryId: scopeOptions.subsidiaries,
                  departmentId: scopeOptions.departments,
                  locationId: scopeOptions.locations,
                  positionId: scopeOptions.positions,
                };
                const value = typeof rules[key] === "string" ? String(rules[key]) : "";
                return (
                  <div key={key} className="grid gap-1">
                    <Label htmlFor={`ab-rule-${key}`}>{t(`builder.rule_${key}`)}</Label>
                    {key === "workerType" ? (
                      <Input
                        id={`ab-rule-${key}`}
                        value={value}
                        onChange={(e) => setRuleField(key, e.target.value)}
                        placeholder={t("builder.ruleBlank")}
                        disabled={ro}
                      />
                    ) : (
                      <SearchSelect
                        id={`ab-rule-${key}`}
                        ariaLabelledBy={`ab-rule-${key}`}
                        value={value}
                        options={optionSets[key]}
                        onChange={(next) => setRuleField(key, next)}
                        placeholder={t("builder.ruleBlank")}
                        emptyLabel={t("builder.ruleBlank")}
                        clearable
                        disabled={ro}
                      />
                    )}
                  </div>
                );
              })}
              <div className="grid gap-1">
                <Label htmlFor="ab-cond-mode">{t("builder.conditionsMode")}</Label>
                <Select
                  id="ab-cond-mode"
                  value={condMode}
                  onChange={(e) => setCondMode(e.target.value as "all" | "any")}
                  disabled={ro}
                >
                  <option value="all">{t("builder.conditionsAll")}</option>
                  <option value="any">{t("builder.conditionsAny")}</option>
                </Select>
              </div>
              {leaves.map((leaf, i) => (
                <div key={i} className="grid grid-cols-[1fr_130px_1fr_auto] items-end gap-2">
                  <div className="grid gap-1">
                    <Label htmlFor={`ab-leaf-field-${i}`}>{t("builder.fieldLabel")}</Label>
                    <Input
                      id={`ab-leaf-field-${i}`}
                      value={leaf.field}
                      onChange={(e) => updateLeaf(i, { field: e.target.value })}
                      disabled={ro}
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`ab-leaf-op-${i}`}>{t("builder.opLabel")}</Label>
                    <Select
                      id={`ab-leaf-op-${i}`}
                      value={leaf.op}
                      onChange={(e) => updateLeaf(i, { op: e.target.value })}
                      disabled={ro}
                    >
                      {CONDITION_OPS.map((op) => (
                        <option key={op} value={op}>
                          {t(`builder.conditionOps.${op}`)}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={`ab-leaf-value-${i}`}>{t("builder.valueLabel")}</Label>
                    <Input
                      id={`ab-leaf-value-${i}`}
                      value={leaf.value}
                      onChange={(e) => updateLeaf(i, { value: e.target.value })}
                      disabled={leaf.op === "is_null" || ro}
                    />
                  </div>
                  {canManage ? (
                    <Button
                      variant="outline"
                      onClick={() => setLeaves((prev) => prev.filter((_, j) => j !== i))}
                    >
                      {t("builder.remove")}
                    </Button>
                  ) : null}
                </div>
              ))}
              {canManage ? (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() =>
                      setLeaves((prev) => [...prev, { field: "", op: "eq", value: "" }])
                    }
                  >
                    {t("builder.addCondition")}
                  </Button>
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg border bg-white p-4 dark:bg-slate-900">
            <h2 className="text-sm font-semibold">{t("builder.actionsTitle")}</h2>
            <div className="mt-2 grid gap-3">
              {actions.map((action, i) => {
                const actionKind = String(action.kind ?? "");
                const ownerKind = String(action.ownerKind ?? "manager");
                const selectedOwner = String(action.owner ?? "");
                const selectedRecipient = String(action.to ?? "");
                const selectedTemplate = String(action.templateKey ?? "");
                const selectedProcessTemplate = String(action.templateId ?? "");
                const kindSupported = (ACTION_KINDS as readonly string[]).includes(actionKind);
                const ownerOptions: {
                  value: string;
                  label: string;
                  hint?: string;
                  disabled?: boolean;
                }[] =
                  ownerKind === "role"
                    ? scopeOptions.roles.map((role) => ({ value: role.value, label: role.label }))
                    : scopeOptions.users;
                const processOptions: {
                  value: string;
                  label: string;
                  hint?: string;
                  disabled?: boolean;
                }[] = scopeOptions.processTemplates.map((item) => ({
                  value: item.value,
                  label: item.label,
                  hint: t(`builder.processTemplateKinds.${item.kind}`),
                }));
                if (
                  selectedOwner &&
                  !ownerOptions.some((option) => option.value === selectedOwner)
                ) {
                  ownerOptions.push({
                    value: selectedOwner,
                    label: t("builder.assigneeUnavailable"),
                    hint: selectedOwner,
                    disabled: true,
                  });
                }
                if (
                  selectedProcessTemplate &&
                  !processOptions.some((option) => option.value === selectedProcessTemplate)
                ) {
                  processOptions.push({
                    value: selectedProcessTemplate,
                    label: t("builder.processTemplateUnavailable"),
                    hint: selectedProcessTemplate,
                    disabled: true,
                  });
                }
                const emailTemplateOptions: { value: string; label: string; disabled?: boolean }[] =
                  [{ value: "automation_notice", label: t("builder.emailTemplateNotice") }];
                if (
                  selectedTemplate &&
                  !emailTemplateOptions.some((option) => option.value === selectedTemplate)
                ) {
                  emailTemplateOptions.push({
                    value: selectedTemplate,
                    label: t("builder.emailTemplateUnavailable"),
                    disabled: true,
                  });
                }
                return (
                  <div key={i} className="grid gap-2 rounded-md border p-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold tabular-nums">#{i + 1}</span>
                      <Select
                        aria-label={t("builder.actionKindLabel")}
                        value={actionKind}
                        onChange={(e) => changeActionKind(i, e.target.value)}
                        disabled={ro}
                      >
                        {!kindSupported ? (
                          <option value={actionKind}>
                            {t("builder.actionKindUnavailable", { kind: actionKind })}
                          </option>
                        ) : null}
                        {ACTION_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {t(`builder.actionKinds.${k}`)}
                          </option>
                        ))}
                      </Select>
                      {canManage ? (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            aria-label={t("builder.moveActionUp", { number: i + 1 })}
                            onClick={() => moveAction(i, -1)}
                          >
                            ↑
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            aria-label={t("builder.moveActionDown", { number: i + 1 })}
                            onClick={() => moveAction(i, 1)}
                          >
                            ↓
                          </Button>
                          <Button variant="outline" onClick={() => removeAction(i)}>
                            {t("builder.remove")}
                          </Button>
                        </>
                      ) : null}
                    </div>
                    {!kindSupported ? (
                      <p className="text-sm text-amber-700 dark:text-amber-300">
                        {t("builder.actionKindUnavailableNote")}
                      </p>
                    ) : null}
                    {actionKind === "send_email" ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="grid gap-1">
                          <Label htmlFor={`ab-action-to-${i}`}>
                            {t("builder.actionRecipientLabel")}
                          </Label>
                          <SearchSelect
                            id={`ab-action-to-${i}`}
                            ariaLabelledBy={`ab-action-to-${i}`}
                            value={selectedRecipient}
                            options={recipientOptions(selectedRecipient)}
                            onChange={(value) => setActionField(i, "to", value)}
                            placeholder={t("builder.chooseRecipient")}
                            disabled={ro}
                          />
                        </div>
                        <div className="grid gap-1">
                          <Label htmlFor={`ab-action-template-${i}`}>
                            {t("builder.emailTemplateLabel")}
                          </Label>
                          <SearchSelect
                            id={`ab-action-template-${i}`}
                            ariaLabelledBy={`ab-action-template-${i}`}
                            value={selectedTemplate}
                            options={emailTemplateOptions}
                            onChange={(value) => setActionField(i, "templateKey", value)}
                            placeholder={t("builder.chooseEmailTemplate")}
                            disabled={ro}
                          />
                        </div>
                      </div>
                    ) : null}
                    {actionKind === "send_notification" ? (
                      <div className="grid gap-2">
                        <div className="grid gap-1">
                          <Label htmlFor={`ab-action-to-${i}`}>
                            {t("builder.actionRecipientLabel")}
                          </Label>
                          <SearchSelect
                            id={`ab-action-to-${i}`}
                            ariaLabelledBy={`ab-action-to-${i}`}
                            value={selectedRecipient}
                            options={recipientOptions(selectedRecipient)}
                            onChange={(value) => setActionField(i, "to", value)}
                            placeholder={t("builder.chooseRecipient")}
                            disabled={ro}
                          />
                        </div>
                        <div className="grid gap-1">
                          <Label htmlFor={`ab-action-body-${i}`}>
                            {t("builder.notificationBodyLabel")}
                          </Label>
                          <Textarea
                            id={`ab-action-body-${i}`}
                            value={String(action.body ?? "")}
                            rows={3}
                            disabled={ro}
                            onChange={(e) => setActionField(i, "body", e.target.value)}
                          />
                        </div>
                      </div>
                    ) : null}
                    {actionKind === "create_task" ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="grid gap-1">
                          <Label htmlFor={`ab-action-owner-kind-${i}`}>
                            {t("builder.taskAssigneeKindLabel")}
                          </Label>
                          <Select
                            id={`ab-action-owner-kind-${i}`}
                            value={ownerKind}
                            disabled={ro}
                            onChange={(e) =>
                              updateAction(i, { ownerKind: e.target.value, owner: "" })
                            }
                          >
                            <option value="manager">{t("builder.recipientManager")}</option>
                            <option value="initiator">{t("builder.recipientInitiator")}</option>
                            <option value="person">{t("builder.assigneePerson")}</option>
                            <option value="role">{t("builder.assigneeRole")}</option>
                          </Select>
                        </div>
                        {ownerKind === "person" || ownerKind === "role" ? (
                          <div className="grid gap-1">
                            <Label htmlFor={`ab-action-owner-${i}`}>
                              {t("builder.taskAssigneeLabel")}
                            </Label>
                            <SearchSelect
                              id={`ab-action-owner-${i}`}
                              ariaLabelledBy={`ab-action-owner-${i}`}
                              value={selectedOwner}
                              options={ownerOptions}
                              onChange={(value) => setActionField(i, "owner", value)}
                              placeholder={t("builder.chooseAssignee")}
                              disabled={ro}
                            />
                          </div>
                        ) : null}
                        <div className="grid gap-1">
                          <Label htmlFor={`ab-action-title-${i}`}>
                            {t("builder.taskTitleLabel")}
                          </Label>
                          <Input
                            id={`ab-action-title-${i}`}
                            value={String(action.title ?? "")}
                            disabled={ro}
                            onChange={(e) => setActionField(i, "title", e.target.value)}
                          />
                        </div>
                        <div className="grid gap-1">
                          <Label htmlFor={`ab-action-due-${i}`}>
                            {t("builder.taskDueOffsetLabel")}
                          </Label>
                          <Input
                            id={`ab-action-due-${i}`}
                            type="number"
                            min="0"
                            step="1"
                            value={String(action.dueOffsetDays ?? 0)}
                            disabled={ro}
                            onChange={(e) =>
                              updateAction(i, {
                                dueOffsetDays: e.target.value === "" ? "" : Number(e.target.value),
                              })
                            }
                          />
                        </div>
                      </div>
                    ) : null}
                    {actionKind === "start_process" ? (
                      <div className="grid gap-1">
                        <Label htmlFor={`ab-action-process-${i}`}>
                          {t("builder.processTemplateLabel")}
                        </Label>
                        <SearchSelect
                          id={`ab-action-process-${i}`}
                          ariaLabelledBy={`ab-action-process-${i}`}
                          value={selectedProcessTemplate}
                          options={processOptions}
                          onChange={(value) => setActionField(i, "templateId", value)}
                          placeholder={t("builder.chooseProcessTemplate")}
                          disabled={ro || scopeOptions.processTemplates.length === 0}
                        />
                        <p className="text-xs text-slate-500">
                          {scopeOptions.processTemplates.length
                            ? t("builder.processTemplateAccessHelp")
                            : t("builder.processTemplateUnavailableHelp")}
                        </p>
                      </div>
                    ) : null}
                    {actionKind === "update_field" ? (
                      <div className="grid gap-2 sm:grid-cols-3">
                        <div className="grid gap-1">
                          <Label htmlFor={`ab-action-entity-${i}`}>
                            {t("builder.entityLabel")}
                          </Label>
                          <Input
                            id={`ab-action-entity-${i}`}
                            value={String(action.entity ?? "")}
                            disabled={ro}
                            onChange={(e) => setActionField(i, "entity", e.target.value)}
                          />
                        </div>
                        <div className="grid gap-1">
                          <Label htmlFor={`ab-action-field-${i}`}>{t("builder.fieldLabel")}</Label>
                          <Input
                            id={`ab-action-field-${i}`}
                            value={String(action.field ?? "")}
                            disabled={ro}
                            onChange={(e) => setActionField(i, "field", e.target.value)}
                          />
                        </div>
                        <div className="grid gap-1">
                          <Label htmlFor={`ab-action-value-type-${i}`}>
                            {t("builder.valueLabel")}
                          </Label>
                          {(() => {
                            const valueType =
                              typeof action.value === "number"
                                ? "number"
                                : typeof action.value === "boolean"
                                  ? "boolean"
                                  : typeof action.value === "string"
                                    ? "text"
                                    : "json";
                            const valueText =
                              valueDrafts[i] ??
                              (valueType === "json"
                                ? JSON.stringify(action.value ?? null, null, 2)
                                : String(action.value ?? ""));
                            return (
                              <>
                                <Select
                                  id={`ab-action-value-type-${i}`}
                                  value={valueType}
                                  disabled={ro}
                                  onChange={(e) => changeValueType(i, e.target.value)}
                                >
                                  <option value="text">{t("builder.valueTypes.text")}</option>
                                  <option value="number">{t("builder.valueTypes.number")}</option>
                                  <option value="boolean">{t("builder.valueTypes.boolean")}</option>
                                  <option value="json">{t("builder.valueTypes.json")}</option>
                                </Select>
                                {valueType === "boolean" ? (
                                  <Select
                                    id={`ab-action-value-${i}`}
                                    value={String(action.value)}
                                    disabled={ro}
                                    onChange={(e) =>
                                      updateAction(i, { value: e.target.value === "true" })
                                    }
                                  >
                                    <option value="true">{t("builder.valueTypes.true")}</option>
                                    <option value="false">{t("builder.valueTypes.false")}</option>
                                  </Select>
                                ) : valueType === "json" ? (
                                  <Textarea
                                    id={`ab-action-value-${i}`}
                                    value={valueText}
                                    rows={3}
                                    disabled={ro}
                                    aria-invalid={valueErrors[i] || undefined}
                                    onChange={(e) => {
                                      setValueDrafts((prev) => ({ ...prev, [i]: e.target.value }));
                                      setValueErrors((prev) => {
                                        const next = { ...prev };
                                        delete next[i];
                                        return next;
                                      });
                                    }}
                                    onBlur={(e) => commitValueDraft(i, valueType, e.target.value)}
                                  />
                                ) : (
                                  <Input
                                    id={`ab-action-value-${i}`}
                                    type={valueType === "number" ? "number" : "text"}
                                    step={valueType === "number" ? "any" : undefined}
                                    value={valueText}
                                    disabled={ro}
                                    aria-invalid={valueErrors[i] || undefined}
                                    onChange={(e) => {
                                      setValueDrafts((prev) => ({ ...prev, [i]: e.target.value }));
                                      setValueErrors((prev) => {
                                        const next = { ...prev };
                                        delete next[i];
                                        return next;
                                      });
                                    }}
                                    onBlur={(e) => commitValueDraft(i, valueType, e.target.value)}
                                  />
                                )}
                                {valueErrors[i] ? (
                                  <p className="text-xs text-red-600 dark:text-red-400">
                                    {t("builder.valueInvalid")}
                                  </p>
                                ) : null}
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    ) : null}
                    {actionKind === "webhook" ? (
                      <div className="grid gap-1">
                        <Label htmlFor={`ab-action-endpoint-${i}`}>
                          {t("builder.endpointKeyLabel")}
                        </Label>
                        <Input
                          id={`ab-action-endpoint-${i}`}
                          value={String(action.endpointKey ?? "")}
                          disabled={ro}
                          onChange={(e) => setActionField(i, "endpointKey", e.target.value)}
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {canManage ? (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setActions((prev) => [...prev, newAction("send_notification")])}
                  >
                    {t("builder.addAction")}
                  </Button>
                </div>
              ) : null}
            </div>
          </section>

          {canSimulate ? (
            <section className="rounded-lg border bg-white p-4 dark:bg-slate-900">
              <h2 className="text-sm font-semibold">{t("builder.simulateTitle")}</h2>
              <p className="mt-1 text-xs text-slate-500">{t("builder.simulateHelp")}</p>
              <div className="mt-2 grid gap-2">
                <Label htmlFor="ab-sim-subject">{t("builder.simulateSubjectLabel")}</Label>
                <Input
                  id="ab-sim-subject"
                  value={simSubject}
                  onChange={(e) => setSimSubject(e.target.value)}
                  placeholder={t("builder.simulateSubjectPlaceholder")}
                />
                <div>
                  <Button disabled={busy} onClick={simulate}>
                    {t("builder.simulateButton")}
                  </Button>
                </div>
                {simSteps ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>{t("builder.stepKind")}</TableHead>
                        <TableHead>{t("builder.stepStatus")}</TableHead>
                        <TableHead>{t("builder.stepDetail")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {simSteps.map((s) => (
                        <TableRow key={s.index}>
                          <TableCell className="tabular-nums">{s.index}</TableCell>
                          <TableCell>{actionKindLabel(s.kind)}</TableCell>
                          <TableCell>
                            <Badge variant="secondary">{runStatusLabel(s.status)}</Badge>
                          </TableCell>
                          <TableCell>{s.error ?? s.output ?? ""}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : null}
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <AutomationRunsPanel
          runs={runs}
          statusLabel={t("builder.runStatus")}
          emptyLabel={t("builder.runsEmpty")}
        />
      )}
    </div>
  );
}

/**
 * Runs tab: the run log table following the flows RunsPanel pattern (same
 * @openbooks/ui Table + Badge + status columns over loader-resolved rows),
 * with automation statuses and a steps drawer per run.
 */
export function AutomationRunsPanel({
  runs,
  statusLabel,
  emptyLabel,
}: {
  runs: BuilderRun[];
  statusLabel: string;
  emptyLabel: string;
}) {
  const t = useTranslations("admin.automations");
  const runStatusLabel = (value: string) =>
    ["succeeded", "failed", "simulated", "skipped", "running", "queued"].includes(value)
      ? t(`builder.runStatuses.${value}`)
      : t("builder.otherStatus");
  const actionKindLabel = (value: string) =>
    (ACTION_KINDS as readonly string[]).includes(value)
      ? t(`builder.actionKinds.${value}`)
      : t("builder.otherStep");
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [steps, setSteps] = useState<
    { index: number; kind: string; status: string; output?: string; error?: string }[]
  >([]);
  const [runError, setRunError] = useState<string | null>(null);

  async function openRun(id: string) {
    setOpenRunId(id);
    setSteps([]);
    setRunError(null);
    try {
      const res = await fetch(`/api/automations/runs/${id}`);
      if (!res.ok) {
        setRunError(await readApiErrorMessage(res, t("builder.runLoadFailed")));
        return;
      }
      const payload = (await res.json().catch(() => ({}))) as {
        run?: {
          steps?: {
            index: number;
            kind: string;
            status: string;
            output?: string;
            error?: string;
          }[];
          error?: { message?: string } | null;
        };
      };
      setSteps(payload.run?.steps ?? []);
      if (payload.run?.error && typeof payload.run.error.message === "string")
        setRunError(payload.run.error.message);
    } catch {
      setRunError(t("builder.runLoadFailed"));
    }
  }

  if (runs.length === 0) return <p className="text-sm text-slate-500">{emptyLabel}</p>;

  return (
    <div className="grid gap-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{statusLabel}</TableHead>
            <TableHead>{t("builder.runVersion")}</TableHead>
            <TableHead>{t("builder.runSubject")}</TableHead>
            <TableHead>{t("builder.runCreated")}</TableHead>
            <TableHead>{t("builder.runSteps")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Badge
                  variant={
                    r.status === "succeeded"
                      ? "success"
                      : r.status === "failed"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {runStatusLabel(r.status)}
                </Badge>
              </TableCell>
              <TableCell className="tabular-nums">{r.version}</TableCell>
              <TableCell>
                {r.subjectKind ? t(`builder.subjectKinds.${r.subjectKind}`) : "—"}
              </TableCell>
              <TableCell className="tabular-nums">{r.createdAt}</TableCell>
              <TableCell>
                <Button variant="outline" onClick={() => openRun(r.id)}>
                  {t("builder.viewSteps")}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {openRunId ? (
        <section className="rounded-lg border bg-white p-4 dark:bg-slate-900">
          <h3 className="text-sm font-semibold">{t("builder.stepsTitle")}</h3>
          {runError ? (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">{runError}</p>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>{t("builder.stepKind")}</TableHead>
                <TableHead>{t("builder.stepStatus")}</TableHead>
                <TableHead>{t("builder.stepDetail")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {steps.map((s) => (
                <TableRow key={s.index}>
                  <TableCell className="tabular-nums">{s.index}</TableCell>
                  <TableCell>{actionKindLabel(s.kind)}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        s.status === "succeeded" || s.status === "simulated"
                          ? "success"
                          : s.status === "failed"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {runStatusLabel(s.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>{s.error ?? s.output ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-2">
            <Button variant="outline" onClick={() => setOpenRunId(null)}>
              {t("builder.closeSteps")}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
