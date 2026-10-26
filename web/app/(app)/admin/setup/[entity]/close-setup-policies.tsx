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
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Textarea,
  UrlDrawer,
} from "@openbooks/ui";
import { Bot, ChevronRight, Plus, ShieldCheck } from "lucide-react";
import { pickString } from "../../../../../lib/list-params";
import { AutomationDrawer } from "./close-setup-automation";
import {
  Check,
  ConfigListControls,
  EmptyList,
  Field,
  KeyValueRows,
  RowLink,
  SectionHeading,
  dataText,
  drawerHref,
  numberOrUndefined,
  objectToRows,
  post,
  rowsToObject,
} from "./close-setup-shared";
import type { PolicyDraft, PolicyRow, Props } from "./close-setup-types";

export function PoliciesTab(props: Props) {
  return <SimpleConfigTab props={props} kind="policy" icon={<ShieldCheck size={18} />} />;
}
export function AutomationTab(props: Props) {
  return <SimpleConfigTab props={props} kind="automation" icon={<Bot size={18} />} />;
}
export function SimpleConfigTab({
  props,
  kind,
  icon,
}: {
  props: Props;
  kind: "policy" | "automation";
  icon: React.ReactNode;
}) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const tab = kind === "policy" ? "policies" : "automation";
  const listKey = kind;
  const param = pickString(props.currentParams[kind]);
  const rows = kind === "policy" ? props.policies : props.automations;
  return (
    <div className="space-y-4">
      <SectionHeading
        icon={icon}
        title={t(`${tab}.title`)}
        description={t(`${tab}.description`)}
        action={
          <Button size="sm" asChild>
            <Link href={drawerHref(props.currentParams, tab, kind, "new")}>
              <Plus size={14} />
              {t(`actions.new${kind === "policy" ? "Policy" : "Automation"}`)}
            </Link>
          </Button>
        }
      />
      <ConfigListControls
        listKey={listKey}
        list={props.configLists[listKey]}
        currentParams={props.currentParams}
        perPage={props.configPerPage}
      />
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((item) => (
          <RowLink key={item.id} href={drawerHref(props.currentParams, tab, kind, item.id)}>
            <CardHeader className="p-4">
              <div className="flex justify-between gap-2">
                <CardTitle className="text-base">{dataText(td, item.name)}</CardTitle>
                <div className="flex gap-1">
                  <Badge variant={item.is_active ? "success" : "outline"}>
                    {t(item.is_active ? "labels.active" : "labels.inactive")}
                  </Badge>
                  <ChevronRight size={16} className="text-slate-400" />
                </div>
              </div>
              <CardDescription>
                {kind === "policy"
                  ? `${t(`policyTypes.${item.policy_type}`)} · ${item.code}`
                  : `${t(`automationTriggers.${item.trigger}`)} → ${t(`automationActions.${item.action}`)}`}
              </CardDescription>
            </CardHeader>
          </RowLink>
        ))}
      </div>
      {rows.length === 0 ? <EmptyList>{t(`empty.${tab}`)}</EmptyList> : null}
      {param ? (
        kind === "policy" ? (
          <PolicyDrawer
            key={param}
            row={param !== "new" ? props.policies.find((item) => item.id === param) : undefined}
            params={props.currentParams}
          />
        ) : (
          <AutomationDrawer
            key={param}
            row={param !== "new" ? props.automations.find((item) => item.id === param) : undefined}
            props={props}
          />
        )
      ) : null}
    </div>
  );
}

