"use client";

import { apiJson, ApiResponseError } from "@/lib/api-error";

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
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  UrlDrawer,
} from "@openbooks/ui";
import { SearchInput } from "../../../../../components/search-input";
import { Pagination } from "../../../../../components/pagination";
import { InteractiveTableRow } from '@/components/interactive-table-row'

export type CrmSetupTab =
  | "accountStatuses"
  | "opportunityStatuses"
  | "sources";

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
};

type CrmTranslator = ReturnType<typeof useTranslations>;
interface CrmSetupRecord extends Record<string, unknown> {
  id?: string; name?: string; description?: string;
  lifecycle_stage?: string; sequence?: number; is_qualified?: boolean; is_closed?: boolean;
  is_default?: boolean; is_active?: boolean; probability?: number;
  default_forecast_category?: string; is_won?: boolean;
  requires_lines?: boolean; requires_primary_contact?: boolean;
  requires_positive_amount?: boolean; requires_win_loss_reason?: boolean;
}
interface CrmForm extends Record<string, unknown> {
  name: string; description: string; lifecycleStage: string; sequence: string | number;
  isQualified: boolean; isClosed: boolean; isDefault: boolean; isActive: boolean;
  probability: string | number; defaultForecastCategory: string; isWon: boolean;
  requiresLines: boolean; requiresPrimaryContact: boolean;
  requiresPositiveAmount: boolean; requiresWinLossReason: boolean;
}
const EMPTY_CRM_FORM: CrmForm = {
  name: "", description: "", lifecycleStage: "lead", sequence: 10,
  isQualified: false, isClosed: false, isDefault: false, isActive: true,
  probability: 0, defaultForecastCategory: "upside", isWon: false,
  requiresLines: false, requiresPrimaryContact: false,
  requiresPositiveAmount: false, requiresWinLossReason: false,
}

export function CrmSetupWorkspace({
  tab,
  rows,
  selected,
  creating,
  total,
  page,
  perPage,
  currentParams,
}: {
  tab: CrmSetupTab;
  rows: CrmSetupRecord[];
  selected: CrmSetupRecord | null;
  creating: boolean;
  total: number;
  page: number;
  perPage: number;
  currentParams: Record<string, string | string[] | undefined>;
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
          {t(`setup.tabs.${tab}`)}
        </h2>
        <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          {t(`setup.descriptions.${tab}`)}
        </p>
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
  rows: CrmSetupRecord[];
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
          const label = String(row.name ?? "");
          return (
            <InteractiveTableRow
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
            </InteractiveTableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function renderCell(column: string, row: CrmSetupRecord, t: CrmTranslator) {
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
  return value == null || value === "" ? "—" : String(value);
}

function CrmSetupDrawer({
  tab,
  row,
  closeHref,
}: {
  tab: CrmSetupTab;
  row: CrmSetupRecord | null;
  closeHref: string;
}) {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
  const router = useRouter();
  const creating = !row;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<CrmForm>(() =>
    initialForm(tab, row),
  );
  const set = (key: string, value: unknown) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    if (!String(form.name ?? "").trim()) {
      toast.error(t("setup.validation.nameRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiJson("/api/crm/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: actionFor(tab),
          id: row?.id,
          ...form,
        }),
      },
        tc("feedback.saveFailed"),
      );
      toast.success(t(creating ? "setup.created" : "setup.updated"));
      router.push(closeHref);
    } catch (error) {
      const message =
        error instanceof ApiResponseError
          ? error.message
          : tc("feedback.saveFailed");
      setError(message);
      toast.error(message);
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
        {error ? (
          <p role="alert" className="text-sm text-red-600 sm:col-span-2">
            {error}
          </p>
        ) : null}
        {tab === "accountStatuses" ? (
          <AccountStatusFields form={form} set={set} t={t} />
        ) : null}
        {tab === "opportunityStatuses" ? (
          <OpportunityStatusFields form={form} set={set} t={t} />
        ) : null}
        {tab === "sources" ? (
          <SourceFields form={form} set={set} t={t} />
        ) : null}
      </div>
    </UrlDrawer>
  );
}

function initialForm(
  tab: CrmSetupTab,
  row: CrmSetupRecord | null,
): CrmForm {
  if (tab === "accountStatuses")
    return {
      ...EMPTY_CRM_FORM,
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
      ...EMPTY_CRM_FORM,
      name: row?.name ?? "",
      description: row?.description ?? "",
      sequence: row?.sequence ?? 10,
      probability: row?.probability ?? 0,
      defaultForecastCategory: row?.default_forecast_category ?? "upside",
      isClosed: row?.is_closed ?? false,
      isWon: row?.is_won ?? false,
      isDefault: row?.is_default ?? false,
      isActive: row?.is_active ?? true,
      requiresLines: row?.requires_lines === true,
      requiresPrimaryContact: row?.requires_primary_contact === true,
      requiresPositiveAmount: row?.requires_positive_amount === true,
      requiresWinLossReason: row?.requires_win_loss_reason === true,
    };
  return {
    ...EMPTY_CRM_FORM,
    name: row?.name ?? "",
    description: row?.description ?? "",
    isActive: row?.is_active ?? true,
  };
}
function actionFor(tab: CrmSetupTab) {
  return (
    {
      accountStatuses: "save-account-status",
      opportunityStatuses: "save-opportunity-status",
      sources: "save-lead-source",
    } as const
  )[tab];
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
        keys={[
          "isClosed",
          "isWon",
          "isDefault",
          "isActive",
          "requiresLines",
          "requiresPrimaryContact",
          "requiresPositiveAmount",
          "requiresWinLossReason",
        ]}
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

type FieldProps = {
  form: CrmForm;
  set: (key: string, value: unknown) => void;
  t: CrmTranslator;
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
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5 sm:col-span-2">
      <Label>{label}</Label>
      <Textarea
        rows={mono ? 7 : 3}
        className={mono ? "font-mono text-xs" : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>
      ) : null}
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
