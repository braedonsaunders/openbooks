"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
  cn,
} from "@openbooks/ui";
import {
  Bot,
  CalendarDays,
  FileOutput,
  GitBranch,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { SearchInput } from "../../../../../components/search-input";
import { Pagination } from "../../../../../components/pagination";
import { mergeHref, pickString } from "../../../../../lib/list-params";

type Row = Record<string, any>;
type ConfigListKey =
  "calendar" | "blueprint" | "policy" | "automation" | "package";
type ConfigListMeta = { page: number; total: number };
type Props = {
  currentParams: Record<string, string | string[] | undefined>;
  fiscalYear: number;
  periodPage: number;
  periodPerPage: number;
  periodTotal: number;
  configLists: Record<ConfigListKey, ConfigListMeta>;
  configPerPage: number;
  calendars: Row[];
  calendarOptions: Row[];
  periods: Row[];
  books: Row[];
  selectedBookId: string;
  canReopen: boolean;
  blueprints: Row[];
  policies: Row[];
  automations: Row[];
  packages: Row[];
  reopenRequests: Row[];
  reopenPage: number;
  reopenTotal: number;
  reopenPerPage: number;
};

const TABS = [
  "calendars",
  "periods",
  "blueprints",
  "policies",
  "automation",
  "packages",
] as const;
type Tab = (typeof TABS)[number];
const MODULES = ["ar", "ap", "banking", "assets", "tax", "gl"] as const;

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/admin/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "request failed");
  return data;
}

