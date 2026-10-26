"use client";

import Link from "next/link";
import { ApiResponseError } from "@/lib/api-error";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Badge,
  Button,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Textarea,
  UrlDrawer,
} from "@openbooks/ui";
import { ChevronRight, GitBranch, Plus, Trash2 } from "lucide-react";
import { pickString } from "../../../../../lib/list-params";
import {
  Check,
  ConfigListControls,
  EmptyList,
  Field,
  RowLink,
  SectionHeading,
  dataText,
  drawerHref,
  post,
} from "./close-setup-shared";
import type { BlueprintDraft, BlueprintRow, BlueprintStepDraft, Props } from "./close-setup-types";

export function BlueprintsTab(props: Props) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const selected = pickString(props.currentParams.blueprint);
  const row =
    selected && selected !== "new"
      ? props.blueprints.find((item) => item.id === selected)
      : undefined;
  return (
    <div className="space-y-4">
      <SectionHeading
        icon={<GitBranch size={18} />}
        title={t("blueprints.title")}
        description={t("blueprints.description")}
        action={
          <Button size="sm" asChild>
            <Link href={drawerHref(props.currentParams, "blueprints", "blueprint", "new")}>
              <Plus size={14} />
              {t("actions.newBlueprint")}
            </Link>
          </Button>
        }
      />
      <ConfigListControls
        listKey="blueprint"
        list={props.configLists.blueprint}
        currentParams={props.currentParams}
        perPage={props.configPerPage}
      />
      <div className="grid gap-3 md:grid-cols-2">
        {props.blueprints.map((item) => (
          <RowLink
            key={item.id}
            href={drawerHref(props.currentParams, "blueprints", "blueprint", item.id)}
          >
            <CardHeader className="p-4">
              <div className="flex justify-between gap-2">
                <CardTitle className="text-base">
                  {dataText(td, item.name)}{" "}
                  <span className="text-xs font-normal text-slate-400">v{item.version}</span>
                </CardTitle>
                <div className="flex gap-1">
                  {item.is_default ? <Badge variant="success">{t("labels.default")}</Badge> : null}
                  {!item.is_active ? <Badge variant="outline">{t("labels.inactive")}</Badge> : null}
                  <ChevronRight size={16} className="text-slate-400" />
                </div>
              </div>
              <CardDescription>{dataText(td, item.description)}</CardDescription>
            </CardHeader>
            <CardContent className="px-4 pb-4 text-xs text-slate-500">
              {t("blueprints.stepCount", { count: item.steps.length })} ·{" "}
              {t(`periodTypes.${item.period_type}`)}
            </CardContent>
          </RowLink>
        ))}
      </div>
      {props.blueprints.length === 0 ? <EmptyList>{t("empty.blueprints")}</EmptyList> : null}
      {selected ? <BlueprintDrawer key={selected} row={row} params={props.currentParams} /> : null}
    </div>
  );
}