export function PolicyDrawer({ row, params }: { row?: PolicyRow; params: Props["currentParams"] }) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const router = useRouter();
  const closeHref = drawerHref(params, "policies", "policy", null);
  const [draft, setDraft] = useState<PolicyDraft>(
    row
      ? {
          id: row.id,
          code: row.code,
          name: dataText(td, row.name),
          description: dataText(td, row.description) ?? "",
          policyType: row.policy_type,
          rules: row.rules ?? {},
          isActive: row.is_active,
        }
      : {
          code: "",
          name: "",
          description: "",
          policyType: "materiality",
          rules: {},
          isActive: true,
        },
  );
  const [advanced, setAdvanced] = useState<Array<{ key: string; value: string }>>(
    objectToRows(row?.rules),
  );
  const [busy, setBusy] = useState(false);
  const rules = draft.rules ?? {};
  const isAdvanced = draft.policyType === "evidence" || draft.policyType === "exception";
  const setRules = (patch: Record<string, unknown>) =>
    setDraft({ ...draft, rules: { ...rules, ...patch } });
  function composeRules(): Record<string, unknown> {
    if (draft.policyType === "materiality")
      return {
        amount: String(rules.amount || "10000.0000"),
        percent: numberOrUndefined(String(rules.percent ?? "")) ?? 20,
      };
    if (draft.policyType === "lock")
      return {
        defaultHours: numberOrUndefined(String(rules.defaultHours ?? "")) ?? 24,
        maxHours: numberOrUndefined(String(rules.maxHours ?? "")) ?? 168,
      };
    return rowsToObject(advanced);
  }
  async function save() {
    setBusy(true);
    try {
      await post(
        {
          action: "save-policy",
          id: draft.id,
          code: draft.code,
          name: draft.name,
          description: draft.description,
          policyType: draft.policyType,
          rules: composeRules(),
          isActive: draft.isActive,
        },
        t("errors.actionFailed"),
      );
      toast.success(t("messages.policySaved"));
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
      title={
        draft.policyType === "materiality"
          ? t("policies.materialityFormTitle")
          : t("policies.formTitle")
      }
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="outline" onClick={() => router.push(closeHref)}>
            {t("actions.cancel")}
          </Button>
          <Button disabled={busy || !draft.name || !draft.code} onClick={save}>
            {busy ? t("actions.saving") : t("actions.save")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("fields.code")}>
            <Input
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            />
          </Field>
          <Field label={t("fields.policyType")}>
            <Select
              value={draft.policyType}
              onChange={(e) => setDraft({ ...draft, policyType: e.target.value })}
            >
              {["materiality", "lock", "evidence", "exception"].map((value) => (
                <option key={value} value={value}>
                  {t(`policyTypes.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t("fields.name")}>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label={t("fields.description")}>
          <Textarea
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </Field>
        <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          {draft.policyType === "materiality" ? (
            <>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("policyRules.materialityIntro")}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("policyRules.amount")} hint={t("policyRules.amountHint")}>
                  <Input
                    inputMode="decimal"
                    value={String(rules.amount ?? "")}
                    placeholder="10000.0000"
                    onChange={(e) => setRules({ amount: e.target.value })}
                  />
                </Field>
                <Field label={t("policyRules.percent")} hint={t("policyRules.percentHint")}>
                  <Input
                    type="number"
                    min={0}
                    value={String(rules.percent ?? "")}
                    placeholder="20"
                    onChange={(e) =>
                      setRules({
                        percent: e.target.value === "" ? "" : Number(e.target.value),
                      })
                    }
                  />
                </Field>
              </div>
            </>
          ) : null}
          {draft.policyType === "lock" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("policyRules.defaultHours")}>
                  <Input
                    type="number"
                    min={1}
                    value={String(rules.defaultHours ?? "")}
                    placeholder="24"
                    onChange={(e) =>
                      setRules({
                        defaultHours: e.target.value === "" ? "" : Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field label={t("policyRules.maxHours")}>
                  <Input
                    type="number"
                    min={1}
                    value={String(rules.maxHours ?? "")}
                    placeholder="168"
                    onChange={(e) =>
                      setRules({
                        maxHours: e.target.value === "" ? "" : Number(e.target.value),
                      })
                    }
                  />
                </Field>
              </div>
            </>
          ) : null}
          {isAdvanced ? (
            <>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("policyRules.advancedIntro")}
              </p>
              <KeyValueRows rows={advanced} onChange={setAdvanced} />
            </>
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
