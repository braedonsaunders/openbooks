"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Input,
  Label,
  SearchSelect,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  UrlDrawer,
  cn,
} from "@openbooks/ui";
import { SearchInput } from "../../../../../components/search-input";
import { Pagination } from "../../../../../components/pagination";
import { money } from "../../../../../lib/format";

export type CrmSetupTab =
  | "accountStatuses"
  | "opportunityStatuses"
  | "sources"
  | "territories"
  | "teams"
  | "quotas";

const TABS: CrmSetupTab[] = [
  "accountStatuses",
  "opportunityStatuses",
  "sources",
  "territories",
  "teams",
  "quotas",
];

const COLUMNS: Record<CrmSetupTab, string[]> = {
  accountStatuses: [
    "name",
    "lifecycle_stage",
    "sequence",
    "is_qualified",
    "is_active",
  ],
  opportunityStatuses: [
    "name",
    "probability",
    "default_forecast_category",
    "is_closed",
    "is_active",
  ],
  sources: ["name", "description", "is_active"],
  territories: ["name", "owner_name", "priority", "is_active"],
  teams: ["name", "manager_name", "member_count", "is_active"],
  quotas: ["target_name", "period_start", "period_end", "amount", "currency"],
};

type Option = { id: string; name: string };
type CurrencyOption = { code: string; name: string };