export function emptyStep(index: number): BlueprintStepDraft {
  return {
    key: `step-${index}`,
    title: "",
    description: "",
    workstream: "gl",
    taskType: "action",
    completionMode: "manual",
    gateType: "none",
    dueOffsetBusinessDays: 0,
    evidenceRequired: false,
    defaultOwnerRoleKey: "",
    applicabilityText: "{}",
    dependsOn: [],
  };
}
export function BlueprintDrawer({
  row,
  params,
}: {
  row?: BlueprintRow;
  params: Props["currentParams"];
}) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const router = useRouter();
  const closeHref = drawerHref(params, "blueprints", "blueprint", null);
  const [draft, setDraft] = useState<BlueprintDraft>(
    row
      ? {
          id: row.id,
          name: dataText(td, row.name),
          description: dataText(td, row.description),
          periodType: row.period_type,
          isDefault: row.is_default,
          steps: row.steps.map((step) => ({
            key: step.key,
            title: dataText(td, step.title),
            description: dataText(td, step.description) ?? "",
            workstream: step.workstream,
            taskType: step.task_type,
            completionMode: step.completion_mode,
            gateType: step.gate_type,
            dueOffsetBusinessDays: step.due_offset_business_days,
            evidenceRequired: step.evidence_required,
            defaultOwnerRoleKey: step.default_owner_role_key ?? "",
            applicabilityText: JSON.stringify(step.applicability ?? {}, null, 2),
            dependsOn: step.depends_on ?? [],
          })),
        }
      : {
          name: "",
          description: "",
          periodType: "any",
          isDefault: false,
          steps: [emptyStep(1)],
        },
  );
  const [busy, setBusy] = useState(false);
  const updateStep = (index: number, changes: Partial<BlueprintStepDraft>) =>
    setDraft({
      ...draft,
      steps: draft.steps.map((step, i: number) => (i === index ? { ...step, ...changes } : step)),
    });
  async function save() {
    setBusy(true);
    try {
      await post(
        {
          action: "save-blueprint",
          ...draft,
          steps: draft.steps.map((step) => ({
            ...step,
            applicability: JSON.parse(step.applicabilityText || "{}"),
          })),
        },
        t("errors.actionFailed"),
      );
      toast.success(t("messages.blueprintSaved"));
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
      size="xl"
      title={row ? t("blueprints.newVersionTitle") : t("blueprints.newTitle")}
      description={t("blueprints.versionHint")}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={() => router.push(closeHref)}>
            {t("actions.cancel")}
          </Button>
          <Button disabled={busy || !draft.name || draft.steps.length === 0} onClick={save}>
            {busy ? t("actions.saving") : t("actions.saveVersion")}
          </Button>
        </div>
      }
    >
      <div className="space-y-5 p-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("fields.name")}>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field label={t("fields.periodType")}>
            <Select
              value={draft.periodType}
              onChange={(e) => setDraft({ ...draft, periodType: e.target.value })}
            >
              {["any", "month", "quarter", "year", "adjustment"].map((value) => (
                <option key={value} value={value}>
                  {t(`periodTypes.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t("fields.description")}>
          <Textarea
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </Field>
        <div className="flex items-center justify-between">
          <Label>{t("blueprints.steps")}</Label>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setDraft({
                ...draft,
                steps: [...draft.steps, emptyStep(draft.steps.length + 1)],
              })
            }
          >
            <Plus size={14} />
            {t("actions.addStep")}
          </Button>
        </div>
        <div className="space-y-3">
          {draft.steps.map((step, index: number) => (
            <div
              key={index}
              className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("fields.stepKey")}>
                  <Input
                    value={step.key}
                    onChange={(e) => updateStep(index, { key: e.target.value })}
                  />
                </Field>
                <Field label={t("fields.stepTitle")}>
                  <Input
                    value={step.title}
                    onChange={(e) => updateStep(index, { title: e.target.value })}
                  />
                </Field>
                <Field label={t("fields.workstream")}>
                  <Select
                    value={step.workstream}
                    onChange={(e) => updateStep(index, { workstream: e.target.value })}
                  >
                    {[
                      "readiness",
                      "banking",
                      "ar",
                      "ap",
                      "assets",
                      "tax",
                      "payroll",
                      "intercompany",
                      "gl",
                      "review",
                      "publish",
                    ].map((value) => (
                      <option key={value} value={value}>
                        {t(`workstreams.${value}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("fields.taskType")}>
                  <Select
                    value={step.taskType}
                    onChange={(e) => updateStep(index, { taskType: e.target.value })}
                  >
                    {[
                      "check",
                      "action",
                      "reconciliation",
                      "journal",
                      "approval",
                      "report",
                      "publish",
                    ].map((value) => (
                      <option key={value} value={value}>
                        {t(`taskTypes.${value}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("fields.gate")}>
                  <Select
                    value={step.gateType}
                    onChange={(e) => updateStep(index, { gateType: e.target.value })}
                  >
                    {["none", "soft", "hard"].map((value) => (
                      <option key={value} value={value}>
                        {t(`gates.${value}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("fields.completion")}>
                  <Select
                    value={step.completionMode}
                    onChange={(e) => updateStep(index, { completionMode: e.target.value })}
                  >
                    {["manual", "computed", "automatic"].map((value) => (
                      <option key={value} value={value}>
                        {t(`completionModes.${value}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("fields.dueOffset")}>
                  <Input
                    type="number"
                    value={step.dueOffsetBusinessDays}
                    onChange={(e) =>
                      updateStep(index, {
                        dueOffsetBusinessDays: Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field label={t("fields.dependencies")}>
                  <Input
                    value={(step.dependsOn ?? []).join(", ")}
                    onChange={(e) =>
                      updateStep(index, {
                        dependsOn: e.target.value
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
                <Field label={t("fields.ownerRole")}>
                  <Input
                    value={step.defaultOwnerRoleKey}
                    onChange={(e) => updateStep(index, { defaultOwnerRoleKey: e.target.value })}
                  />
                </Field>
                <Field label={t("fields.applicability")}>
                  <Textarea
                    className="font-mono text-xs"
                    rows={3}
                    value={step.applicabilityText}
                    onChange={(e) => updateStep(index, { applicabilityText: e.target.value })}
                  />
                </Field>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <Check
                  checked={step.evidenceRequired}
                  onChange={(value) => updateStep(index, { evidenceRequired: value })}
                >
                  {t("fields.evidenceRequired")}
                </Check>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      steps: draft.steps.filter((_: BlueprintStepDraft, i: number) => i !== index),
                    })
                  }
                >
                  <Trash2 size={14} />
                  {t("actions.remove")}
                </Button>
              </div>
            </div>
          ))}
        </div>
        <Check
          checked={draft.isDefault}
          onChange={(value) => setDraft({ ...draft, isDefault: value })}
        >
          {t("fields.defaultBlueprint")}
        </Check>
      </div>
    </UrlDrawer>
  );
}