export function CloseSetupWorkspace(props: Props) {
  const t = useTranslations("close.setup");
  const router = useRouter();
  const rawTab = pickString(props.currentParams.tab);
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : "calendars";

  function refresh(message: string) {
    toast.success(message);
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {t("title")}
          </h2>
          <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">
            {t("description")}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={async () => {
            try {
              await post({ action: "initialize" });
              refresh(t("messages.initialized"));
            } catch {
              toast.error(t("errors.actionFailed"));
            }
          }}
        >
          <RefreshCw size={15} />
          {t("actions.restoreDefaults")}
        </Button>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
        {TABS.map((key) => (
          <Link
            key={key}
            href={
              mergeHref("/admin/setup/period-close", props.currentParams, {
                tab: key,
                periodPage: 1,
              }) as any
            }
            className={cn(
              "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === key
                ? "border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300"
                : "border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
            )}
          >
            {t(`tabs.${key}`)}
          </Link>
        ))}
      </div>

      {tab === "calendars" ? (
        <CalendarsTab
          rows={props.calendars}
          list={props.configLists.calendar}
          currentParams={props.currentParams}
          perPage={props.configPerPage}
          onSaved={refresh}
        />
      ) : null}
      {tab === "periods" ? <PeriodsTab {...props} onSaved={refresh} /> : null}
      {tab === "blueprints" ? (
        <BlueprintsTab
          rows={props.blueprints}
          list={props.configLists.blueprint}
          currentParams={props.currentParams}
          perPage={props.configPerPage}
          onSaved={refresh}
        />
      ) : null}
      {tab === "policies" ? (
        <PoliciesTab
          rows={props.policies}
          list={props.configLists.policy}
          currentParams={props.currentParams}
          perPage={props.configPerPage}
          onSaved={refresh}
        />
      ) : null}
      {tab === "automation" ? (
        <AutomationTab
          rows={props.automations}
          list={props.configLists.automation}
          currentParams={props.currentParams}
          perPage={props.configPerPage}
          onSaved={refresh}
        />
      ) : null}
      {tab === "packages" ? (
        <PackagesTab
          rows={props.packages}
          list={props.configLists.package}
          currentParams={props.currentParams}
          perPage={props.configPerPage}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}

function SectionHeading({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-teal-50 p-2 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
          {icon}
        </div>
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {description}
          </p>
        </div>
      </div>
      {action}
    </div>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}

function dataText(
  t: ReturnType<typeof useTranslations>,
  value: string | null | undefined,
): string {
  if (!value) return "";
  return value.startsWith("close.") ? t(value.slice(6) as any) : value;
}

function ConfigListControls({
  listKey,
  list,
  currentParams,
  perPage,
}: {
  listKey: ConfigListKey;
  list: ConfigListMeta;
  currentParams: Props["currentParams"];
  perPage: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2 dark:border-slate-800 dark:bg-slate-900">
      <SearchInput paramKey={`${listKey}Q`} pageParamKey={`${listKey}Page`} />
      <Pagination
        basePath="/admin/setup/period-close"
        currentParams={currentParams}
        total={list.total}
        page={list.page}
        perPage={perPage}
        pageParamKey={`${listKey}Page`}
      />
    </div>
  );
}

function CalendarsTab({
  rows,
  list,
  currentParams,
  perPage,
  onSaved,
}: {
  rows: Row[];
  list: ConfigListMeta;
  currentParams: Props["currentParams"];
  perPage: number;
  onSaved: (message: string) => void;
}) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const empty = {
    name: "",
    cadence: "monthly",
    yearStartMonth: 1,
    weekStartsOn: 1,
    timeZone: "UTC",
    adjustmentPeriodEnabled: false,
    isDefault: false,
    isActive: true,
    anchorDate: "",
    configText: "{}",
  };
  const [draft, setDraft] = useState<Row>(empty);
  const [busy, setBusy] = useState(false);
  function edit(row?: Row) {
    setDraft(
      row
        ? {
            id: row.id,
            name: dataText(td, row.name),
            cadence: row.cadence,
            yearStartMonth: row.year_start_month,
            weekStartsOn: row.week_starts_on,
            timeZone: row.time_zone,
            adjustmentPeriodEnabled: row.adjustment_period_enabled,
            isDefault: row.is_default,
            isActive: row.is_active,
            anchorDate: row.anchor_date ?? "",
            configText: JSON.stringify(row.config ?? {}, null, 2),
          }
        : empty,
    );
  }
  async function save() {
    setBusy(true);
    try {
      await post({
        action: "save-calendar",
        ...draft,
        config: JSON.parse(draft.configText || "{}"),
      });
      onSaved(t("messages.calendarSaved"));
    } catch {
      toast.error(t("errors.invalidConfiguration"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
      <div className="space-y-3">
        <SectionHeading
          icon={<CalendarDays size={18} />}
          title={t("calendars.title")}
          description={t("calendars.description")}
          action={
            <Button size="sm" onClick={() => edit()}>
              <Plus size={14} />
              {t("actions.newCalendar")}
            </Button>
          }
        />
        <ConfigListControls
          listKey="calendar"
          list={list}
          currentParams={currentParams}
          perPage={perPage}
        />
        {rows.map((row) => (
          <Card
            key={row.id}
            interactive
            onClick={() => edit(row)}
            className={cn(
              draft.id === row.id && "border-teal-400 ring-1 ring-teal-300/40",
            )}
          >
            <CardHeader className="p-4">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">
                  {dataText(td, row.name)}
                </CardTitle>
                <div className="flex gap-1">
                  {row.is_default ? (
                    <Badge variant="success">{t("labels.default")}</Badge>
                  ) : null}
                  {!row.is_active ? (
                    <Badge variant="outline">{t("labels.inactive")}</Badge>
                  ) : null}
                </div>
              </div>
              <CardDescription>
                {t(`cadences.${row.cadence}`)} ·{" "}
                {t("calendars.startsMonth", { month: row.year_start_month })}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            {draft.id ? t("calendars.editTitle") : t("calendars.newTitle")}
          </CardTitle>
          <CardDescription>{t("calendars.formDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label={t("fields.name")}>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field label={t("fields.cadence")}>
            <Select
              value={draft.cadence}
              onChange={(e) => setDraft({ ...draft, cadence: e.target.value })}
            >
              {[
                "monthly",
                "four_four_five",
                "four_five_four",
                "five_four_four",
                "thirteen_period",
                "custom",
              ].map((value) => (
                <option key={value} value={value}>
                  {t(`cadences.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("fields.yearStartMonth")}>
              <Input
                type="number"
                min={1}
                max={12}
                value={draft.yearStartMonth}
                onChange={(e) =>
                  setDraft({ ...draft, yearStartMonth: Number(e.target.value) })
                }
              />
            </Field>
            <Field label={t("fields.weekStartsOn")}>
              <Select
                value={draft.weekStartsOn}
                onChange={(e) =>
                  setDraft({ ...draft, weekStartsOn: Number(e.target.value) })
                }
              >
                {[0, 1, 2, 3, 4, 5, 6].map((value) => (
                  <option key={value} value={value}>
                    {t(`weekdays.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {draft.cadence !== "monthly" && draft.cadence !== "custom" ? (
            <Field
              label={t("fields.anchorDate")}
              hint={t("calendars.anchorHint")}
            >
              <Input
                type="date"
                value={draft.anchorDate}
                onChange={(e) =>
                  setDraft({ ...draft, anchorDate: e.target.value })
                }
              />
            </Field>
          ) : null}
          <Field label={t("fields.timeZone")}>
            <Input
              value={draft.timeZone}
              onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })}
            />
          </Field>
          <Field
            label={t("fields.configuration")}
            hint={t("calendars.configurationHint")}
          >
            <Textarea
              className="font-mono text-xs"
              rows={6}
              value={draft.configText}
              onChange={(e) =>
                setDraft({ ...draft, configText: e.target.value })
              }
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={draft.adjustmentPeriodEnabled}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  adjustmentPeriodEnabled: e.target.checked,
                })
              }
            />
            {t("fields.adjustmentPeriod")}
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={draft.isDefault}
              onChange={(e) =>
                setDraft({ ...draft, isDefault: e.target.checked })
              }
            />
            {t("fields.defaultCalendar")}
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={draft.isActive}
              onChange={(e) =>
                setDraft({ ...draft, isActive: e.target.checked })
              }
            />
            {t("fields.active")}
          </label>
          <Button disabled={busy || !draft.name} onClick={save}>
            <Save size={15} />
            {busy ? t("actions.saving") : t("actions.save")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function PeriodsTab(props: Props & { onSaved: (message: string) => void }) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const router = useRouter();
  const selectedBook =
    props.books.find((book) => book.id === props.selectedBookId) ??
    props.books[0];
  const [calendarId, setCalendarId] = useState(
    props.calendarOptions.find((row) => row.is_default)?.id ??
      props.calendarOptions[0]?.id ??
      "",
  );
  const [generateYear, setGenerateYear] = useState(props.fiscalYear);
  const [lockAction, setLockAction] = useState<{
    period: Row;
    module: string;
    state: string;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function generate() {
    setBusy(true);
    try {
      await post({
        action: "generate-periods",
        calendarId,
        fiscalYear: generateYear,
      });
      props.onSaved(t("messages.periodsGenerated"));
    } catch {
      toast.error(t("errors.actionFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function applyLock() {
    if (!lockAction || !selectedBook || !reason.trim()) return;
    setBusy(true);
    try {
      if (lockAction.state === "reopen")
        await post({
          action: "request-reopen",
          periodId: lockAction.period.id,
          bookId: selectedBook.id,
          modules: [lockAction.module],
          reason,
        });
      else
        await post({
          action: "set-lock",
          periodId: lockAction.period.id,
          bookId: selectedBook.id,
          module: lockAction.module,
          state: lockAction.state,
          reason,
        });
      setLockAction(null);
      setReason("");
      props.onSaved(
        lockAction.state === "reopen"
          ? t("messages.reopenRequested")
          : t("messages.lockSaved"),
      );
    } catch {
      toast.error(t("errors.actionFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function decideReopen(requestId: string, approve: boolean) {
    setBusy(true);
    try {
      await post({ action: "decide-reopen", requestId, approve });
      props.onSaved(
        t(approve ? "messages.reopenApproved" : "messages.reopenRejected"),
      );
    } catch {
      toast.error(t("errors.actionFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <SectionHeading
        icon={<LockKeyhole size={18} />}
        title={t("periods.title")}
        description={t("periods.description")}
      />
      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
          <Field label={t("fields.calendar")}>
            <Select
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
            >
              {props.calendarOptions
                .filter((row) => row.is_active)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {dataText(td, row.name)}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t("fields.fiscalYear")}>
            <Input
              type="number"
              value={generateYear}
              onChange={(e) => setGenerateYear(Number(e.target.value))}
            />
          </Field>
          <Button disabled={busy || !calendarId} onClick={generate}>
            <CalendarDays size={15} />
            {t("actions.generate")}
          </Button>
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SearchInput
          paramKey="periodQ"
          pageParamKey="periodPage"
          placeholder={t("periods.searchPlaceholder")}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Label>{t("fields.book")}</Label>
          <Select
            className="h-8 w-44"
            value={props.selectedBookId}
            onChange={(e) =>
              router.push(
                mergeHref("/admin/setup/period-close", props.currentParams, {
                  tab: "periods",
                  book: e.target.value,
                  periodPage: 1,
                }),
              )
            }
          >
            {props.books.map((book) => (
              <option key={book.id} value={book.id}>
                {book.name}
              </option>
            ))}
          </Select>
          <Label>{t("fields.fiscalYear")}</Label>
          <Input
            className="h-8 w-28"
            type="number"
            value={props.fiscalYear}
            onChange={(e) =>
              router.push(
                mergeHref("/admin/setup/period-close", props.currentParams, {
                  tab: "periods",
                  fy: e.target.value,
                  periodPage: 1,
                }),
              )
            }
          />
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("table.period")}</TableHead>
                <TableHead>{t("table.range")}</TableHead>
                <TableHead className="text-right">
                  {t("table.entries")}
                </TableHead>
                {MODULES.map((module) => (
                  <TableHead key={module}>{t(`modules.${module}`)}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.periods.map((period) => (
                <TableRow key={period.id}>
                  <TableCell>
                    <div className="font-medium">{period.name}</div>
                    <div className="text-xs text-slate-500">
                      {dataText(td, period.calendar_name)}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-slate-500">
                    {period.starts_on} → {period.ends_on}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {Number(period.entries).toLocaleString()}
                  </TableCell>
                  {MODULES.map((module) => {
                    const state = period.locks?.[module]?.state ?? "open";
                    return (
                      <TableCell key={module}>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge
                            variant={
                              state === "closed"
                                ? "success"
                                : state === "soft_closed"
                                  ? "warning"
                                  : "outline"
                            }
                          >
                            {t(`states.${state}`)}
                          </Badge>
                          {state === "open" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              onClick={() =>
                                setLockAction({
                                  period,
                                  module,
                                  state: "soft_closed",
                                })
                              }
                            >
                              {t("actions.softClose")}
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            disabled={state === "closed" && !props.canReopen}
                            onClick={() =>
                              setLockAction({
                                period,
                                module,
                                state: state === "closed" ? "reopen" : "closed",
                              })
                            }
                          >
                            {state === "closed"
                              ? t("actions.reopen")
                              : t("actions.close")}
                          </Button>
                        </div>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Pagination
          basePath="/admin/setup/period-close"
          currentParams={props.currentParams}
          total={props.periodTotal}
          page={props.periodPage}
          perPage={props.periodPerPage}
          pageParamKey="periodPage"
        />
      </div>
      {lockAction ? (
        <Card className="border-teal-300">
          <CardHeader>
            <CardTitle className="text-base">
              {lockAction.state === "reopen"
                ? t("periods.reopenTitle")
                : t("periods.lockTitle")}
            </CardTitle>
            <CardDescription>
              {t("periods.lockDescription", {
                period: lockAction.period.name,
                module: t(`modules.${lockAction.module}`),
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label={t("fields.reason")}>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <div className="flex gap-2">
              <Button disabled={busy || !reason.trim()} onClick={applyLock}>
                {lockAction.state === "reopen"
                  ? t("actions.requestReopen")
                  : t("actions.confirmClose")}
              </Button>
              <Button variant="outline" onClick={() => setLockAction(null)}>
                {t("actions.cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
      {props.reopenTotal > 0 || pickString(props.currentParams.reopenQ) ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("periods.reopenRequests")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <SearchInput paramKey="reopenQ" pageParamKey="reopenPage" />
              <Pagination
                basePath="/admin/setup/period-close"
                currentParams={props.currentParams}
                total={props.reopenTotal}
                page={props.reopenPage}
                perPage={props.reopenPerPage}
                pageParamKey="reopenPage"
              />
            </div>
            <div className="space-y-2">
              {props.reopenRequests.map((row) => (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-800"
                >
                  <div>
                    <span className="font-medium">{row.period_name}</span> ·{" "}
                    {row.book_name}
                    <p className="text-slate-500">{row.reason}</p>
                    <p className="text-xs text-slate-400">
                      {t("periods.requestedBy", { name: row.requester_name })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        row.status === "approved"
                          ? "success"
                          : row.status === "requested"
                            ? "warning"
                            : "outline"
                      }
                    >
                      {t(`reopenStates.${row.status}`)}
                    </Badge>
                    {row.status === "requested" && props.canReopen ? (
                      <>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => decideReopen(row.id, true)}
                        >
                          {t("actions.approve")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => decideReopen(row.id, false)}
                        >
                          {t("actions.reject")}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function BlueprintsTab({
  rows,
  list,
  currentParams,
  perPage,
  onSaved,
}: {
  rows: Row[];
  list: ConfigListMeta;
  currentParams: Props["currentParams"];
  perPage: number;
  onSaved: (message: string) => void;
}) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const empty = {
    name: "",
    description: "",
    periodType: "any",
    isDefault: false,
    steps: [] as Row[],
  };
  const [draft, setDraft] = useState<Row>(empty);
  const [busy, setBusy] = useState(false);
  function edit(row?: Row) {
    setDraft(
      row
        ? {
            id: row.id,
            name: dataText(td, row.name),
            description: dataText(td, row.description),
            periodType: row.period_type,
            isDefault: row.is_default,
            steps: row.steps.map((step: Row) => ({
              key: step.key,
              title: step.title,
              description: step.description ?? "",
              workstream: step.workstream,
              taskType: step.task_type,
              completionMode: step.completion_mode,
              gateType: step.gate_type,
              dueOffsetBusinessDays: step.due_offset_business_days,
              evidenceRequired: step.evidence_required,
              defaultOwnerRoleKey: step.default_owner_role_key ?? "",
              defaultReviewerRoleKey: step.default_reviewer_role_key ?? "",
              applicabilityText: JSON.stringify(
                step.applicability ?? {},
                null,
                2,
              ),
              dependsOn: step.depends_on ?? [],
            })),
          }
        : empty,
    );
  }
  function addStep() {
    setDraft({
      ...draft,
      steps: [
        ...draft.steps,
        {
          key: `step-${draft.steps.length + 1}`,
          title: "",
          description: "",
          workstream: "gl",
          taskType: "action",
          completionMode: "manual",
          gateType: "none",
          dueOffsetBusinessDays: 0,
          evidenceRequired: false,
          defaultOwnerRoleKey: "",
          defaultReviewerRoleKey: "",
          applicabilityText: "{}",
          dependsOn: [],
        },
      ],
    });
  }
  function updateStep(index: number, changes: Row) {
    setDraft({
      ...draft,
      steps: draft.steps.map((step: Row, i: number) =>
        i === index ? { ...step, ...changes } : step,
      ),
    });
  }
  async function save() {
    setBusy(true);
    try {
      await post({
        action: "save-blueprint",
        ...draft,
        steps: draft.steps.map((step: Row) => ({
          ...step,
          applicability: JSON.parse(step.applicabilityText || "{}"),
        })),
      });
      onSaved(t("messages.blueprintSaved"));
    } catch {
      toast.error(t("errors.invalidConfiguration"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <SectionHeading
        icon={<GitBranch size={18} />}
        title={t("blueprints.title")}
        description={t("blueprints.description")}
        action={
          <Button size="sm" onClick={() => edit()}>
            <Plus size={14} />
            {t("actions.newBlueprint")}
          </Button>
        }
      />
      <ConfigListControls
        listKey="blueprint"
        list={list}
        currentParams={currentParams}
        perPage={perPage}
      />
      <div className="grid gap-3 md:grid-cols-2">
        {rows
          .filter((row) => row.is_active)
          .map((row) => (
            <Card key={row.id} interactive onClick={() => edit(row)}>
              <CardHeader className="p-4">
                <div className="flex justify-between gap-2">
                  <CardTitle className="text-base">
                    {dataText(td, row.name)}{" "}
                    <span className="text-xs font-normal text-slate-400">
                      v{row.version}
                    </span>
                  </CardTitle>
                  {row.is_default ? (
                    <Badge variant="success">{t("labels.default")}</Badge>
                  ) : null}
                </div>
                <CardDescription>
                  {dataText(td, row.description)}
                </CardDescription>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="flex gap-3 text-xs text-slate-500">
                  <span>
                    {t("blueprints.stepCount", { count: row.steps.length })}
                  </span>
                  <span>{t(`periodTypes.${row.period_type}`)}</span>
                </div>
              </CardContent>
            </Card>
          ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            {draft.id
              ? t("blueprints.newVersionTitle")
              : t("blueprints.newTitle")}
          </CardTitle>
          <CardDescription>{t("blueprints.versionHint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t("fields.name")}>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label={t("fields.periodType")}>
              <Select
                value={draft.periodType}
                onChange={(e) =>
                  setDraft({ ...draft, periodType: e.target.value })
                }
              >
                {["any", "month", "quarter", "year", "adjustment"].map(
                  (value) => (
                    <option key={value} value={value}>
                      {t(`periodTypes.${value}`)}
                    </option>
                  ),
                )}
              </Select>
            </Field>
          </div>
          <Field label={t("fields.description")}>
            <Textarea
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </Field>
          <div className="flex items-center justify-between">
            <Label>{t("blueprints.steps")}</Label>
            <Button variant="outline" size="sm" onClick={addStep}>
              <Plus size={14} />
              {t("actions.addStep")}
            </Button>
          </div>
          <div className="space-y-3">
            {draft.steps.map((step: Row, index: number) => (
              <div
                key={index}
                className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
              >
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label={t("fields.stepKey")}>
                    <Input
                      value={step.key}
                      onChange={(e) =>
                        updateStep(index, { key: e.target.value })
                      }
                    />
                  </Field>
                  <Field label={t("fields.stepTitle")}>
                    <Input
                      value={step.title}
                      onChange={(e) =>
                        updateStep(index, { title: e.target.value })
                      }
                    />
                  </Field>
                  <Field label={t("fields.workstream")}>
                    <Select
                      value={step.workstream}
                      onChange={(e) =>
                        updateStep(index, { workstream: e.target.value })
                      }
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
                      onChange={(e) =>
                        updateStep(index, { taskType: e.target.value })
                      }
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
                      onChange={(e) =>
                        updateStep(index, { gateType: e.target.value })
                      }
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
                      onChange={(e) =>
                        updateStep(index, { completionMode: e.target.value })
                      }
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
                      onChange={(e) =>
                        updateStep(index, {
                          defaultOwnerRoleKey: e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field label={t("fields.reviewerRole")}>
                    <Input
                      value={step.defaultReviewerRoleKey}
                      onChange={(e) =>
                        updateStep(index, {
                          defaultReviewerRoleKey: e.target.value,
                        })
                      }
                    />
                  </Field>
                  <Field label={t("fields.applicability")}>
                    <Textarea
                      className="font-mono text-xs"
                      rows={4}
                      value={step.applicabilityText}
                      onChange={(e) =>
                        updateStep(index, { applicabilityText: e.target.value })
                      }
                    />
                  </Field>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={step.evidenceRequired}
                      onChange={(e) =>
                        updateStep(index, {
                          evidenceRequired: e.target.checked,
                        })
                      }
                    />
                    {t("fields.evidenceRequired")}
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        steps: draft.steps.filter(
                          (_: Row, i: number) => i !== index,
                        ),
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
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.isDefault}
              onChange={(e) =>
                setDraft({ ...draft, isDefault: e.target.checked })
              }
            />
            {t("fields.defaultBlueprint")}
          </label>
          <Button
            disabled={busy || !draft.name || draft.steps.length === 0}
            onClick={save}
          >
            <Save size={15} />
            {t("actions.saveVersion")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function JsonResourceForm({
  kind,
  initial,
  onSaved,
}: {
  kind: "policy" | "automation";
  initial?: Row;
  onSaved: (message: string) => void;
}) {
  const t = useTranslations("close.setup");
  const isPolicy = kind === "policy";
  const [draft, setDraft] = useState<Row>(
    initial ??
      (isPolicy
        ? {
            code: "",
            name: "",
            description: "",
            policyType: "materiality",
            rulesText: "{}",
            isActive: true,
          }
        : {
            name: "",
            trigger: "run_started",
            automationAction: "notify",
            conditionsText: "{}",
            configText: "{}",
            isActive: true,
          }),
  );
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const body = isPolicy
        ? {
            action: "save-policy",
            ...draft,
            rules: JSON.parse(draft.rulesText || "{}"),
          }
        : {
            action: "save-automation",
            ...draft,
            conditions: JSON.parse(draft.conditionsText || "{}"),
            config: JSON.parse(draft.configText || "{}"),
          };
      await post(body);
      onSaved(
        isPolicy ? t("messages.policySaved") : t("messages.automationSaved"),
      );
    } catch {
      toast.error(t("errors.invalidConfiguration"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {isPolicy ? t("policies.formTitle") : t("automation.formTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isPolicy ? (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t("fields.code")}>
                <Input
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                />
              </Field>
              <Field label={t("fields.policyType")}>
                <Select
                  value={draft.policyType}
                  onChange={(e) =>
                    setDraft({ ...draft, policyType: e.target.value })
                  }
                >
                  {[
                    "materiality",
                    "lock",
                    "review",
                    "segregation",
                    "exception",
                  ].map((value) => (
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
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
            </Field>
            <Field label={t("fields.rules")} hint={t("policies.rulesHint")}>
              <Textarea
                className="font-mono text-xs"
                rows={6}
                value={draft.rulesText}
                onChange={(e) =>
                  setDraft({ ...draft, rulesText: e.target.value })
                }
              />
            </Field>
          </>
        ) : (
          <>
            <Field label={t("fields.name")}>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t("fields.trigger")}>
                <Select
                  value={draft.trigger}
                  onChange={(e) =>
                    setDraft({ ...draft, trigger: e.target.value })
                  }
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
                    setDraft({ ...draft, automationAction: e.target.value })
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
                  ].map((value) => (
                    <option key={value} value={value}>
                      {t(`automationActions.${value}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={t("fields.conditions")}>
              <Textarea
                className="font-mono text-xs"
                rows={4}
                value={draft.conditionsText}
                onChange={(e) =>
                  setDraft({ ...draft, conditionsText: e.target.value })
                }
              />
            </Field>
            <Field label={t("fields.configuration")}>
              <Textarea
                className="font-mono text-xs"
                rows={4}
                value={draft.configText}
                onChange={(e) =>
                  setDraft({ ...draft, configText: e.target.value })
                }
              />
            </Field>
          </>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.isActive !== false}
            onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
          />
          {t("fields.active")}
        </label>
        <Button disabled={busy || !draft.name} onClick={save}>
          <Save size={15} />
          {t("actions.save")}
        </Button>
      </CardContent>
    </Card>
  );
}

function PoliciesTab({
  rows,
  list,
  currentParams,
  perPage,
  onSaved,
}: {
  rows: Row[];
  list: ConfigListMeta;
  currentParams: Props["currentParams"];
  perPage: number;
  onSaved: (message: string) => void;
}) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const [selected, setSelected] = useState<Row | undefined>();
  return (
    <div className="space-y-5">
      <SectionHeading
        icon={<ShieldCheck size={18} />}
        title={t("policies.title")}
        description={t("policies.description")}
        action={
          <Button size="sm" onClick={() => setSelected(undefined)}>
            <Plus size={14} />
            {t("actions.newPolicy")}
          </Button>
        }
      />
      <ConfigListControls
        listKey="policy"
        list={list}
        currentParams={currentParams}
        perPage={perPage}
      />
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((row) => (
          <Card
            key={row.id}
            interactive
            onClick={() =>
              setSelected({
                id: row.id,
                code: row.code,
                name: dataText(td, row.name),
                description: dataText(td, row.description),
                policyType: row.policy_type,
                rulesText: JSON.stringify(row.rules, null, 2),
                isActive: row.is_active,
              })
            }
          >
            <CardHeader className="p-4">
              <div className="flex justify-between">
                <CardTitle className="text-base">
                  {dataText(td, row.name)}
                </CardTitle>
                <Badge variant={row.is_active ? "success" : "outline"}>
                  {t(row.is_active ? "labels.active" : "labels.inactive")}
                </Badge>
              </div>
              <CardDescription>
                {t(`policyTypes.${row.policy_type}`)} · {row.code}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
      <JsonResourceForm
        key={selected?.id ?? "new"}
        kind="policy"
        initial={selected}
        onSaved={onSaved}
      />
    </div>
  );
}

function AutomationTab({
  rows,
  list,
  currentParams,
  perPage,
  onSaved,
}: {
  rows: Row[];
  list: ConfigListMeta;
  currentParams: Props["currentParams"];
  perPage: number;
  onSaved: (message: string) => void;
}) {
  const t = useTranslations("close.setup");
  const [selected, setSelected] = useState<Row | undefined>();
  return (
    <div className="space-y-5">
      <SectionHeading
        icon={<Bot size={18} />}
        title={t("automation.title")}
        description={t("automation.description")}
        action={
          <Button size="sm" onClick={() => setSelected(undefined)}>
            <Plus size={14} />
            {t("actions.newAutomation")}
          </Button>
        }
      />
      <ConfigListControls
        listKey="automation"
        list={list}
        currentParams={currentParams}
        perPage={perPage}
      />
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((row) => (
          <Card
            key={row.id}
            interactive
            onClick={() =>
              setSelected({
                id: row.id,
                name: row.name,
                trigger: row.trigger,
                automationAction: row.action,
                conditionsText: JSON.stringify(row.conditions, null, 2),
                configText: JSON.stringify(row.config, null, 2),
                isActive: row.is_active,
              })
            }
          >
            <CardHeader className="p-4">
              <div className="flex justify-between">
                <CardTitle className="text-base">{row.name}</CardTitle>
                <Badge variant={row.is_active ? "success" : "outline"}>
                  {t(row.is_active ? "labels.active" : "labels.inactive")}
                </Badge>
              </div>
              <CardDescription>
                {t(`automationTriggers.${row.trigger}`)} →{" "}
                {t(`automationActions.${row.action}`)}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
      <JsonResourceForm
        key={selected?.id ?? "new"}
        kind="automation"
        initial={selected}
        onSaved={onSaved}
      />
    </div>
  );
}

function PackagesTab({
  rows,
  list,
  currentParams,
  perPage,
  onSaved,
}: {
  rows: Row[];
  list: ConfigListMeta;
  currentParams: Props["currentParams"];
  perPage: number;
  onSaved: (message: string) => void;
}) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const reportOptions = [
    "balance-sheet",
    "pnl",
    "cash-flow",
    "trial-balance",
    "general-ledger",
  ];
  const [draft, setDraft] = useState<Row>({
    name: "",
    description: "",
    reports: reportOptions,
    recipientsText: "",
    deliveryText: "{}",
    isDefault: false,
    isActive: true,
  });
  const [busy, setBusy] = useState(false);
  function edit(row?: Row) {
    setDraft(
      row
        ? {
            id: row.id,
            name: dataText(td, row.name),
            description: dataText(td, row.description),
            reports: row.reports ?? [],
            recipientsText: (row.recipients ?? []).join("\n"),
            deliveryText: JSON.stringify(row.delivery ?? {}, null, 2),
            isDefault: row.is_default,
            isActive: row.is_active,
          }
        : {
            name: "",
            description: "",
            reports: reportOptions,
            recipientsText: "",
            deliveryText: "{}",
            isDefault: false,
            isActive: true,
          },
    );
  }
  async function save() {
    setBusy(true);
    try {
      await post({
        action: "save-package",
        ...draft,
        delivery: JSON.parse(draft.deliveryText || "{}"),
        recipients: draft.recipientsText
          .split("\n")
          .map((value: string) => value.trim())
          .filter(Boolean),
      });
      onSaved(t("messages.packageSaved"));
    } catch {
      toast.error(t("errors.invalidConfiguration"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <SectionHeading
        icon={<FileOutput size={18} />}
        title={t("packages.title")}
        description={t("packages.description")}
        action={
          <Button size="sm" onClick={() => edit()}>
            <Plus size={14} />
            {t("actions.newPackage")}
          </Button>
        }
      />
      <ConfigListControls
        listKey="package"
        list={list}
        currentParams={currentParams}
        perPage={perPage}
      />
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((row) => (
          <Card key={row.id} interactive onClick={() => edit(row)}>
            <CardHeader className="p-4">
              <div className="flex justify-between">
                <CardTitle className="text-base">
                  {dataText(td, row.name)}
                </CardTitle>
                {row.is_default ? (
                  <Badge variant="success">{t("labels.default")}</Badge>
                ) : null}
              </div>
              <CardDescription>
                {t("packages.reportCount", { count: row.reports?.length ?? 0 })}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("packages.formTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label={t("fields.name")}>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field label={t("fields.description")}>
            <Textarea
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </Field>
          <Field label={t("fields.reports")}>
            <div className="grid gap-2 sm:grid-cols-2">
              {reportOptions.map((report) => (
                <label key={report} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.reports.includes(report)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        reports: e.target.checked
                          ? [...draft.reports, report]
                          : draft.reports.filter(
                              (item: string) => item !== report,
                            ),
                      })
                    }
                  />
                  {t(`reports.${report}`)}
                </label>
              ))}
            </div>
          </Field>
          <Field
            label={t("fields.recipients")}
            hint={t("packages.recipientsHint")}
          >
            <Textarea
              value={draft.recipientsText}
              onChange={(e) =>
                setDraft({ ...draft, recipientsText: e.target.value })
              }
            />
          </Field>
          <Field label={t("fields.delivery")}>
            <Textarea
              className="font-mono text-xs"
              rows={5}
              value={draft.deliveryText}
              onChange={(e) =>
                setDraft({ ...draft, deliveryText: e.target.value })
              }
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.isDefault}
              onChange={(e) =>
                setDraft({ ...draft, isDefault: e.target.checked })
              }
            />
            {t("fields.defaultPackage")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.isActive}
              onChange={(e) =>
                setDraft({ ...draft, isActive: e.target.checked })
              }
            />
            {t("fields.active")}
          </label>
          <Button disabled={busy || !draft.name} onClick={save}>
            <Save size={15} />
            {t("actions.save")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
