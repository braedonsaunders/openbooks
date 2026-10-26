"use client";

import { ApiResponseError } from "@/lib/api-error";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, Input, SearchSelect, Select, Textarea, UrlDrawer } from "@openbooks/ui";
import {
  ALL_WORKSTREAMS,
  Check,
  Chips,
  Field,
  type Option,
  RUN_STATUSES,
  SEVERITIES,
  TASK_STATUSES,
  TokenSelect,
  asStringArray,
  drawerHref,
  numberOrUndefined,
  post,
  pruneEmpty,
} from "./close-setup-shared";
import type { AutomationDraft, AutomationRow, Props } from "./close-setup-types";

export function AutomationDrawer({ row, props }: { row?: AutomationRow; props: Props }) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const router = useRouter();
  const closeHref = drawerHref(props.currentParams, "automation", "automation", null);
  const [draft, setDraft] = useState<AutomationDraft>(
    row
      ? {
          id: row.id,
          name: row.name,
          trigger: row.trigger,
          automationAction: row.action,
          conditions: row.conditions ?? {},
          config: row.config ?? {},
          isActive: row.is_active,
        }
      : {
          name: "",
          trigger: "run_started",
          automationAction: "notify",
          conditions: {},
          config: {},
          isActive: true,
        },
  );
  const [busy, setBusy] = useState(false);
  const conditions = draft.conditions ?? {};
  const config = draft.config ?? {};
  const action = draft.automationAction;
  const setCondList = (key: string, values: string[]) => {
    const next = { ...conditions };
    if (values.length) next[key] = values;
    else delete next[key];
    setDraft({ ...draft, conditions: next });
  };
  const setCondNum = (key: string, raw: string) => {
    const next = { ...conditions };
    const num = numberOrUndefined(raw);
    if (num === undefined) delete next[key];
    else next[key] = num;
    setDraft({ ...draft, conditions: next });
  };
  const setConfig = (patch: Record<string, unknown>) =>
    setDraft({ ...draft, config: { ...config, ...patch } });
  const userOptions: Option[] = props.users.map((u) => ({
    value: u.id,
    label: u.name || u.email || u.id,
  }));
  const roleOptions: Option[] = props.roles.map((r) => ({
    value: r.key,
    label: r.name,
  }));
  const reportOptions: Option[] = props.reportDefs.map((r) => ({
    value: r.slug,
    label: r.name,
    group: t(`reportGroups.${r.kind}`),
  }));
  async function save() {
    setBusy(true);
    try {
      await post(
        {
          action: "save-automation",
          id: draft.id,
          name: draft.name,
          trigger: draft.trigger,
          automationAction: draft.automationAction,
          conditions: pruneEmpty(conditions),
          config: pruneEmpty(config),
          isActive: draft.isActive,
        },
        t("errors.actionFailed"),
      );
      toast.success(t("messages.automationSaved"));
      router.push(closeHref);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof ApiResponseError && error.message
          ? error.message
          : t("errors.invalidConfiguration"),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="lg"
      title={t("automation.formTitle")}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={() => router.push(closeHref)}>
            {t("actions.cancel")}
          </Button>
          <Button disabled={busy || !draft.name} onClick={save}>
            {busy ? t("actions.saving") : t("actions.save")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-1">
        <Field label={t("fields.name")}>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("fields.trigger")}>
            <Select
              value={draft.trigger}
              onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}
            >
              {[
                "run_started",
                "task_ready",
                "exception_opened",
                "deadline_approaching",
                "run_closed",
              ].map((value) => (
                <option key={value} value={value}>
                  {t(`automationTriggers.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("fields.action")}>
            <Select
              value={draft.automationAction}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  automationAction: e.target.value,
                  config:
                    e.target.value === "run_allocation" && Object.keys(config).length === 0
                      ? { ruleIds: "all", post: false }
                      : draft.config,
                })
              }
            >
              {[
                "notify",
                "assign",
                "run_check",
                "complete_task",
                "create_task",
                "generate_report",
                "start_flow",
                "run_allocation",
              ].map((value) => (
                <option key={value} value={value}>
                  {t(`automationActions.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <div>
            <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {t("automationConfig.sectionConditions")}
            </h4>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t("conditions.intro")}</p>
          </div>
          <Field label={t("conditions.runStatus")}>
            <Chips
              options={RUN_STATUSES.map((value) => ({
                value,
                label: td(`runStatus.${value}`),
              }))}
              value={asStringArray(conditions.runStatus)}
              onChange={(next) => setCondList("runStatus", next)}
            />
          </Field>
          <Field label={t("conditions.workstream")}>
            <Chips
              options={ALL_WORKSTREAMS.map((value) => ({
                value,
                label: t(`workstreams.${value}`),
              }))}
              value={asStringArray(conditions.workstream)}
              onChange={(next) => setCondList("workstream", next)}
            />
          </Field>
          <Field label={t("conditions.taskStatus")}>
            <Chips
              options={TASK_STATUSES.map((value) => ({
                value,
                label: td(`taskStatus.${value}`),
              }))}
              value={asStringArray(conditions.taskStatus)}
              onChange={(next) => setCondList("taskStatus", next)}
            />
          </Field>
          <Field label={t("conditions.severity")}>
            <Chips
              options={SEVERITIES.map((value) => ({
                value,
                label: td(`severity.${value}`),
              }))}
              value={asStringArray(conditions.severity)}
              onChange={(next) => setCondList("severity", next)}
            />
          </Field>
          <Field label={t("conditions.taskKey")} hint={t("conditions.taskKeyHint")}>
            <Input
              value={asStringArray(conditions.taskKey).join(", ")}
              onChange={(e) =>
                setCondList(
                  "taskKey",
                  e.target.value
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                )
              }
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t("conditions.minReadiness")}>
              <Input
                type="number"
                min={0}
                max={100}
                value={String(conditions.minReadiness ?? "")}
                onChange={(e) => setCondNum("minReadiness", e.target.value)}
              />
            </Field>
            <Field label={t("conditions.maxReadiness")}>
              <Input
                type="number"
                min={0}
                max={100}
                value={String(conditions.maxReadiness ?? "")}
                onChange={(e) => setCondNum("maxReadiness", e.target.value)}
              />
            </Field>
            <Field label={t("conditions.withinDays")}>
              <Input
                type="number"
                value={String(conditions.withinDays ?? "")}
                onChange={(e) => setCondNum("withinDays", e.target.value)}
              />
            </Field>
          </div>
        </div>
        <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {t("automationConfig.sectionConfig")}
          </h4>
          {action === "notify" ? (
            <>
              <Field
                label={t("automationConfig.notifyUsers")}
                hint={t("automationConfig.notifyHint")}
              >
                <TokenSelect
                  options={userOptions}
                  value={asStringArray(config.userIds)}
                  onChange={(next) => setConfig({ userIds: next })}
                  placeholder={t("automationConfig.notifyUsers")}
                />
              </Field>
              <Field label={t("automationConfig.notifyRoles")}>
                <TokenSelect
                  options={roleOptions}
                  value={asStringArray(config.roleKeys)}
                  onChange={(next) => setConfig({ roleKeys: next })}
                  placeholder={t("automationConfig.notifyRoles")}
                />
              </Field>
              <Field label={t("automationConfig.title")}>
                <Input
                  value={String(config.title ?? "")}
                  placeholder={t("automationConfig.titlePlaceholder")}
                  onChange={(e) => setConfig({ title: e.target.value })}
                />
              </Field>
              <Field label={t("automationConfig.body")}>
                <Textarea
                  value={String(config.body ?? "")}
                  placeholder={t("automationConfig.bodyPlaceholder")}
                  onChange={(e) => setConfig({ body: e.target.value })}
                />
              </Field>
            </>
          ) : null}
          {action === "assign" ? (
            <>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("automationConfig.assignHint")}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("automationConfig.owner")}>
                  <SearchSelect
                    value={String(config.ownerUserId ?? "")}
                    onChange={(v) => setConfig({ ownerUserId: v })}
                    options={userOptions}
                    clearable
                    searchable
                    ariaLabel={t("automationConfig.owner")}
                  />
                </Field>
                <Field label={t("automationConfig.ownerRole")}>
                  <SearchSelect
                    value={String(config.ownerRoleKey ?? "")}
                    onChange={(v) => setConfig({ ownerRoleKey: v })}
                    options={roleOptions}
                    clearable
                    searchable
                    ariaLabel={t("automationConfig.ownerRole")}
                  />
                </Field>
              </div>
            </>
          ) : null}
          {action === "create_task" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("automationConfig.taskKey")}>
                  <Input
                    value={String(config.key ?? "")}
                    placeholder={t("automationConfig.taskKeyPlaceholder")}
                    onChange={(e) => setConfig({ key: e.target.value })}
                  />
                </Field>
                <Field label={t("automationConfig.taskTitle")}>
                  <Input
                    value={String(config.title ?? "")}
                    onChange={(e) => setConfig({ title: e.target.value })}
                  />
                </Field>
                <Field label={t("fields.workstream")}>
                  <Select
                    value={String(config.workstream ?? "review")}
                    onChange={(e) => setConfig({ workstream: e.target.value })}
                  >
                    {ALL_WORKSTREAMS.map((value) => (
                      <option key={value} value={value}>
                        {t(`workstreams.${value}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("automationConfig.gate")}>
                  <Select
                    value={String(config.gateType ?? "none")}
                    onChange={(e) => setConfig({ gateType: e.target.value })}
                  >
                    {["none", "soft", "hard"].map((value) => (
                      <option key={value} value={value}>
                        {t(`gates.${value}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label={t("automationConfig.taskDescription")}>
                <Textarea
                  value={String(config.description ?? "")}
                  onChange={(e) => setConfig({ description: e.target.value })}
                />
              </Field>
              <Check
                checked={config.evidenceRequired === true}
                onChange={(value) => setConfig({ evidenceRequired: value })}
              >
                {t("automationConfig.evidenceRequired")}
              </Check>
            </>
          ) : null}
          {action === "generate_report" ? (
            <>
              <Field label={t("automationConfig.report")}>
                <SearchSelect
                  value={String(config.report ?? "")}
                  onChange={(v) => setConfig({ report: v })}
                  options={reportOptions}
                  searchable
                  clearable
                  ariaLabel={t("automationConfig.report")}
                  emptyLabel={t("reportsEmpty")}
                />
              </Field>
              <Field label={t("automationConfig.label")}>
                <Input
                  value={String(config.label ?? "")}
                  onChange={(e) => setConfig({ label: e.target.value })}
                />
              </Field>
            </>
          ) : null}
          {action === "start_flow" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("automationConfig.subjectKind")}>
                  <Input
                    value={String(config.subjectKind ?? "")}
                    onChange={(e) => setConfig({ subjectKind: e.target.value })}
                  />
                </Field>
                <Field label={t("automationConfig.subjectId")}>
                  <Select
                    value={String(config.subjectId ?? "$run")}
                    onChange={(e) => setConfig({ subjectId: e.target.value })}
                  >
                    {["$run", "$task"].map((value) => (
                      <option key={value} value={value}>
                        {t(`subjectRefs.${value}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label={t("automationConfig.buttonId")}>
                <Input
                  value={String(config.buttonId ?? "")}
                  onChange={(e) => setConfig({ buttonId: e.target.value })}
                />
              </Field>
            </>
          ) : null}
          {action === "run_allocation" ? (
            <>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("automationConfig.allocHint")}
              </p>
              <Check
                checked={config.ruleIds === "all"}
                onChange={(value) => setConfig(value ? { ruleIds: "all" } : { ruleIds: [] })}
              >
                {t("automationConfig.allocAllRules")}
              </Check>
              {config.ruleIds !== "all" ? (
                <Field
                  label={t("automationConfig.allocRuleIds")}
                  hint={t("automationConfig.allocRuleIdsHint")}
                >
                  <Textarea
                    className="font-mono text-xs"
                    rows={2}
                    value={(Array.isArray(config.ruleIds) ? config.ruleIds : []).join(", ")}
                    onChange={(e) =>
                      setConfig({
                        ruleIds: e.target.value
                          .split(",")
                          .map((v) => v.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
              ) : null}
              <Check
                checked={config.post === true}
                onChange={(value) => setConfig({ post: value })}
              >
                {t("automationConfig.allocPost")}
              </Check>
            </>
          ) : null}
          {action === "run_check" || action === "complete_task" ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t("automationConfig.none")}
            </p>
          ) : null}
        </div>
        <Check
          checked={draft.isActive !== false}
          onChange={(value) => setDraft({ ...draft, isActive: value })}
        >
          {t("fields.active")}
        </Check>
      </div>
    </UrlDrawer>
  );
}