export function CrmSetupWorkspace({
  tab,
  rows,
  selected,
  creating,
  total,
  page,
  perPage,
  currentParams,
  users,
  teams,
  baseCurrency,
  currencies,
}: {
  tab: CrmSetupTab;
  rows: Record<string, any>[];
  selected: Record<string, any> | null;
  creating: boolean;
  total: number;
  page: number;
  perPage: number;
  currentParams: Record<string, string | string[] | undefined>;
  users: Option[];
  teams: Option[];
  baseCurrency: string;
  currencies: CurrencyOption[];
}) {
  const t = useTranslations("crm");
  const searchParams = useSearchParams();
  const basePath = "/admin/setup/crm";
  const closeParams = new URLSearchParams(searchParams.toString());
  closeParams.delete("row");
  closeParams.set("tab", tab);
  const closeHref = `${basePath}?${closeParams.toString()}`;
  const newParams = new URLSearchParams(closeParams);
  newParams.set("row", "new");

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {t("setup.title")}
        </h2>
        <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          {t("setup.description")}
        </p>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
        {TABS.map((key) => (
          <Link
            key={key}
            href={`${basePath}?tab=${key}`}
            className={cn(
              "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === key
                ? "border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300"
                : "border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
            )}
          >
            {t(`setup.tabs.${key}`)}
          </Link>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput placeholder={t(`setup.search.${tab}`)} />
        <Button asChild>
          <Link href={`${basePath}?${newParams.toString()}`}>
            <Plus size={15} />
            {t(`setup.new.${tab}`)}
          </Link>
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <SetupRows tab={tab} rows={rows} closeHref={closeHref} />
      </div>
      <Pagination
        basePath={basePath}
        currentParams={currentParams}
        total={total}
        page={page}
        perPage={perPage}
      />

      {creating || selected ? (
        <CrmSetupDrawer
          key={`${tab}:${selected?.id ?? "new"}`}
          tab={tab}
          row={selected}
          users={users}
          teams={teams}
          baseCurrency={baseCurrency}
          currencies={currencies}
          closeHref={closeHref}
        />
      ) : null}
    </div>
  );
}

function SetupRows({
  tab,
  rows,
  closeHref,
}: {
  tab: CrmSetupTab;
  rows: Record<string, any>[];
  closeHref: string;
}) {
  const t = useTranslations("crm");
  const router = useRouter();
  const columns = COLUMNS[tab];
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead key={column}>{t(`setup.columns.${column}`)}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={columns.length}
              className="py-10 text-center text-slate-500 dark:text-slate-400"
            >
              {t("setup.empty")}
            </TableCell>
          </TableRow>
        ) : null}
        {rows.map((row) => {
          const href = `${closeHref}&row=${row.id}`;
          const label = String(
            row.name ?? row.target_name ?? t("setup.tabs.quotas"),
          );
          return (
            <TableRow
              key={row.id}
              className="cursor-pointer"
              tabIndex={0}
              aria-label={t("setup.openRecord", { name: label })}
              onClick={() => router.push(href)}
              onKeyDown={(event) => {
                if (event.key === "Enter") router.push(href);
              }}
            >
              {columns.map((column, index) => (
                <TableCell key={column}>
                  {index === 0 ? (
                    <Link
                      href={href}
                      className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {renderCell(column, row, t)}
                    </Link>
                  ) : (
                    renderCell(column, row, t)
                  )}
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function renderCell(column: string, row: Record<string, any>, t: any) {
  const value = row[column];
  if (column === "is_active")
    return (
      <Badge variant={value ? "success" : "outline"}>
        {t(`setup.states.${value ? "active" : "inactive"}`)}
      </Badge>
    );
  if (["is_qualified", "is_closed"].includes(column))
    return t(`setup.states.${value ? "yes" : "no"}`);
  if (column === "lifecycle_stage") return t(`stages.${value}`);
  if (column === "default_forecast_category")
    return t(`forecastCategories.${value}`);
  if (column === "probability")
    return t("setup.percent", { value: Number(value) });
  if (column === "member_count")
    return t("setup.memberCount", { count: Number(value) });
  if (column === "amount") return money(value, "");
  return value == null || value === "" ? "—" : String(value);
}

function CrmSetupDrawer({
  tab,
  row,
  users,
  teams,
  baseCurrency,
  currencies,
  closeHref,
}: {
  tab: CrmSetupTab;
  row: Record<string, any> | null;
  users: Option[];
  teams: Option[];
  baseCurrency: string;
  currencies: CurrencyOption[];
  closeHref: string;
}) {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
  const router = useRouter();
  const creating = !row;
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, any>>(() =>
    initialForm(tab, row, baseCurrency),
  );
  const set = (key: string, value: unknown) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    if (tab !== "quotas" && !String(form.name ?? "").trim()) {
      toast.error(t("setup.validation.nameRequired"));
      return;
    }
    let payload: Record<string, any>;
    try {
      payload = normalizePayload(tab, form);
    } catch {
      toast.error(t("setup.validation.invalidRules"));
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/crm/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: actionFor(tab),
          id: row?.id,
          ...payload,
        }),
      });
      if (!response.ok) throw new Error();
      toast.success(t(creating ? "setup.created" : "setup.updated"));
      router.push(closeHref);
    } catch {
      toast.error(tc("feedback.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="lg"
      title={t(`setup.drawer.${creating ? "new" : "edit"}.${tab}`)}
      description={t(`setup.drawer.description.${tab}`)}
      headerActions={
        <Button disabled={busy} onClick={save}>
          {busy
            ? tc("actions.saving")
            : creating
              ? tc("actions.create")
              : tc("actions.save")}
        </Button>
      }
    >
      <div className="grid gap-4 p-1 sm:grid-cols-2">
        {tab === "accountStatuses" ? (
          <AccountStatusFields form={form} set={set} t={t} />
        ) : null}
        {tab === "opportunityStatuses" ? (
          <OpportunityStatusFields form={form} set={set} t={t} />
        ) : null}
        {tab === "sources" ? (
          <SourceFields form={form} set={set} t={t} />
        ) : null}
        {tab === "territories" ? (
          <TerritoryFields form={form} set={set} users={users} t={t} />
        ) : null}
        {tab === "teams" ? (
          <TeamFields form={form} set={set} users={users} t={t} />
        ) : null}
        {tab === "quotas" ? (
          <QuotaFields
            form={form}
            set={set}
            users={users}
            teams={teams}
            currencies={currencies}
            t={t}
          />
        ) : null}
      </div>
    </UrlDrawer>
  );
}

function initialForm(
  tab: CrmSetupTab,
  row: Record<string, any> | null,
  baseCurrency: string,
) {
  if (tab === "accountStatuses")
    return {
      name: row?.name ?? "",
      description: row?.description ?? "",
      lifecycleStage: row?.lifecycle_stage ?? "lead",
      sequence: row?.sequence ?? 10,
      isQualified: row?.is_qualified ?? false,
      isClosed: row?.is_closed ?? false,
      isDefault: row?.is_default ?? false,
      isActive: row?.is_active ?? true,
    };
  if (tab === "opportunityStatuses")
    return {
      name: row?.name ?? "",
      description: row?.description ?? "",
      sequence: row?.sequence ?? 10,
      probability: row?.probability ?? 0,
      defaultForecastCategory: row?.default_forecast_category ?? "upside",
      isClosed: row?.is_closed ?? false,
      isWon: row?.is_won ?? false,
      isDefault: row?.is_default ?? false,
      isActive: row?.is_active ?? true,
    };
  if (tab === "sources")
    return {
      name: row?.name ?? "",
      description: row?.description ?? "",
      isActive: row?.is_active ?? true,
    };
  if (tab === "territories")
    return {
      name: row?.name ?? "",
      description: row?.description ?? "",
      priority: row?.priority ?? 100,
      managerUserId: row?.manager_user_id ?? "",
      defaultOwnerUserId: row?.default_owner_user_id ?? "",
      matchMode: row?.match_mode ?? "all",
      rulesText: JSON.stringify(row?.rules ?? [], null, 2),
      isActive: row?.is_active ?? true,
    };
  if (tab === "teams")
    return {
      name: row?.name ?? "",
      managerUserId: row?.manager_user_id ?? "",
      memberIds: (row?.members ?? []).map((member: any) => member.userId),
      isActive: row?.is_active ?? true,
    };
  return {
    targetType: row?.sales_team_id ? "team" : "user",
    targetId: row?.sales_team_id ?? row?.owner_user_id ?? "",
    periodStart: row?.period_start ?? "",
    periodEnd: row?.period_end ?? "",
    currency: row?.currency ?? baseCurrency,
    amount: row?.amount ?? "",
  };
}

function actionFor(tab: CrmSetupTab) {
  return (
    {
      accountStatuses: "save-account-status",
      opportunityStatuses: "save-opportunity-status",
      sources: "save-lead-source",
      territories: "save-territory",
      teams: "save-team",
      quotas: "save-quota",
    } as const
  )[tab];
}

function normalizePayload(tab: CrmSetupTab, form: Record<string, any>) {
  if (tab === "territories") {
    const rules = JSON.parse(form.rulesText || "[]");
    if (!Array.isArray(rules)) throw new Error("rules must be an array");
    return {
      ...form,
      managerUserId: form.managerUserId || null,
      defaultOwnerUserId: form.defaultOwnerUserId || null,
      rules,
    };
  }
  if (tab === "teams")
    return {
      ...form,
      managerUserId: form.managerUserId || null,
      members: form.memberIds.map((userId: string) => ({
        userId,
        role: userId === form.managerUserId ? "manager" : "member",
      })),
    };
  if (tab === "quotas")
    return {
      ...form,
      ownerUserId: form.targetType === "user" ? form.targetId : null,
      salesTeamId: form.targetType === "team" ? form.targetId : null,
    };
  return form;
}

function AccountStatusFields({ form, set, t }: FieldProps) {
  return (
    <>
      <TextField
        label={t("setup.fields.name")}
        value={form.name}
        onChange={(v) => set("name", v)}
      />
      <SelectField
        label={t("fields.lifecycleStage")}
        value={form.lifecycleStage}
        onChange={(v) => set("lifecycleStage", v)}
        options={["lead", "prospect", "customer"].map((value) => ({
          value,
          label: t(`stages.${value}`),
        }))}
      />
      <TextField
        label={t("setup.sequence")}
        type="number"
        value={String(form.sequence)}
        onChange={(v) => set("sequence", v)}
      />
      <TextAreaField
        label={t("fields.description")}
        value={form.description}
        onChange={(v) => set("description", v)}
      />
      <ToggleGrid
        form={form}
        set={set}
        keys={["isQualified", "isClosed", "isDefault", "isActive"]}
        t={t}
      />
    </>
  );
}

function OpportunityStatusFields({ form, set, t }: FieldProps) {
  const setStatus = (key: string, value: unknown) => {
    set(key, value);
    if (key === "isWon" && value === true) set("isClosed", true);
    if (key === "isClosed" && value === false) set("isWon", false);
  };
  return (
    <>
      <TextField
        label={t("setup.fields.name")}
        value={form.name}
        onChange={(v) => set("name", v)}
      />
      <TextField
        label={t("fields.probability")}
        type="number"
        value={String(form.probability)}
        onChange={(v) => set("probability", v)}
      />
      <TextField
        label={t("setup.sequence")}
        type="number"
        value={String(form.sequence)}
        onChange={(v) => set("sequence", v)}
      />
      <SelectField
        label={t("fields.forecastCategory")}
        value={form.defaultForecastCategory}
        onChange={(v) => set("defaultForecastCategory", v)}
        options={["omitted", "worst_case", "most_likely", "upside"].map(
          (value) => ({ value, label: t(`forecastCategories.${value}`) }),
        )}
      />
      <TextAreaField
        label={t("fields.description")}
        value={form.description}
        onChange={(v) => set("description", v)}
      />
      <ToggleGrid
        form={form}
        set={setStatus}
        keys={["isClosed", "isWon", "isDefault", "isActive"]}
        t={t}
      />
    </>
  );
}

function SourceFields({ form, set, t }: FieldProps) {
  return (
    <>
      <TextField
        label={t("setup.fields.name")}
        value={form.name}
        onChange={(v) => set("name", v)}
      />
      <TextAreaField
        label={t("fields.description")}
        value={form.description}
        onChange={(v) => set("description", v)}
      />
      <ToggleGrid form={form} set={set} keys={["isActive"]} t={t} />
    </>
  );
}

function TerritoryFields({
  form,
  set,
  users,
  t,
}: FieldProps & { users: Option[] }) {
  const userOptions = [
    { value: "", label: t("fields.unassigned") },
    ...users.map((user) => ({ value: user.id, label: user.name })),
  ];
  return (
    <>
      <TextField
        label={t("setup.fields.name")}
        value={form.name}
        onChange={(v) => set("name", v)}
      />
      <TextField
        label={t("setup.priority")}
        type="number"
        value={String(form.priority)}
        onChange={(v) => set("priority", v)}
      />
      <SelectField
        label={t("setup.manager")}
        value={form.managerUserId}
        onChange={(v) => set("managerUserId", v)}
        options={userOptions}
      />
      <SelectField
        label={t("setup.defaultOwner")}
        value={form.defaultOwnerUserId}
        onChange={(v) => set("defaultOwnerUserId", v)}
        options={userOptions}
      />
      <SelectField
        label={t("setup.fields.matchMode")}
        value={form.matchMode}
        onChange={(v) => set("matchMode", v)}
        options={["all", "any"].map((value) => ({
          value,
          label: t(`setup.matchModes.${value}`),
        }))}
      />
      <TextAreaField
        label={t("fields.description")}
        value={form.description}
        onChange={(v) => set("description", v)}
      />
      <TextAreaField
        label={t("setup.fields.rules")}
        value={form.rulesText}
        onChange={(v) => set("rulesText", v)}
        mono
      />
      <ToggleGrid form={form} set={set} keys={["isActive"]} t={t} />
    </>
  );
}

function TeamFields({ form, set, users, t }: FieldProps & { users: Option[] }) {
  const memberIds: string[] = form.memberIds;
  return (
    <>
      <TextField
        label={t("setup.fields.name")}
        value={form.name}
        onChange={(v) => set("name", v)}
      />
      <SelectField
        label={t("setup.manager")}
        value={form.managerUserId}
        onChange={(value) => {
          set("managerUserId", value);
          if (value && !memberIds.includes(value))
            set("memberIds", [...memberIds, value]);
        }}
        options={[
          { value: "", label: t("fields.unassigned") },
          ...users.map((user) => ({ value: user.id, label: user.name })),
        ]}
      />
      <div className="space-y-2 sm:col-span-2">
        <Label>{t("setup.fields.members")}</Label>
        <div className="grid gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800 sm:grid-cols-2">
          {users.map((user) => (
            <label key={user.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={memberIds.includes(user.id)}
                onChange={(event) =>
                  event.target.checked
                    ? set("memberIds", [...memberIds, user.id])
                    : (() => {
                        set(
                          "memberIds",
                          memberIds.filter((id) => id !== user.id),
                        );
                        if (form.managerUserId === user.id)
                          set("managerUserId", "");
                      })()
                }
                className="h-4 w-4 accent-teal-600"
              />
              {user.name}
            </label>
          ))}
        </div>
      </div>
      <ToggleGrid form={form} set={set} keys={["isActive"]} t={t} />
    </>
  );
}

function QuotaFields({
  form,
  set,
  users,
  teams,
  currencies,
  t,
}: FieldProps & {
  users: Option[];
  teams: Option[];
  currencies: CurrencyOption[];
}) {
  const options = form.targetType === "team" ? teams : users;
  return (
    <>
      <SelectField
        label={t("setup.fields.targetType")}
        value={form.targetType}
        onChange={(value) => {
          set("targetType", value);
          set("targetId", "");
        }}
        options={[
          { value: "user", label: t("setup.targetTypes.user") },
          { value: "team", label: t("setup.targetTypes.team") },
        ]}
      />
      <SelectField
        label={t("forecasts.target")}
        value={form.targetId}
        onChange={(v) => set("targetId", v)}
        options={[
          { value: "", label: t("fields.unassigned") },
          ...options.map((option) => ({
            value: option.id,
            label: option.name,
          })),
        ]}
      />
      <TextField
        label={t("fields.periodStart")}
        type="date"
        value={form.periodStart}
        onChange={(v) => set("periodStart", v)}
      />
      <TextField
        label={t("fields.periodEnd")}
        type="date"
        value={form.periodEnd}
        onChange={(v) => set("periodEnd", v)}
      />
      <div className="space-y-1.5">
        <Label>{t("fields.currency")}</Label>
        <SearchSelect
          value={form.currency}
          onChange={(value) => set("currency", value)}
          options={currencies.map((currency) => ({
            value: currency.code,
            label: `${currency.code} · ${currency.name}`,
          }))}
          ariaLabel={t("fields.currency")}
        />
      </div>
      <TextField
        label={t("forecasts.quota")}
        type="number"
        value={String(form.amount)}
        onChange={(v) => set("amount", v)}
      />
    </>
  );
}

type FieldProps = {
  form: Record<string, any>;
  set: (key: string, value: unknown) => void;
  t: any;
};

function TextField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1.5 sm:col-span-2">
      <Label>{label}</Label>
      <Textarea
        rows={mono ? 7 : 3}
        className={mono ? "font-mono text-xs" : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

function ToggleGrid({ form, set, keys, t }: FieldProps & { keys: string[] }) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 sm:col-span-2">
      {keys.map((key) => (
        <label
          key={key}
          className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
        >
          <input
            type="checkbox"
            checked={Boolean(form[key])}
            onChange={(event) => set(key, event.target.checked)}
            className="h-4 w-4 accent-teal-600"
          />
          {t(`setup.fields.${key}`)}
        </label>
      ))}
    </div>
  );
}
