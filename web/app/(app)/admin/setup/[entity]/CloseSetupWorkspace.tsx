"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
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
  SearchSelect,
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
import {
  Bot,
  CalendarDays,
  ChevronRight,
  FileOutput,
  GitBranch,
  LockKeyhole,
  Plus,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  PERIOD_PRESETS,
  PERIOD_PRESET_GROUP_LABELS,
} from "@openbooks/reports";
import { SearchInput } from "../../../../../components/search-input";
import { Pagination } from "../../../../../components/pagination";
import { mergeHref, pickString } from "../../../../../lib/list-params";
import type { ReportDescriptor } from "../../../../../lib/close/report-descriptor";

type Row = Record<string, any>;
type ConfigListKey = "calendar" | "blueprint" | "policy" | "automation" | "package";
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
  users: Row[];
  roles: Row[];
  reportDefs: Row[];
  subsidiaries: Row[];
  dimensions: {
    departments: Row[];
    projects: Row[];
    locations: Row[];
    classes: Row[];
  };
  reopenRequests: Row[];
  reopenPage: number;
  reopenTotal: number;
  reopenPerPage: number;
  advancedClose: boolean;
};

const BASE = "/admin/setup/period-close";
const TABS = ["calendars", "periods", "blueprints", "policies", "automation", "packages"] as const;
type Tab = (typeof TABS)[number];
const MODULES = ["ar", "ap", "banking", "assets", "tax", "gl"] as const;

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/admin/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "request failed");
  return data;
}

function dataText(t: ReturnType<typeof useTranslations>, value: string | null | undefined) {
  if (!value) return "";
  return value.startsWith("close.") ? t((value.slice(6))) : value;
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  // Descriptive hints live in the label's `?` popover (FieldLabel); inline
  // text under a control is reserved for validation/state messages.
  return <div className="space-y-1.5"><Label help={hint}>{label}</Label>{children}</div>;
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: React.ReactNode }) {
  return <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{children}</label>;
}

function SectionHeading({ icon, title, description, action }: { icon: React.ReactNode; title: string; description: string; action?: React.ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><div className="rounded-lg bg-teal-50 p-2 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">{icon}</div><div><h3 className="font-semibold text-slate-900 dark:text-slate-100">{title}</h3><p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">{description}</p></div></div>{action}</div>;
}

type Option = { value: string; label: string; group?: string };

/** Checkbox chips for a fixed, short list of values (statuses, workstreams…). */
function Chips({ options, value, onChange }: { options: Option[]; value: string[]; onChange: (next: string[]) => void }) {
  return <div className="flex flex-wrap gap-1.5">{options.map((option) => { const on = value.includes(option.value); return <label key={option.value} className={cn("flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors", on ? "border-teal-500 bg-teal-50 text-teal-800 dark:border-teal-500 dark:bg-teal-950/40 dark:text-teal-200" : "border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300")}><input type="checkbox" className="sr-only" checked={on} onChange={(event) => onChange(event.target.checked ? [...value, option.value] : value.filter((item) => item !== option.value))} />{option.label}</label>; })}</div>;
}

/** Searchable add-and-remove token list backed by a large/grouped option set
 * (people, roles, reports). Selected values render as removable chips. */
function TokenSelect({ options, value, onChange, placeholder, empty }: { options: Option[]; value: string[]; onChange: (next: string[]) => void; placeholder?: string; empty?: string }) {
  const byValue = new Map(options.map((option) => [option.value, option]));
  const available = options.filter((option) => !value.includes(option.value));
  return <div className="space-y-2">
    <SearchSelect value="" onChange={(next) => { if (next && !value.includes(next)) onChange([...value, next]); }} options={available} placeholder={placeholder} searchable emptyLabel={empty} ariaLabel={placeholder} />
    {value.length > 0 ? <div className="flex flex-wrap gap-1.5">{value.map((item) => <span key={item} className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">{byValue.get(item)?.label ?? item}<button type="button" onClick={() => onChange(value.filter((value) => value !== item))} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"><X size={12} /></button></span>)}</div> : null}
  </div>;
}

/** Friendly replacement for a raw-JSON object field: rows of key/value pairs.
 * Only used for policy/delivery shapes that have no dedicated engine schema. */
function KeyValueRows({ rows, onChange }: { rows: Array<{ key: string; value: string }>; onChange: (next: Array<{ key: string; value: string }>) => void }) {
  const t = useTranslations("close.setup");
  return <div className="space-y-2">{rows.map((row, index) => <div key={index} className="flex items-center gap-2"><Input className="flex-1" placeholder={t("kv.key")} value={row.key} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} /><Input className="flex-1" placeholder={t("kv.value")} value={row.value} onChange={(event) => onChange(rows.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} /><Button variant="ghost" size="sm" onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2 size={14} /></Button></div>)}<Button variant="outline" size="sm" onClick={() => onChange([...rows, { key: "", value: "" }])}><Plus size={14} />{t("kv.add")}</Button></div>;
}

/** Coerce a stored jsonb object into editable key/value rows, and back. */
function objectToRows(value: unknown): Array<{ key: string; value: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([key, raw]) => ({ key, value: typeof raw === "string" ? raw : JSON.stringify(raw) }));
}
function rowsToObject(rows: Array<{ key: string; value: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of rows) { const trimmed = key.trim(); if (!trimmed) continue; let parsed: unknown = value; if (value === "true") parsed = true; else if (value === "false") parsed = false; else if (value !== "" && !Number.isNaN(Number(value))) parsed = Number(value); out[trimmed] = parsed; }
  return out;
}
function numberOrUndefined(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" && value ? [value] : [];
}
/** Drop empty strings, nullish, and empty arrays so engine `?? fallback`
 * defaults still apply (an empty title must not overwrite the rule name). */
function pruneEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === "" || value == null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/** One report attached to a reporting package, with the author's overrides for
 * the date range, break-out dimension, and dimension filters it should run
 * with when the package is delivered. */
type ReportAttachment = {
  slug: string;
  period?: string;
  from?: string;
  to?: string;
  breakout?: string;
  departmentId?: string;
  locationId?: string;
  classId?: string;
  projectId?: string;
  subsidiaryId?: string;
};

function normalizeAttachments(raw: unknown): ReportAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => item && typeof item === "object" ? { ...(item as ReportAttachment) } : null)
    .filter((item): item is ReportAttachment => Boolean(item && item.slug));
}

const BREAKOUT_DIMENSIONS = ["none", "department", "location", "class", "project", "month", "quarter"] as const;

/** Period presets (~50) plus a leading token that follows whatever period is
 * being closed, and a trailing custom range. */
function periodOptions(closeLabel: string, customLabel: string): Option[] {
  return [
    { value: "$close", label: closeLabel },
    ...PERIOD_PRESETS.map((preset) => ({ value: preset.id, label: preset.label, group: PERIOD_PRESET_GROUP_LABELS[preset.group] })),
    { value: "custom", label: customLabel },
  ];
}

const RUN_STATUSES = ["draft", "in_progress", "review", "approved", "closed", "published", "cancelled"] as const;
const TASK_STATUSES = ["blocked", "ready", "in_progress", "submitted", "changes_requested", "complete", "waived", "invalidated"] as const;
const SEVERITIES = ["info", "warning", "error", "critical"] as const;
const ALL_WORKSTREAMS = ["readiness", "banking", "ar", "ap", "assets", "tax", "payroll", "intercompany", "gl", "review", "publish"] as const;

function ConfigListControls({ listKey, list, currentParams, perPage }: { listKey: ConfigListKey; list: ConfigListMeta; currentParams: Props["currentParams"]; perPage: number }) {
  return <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-64 max-w-md flex-1"><SearchInput paramKey={`${listKey}Q`} pageParamKey={`${listKey}Page`} /></div><Pagination basePath={BASE} currentParams={currentParams} total={list.total} page={list.page} perPage={perPage} pageParamKey={`${listKey}Page`} /></div>;
}

function EmptyList({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 px-5 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">{children}</div>;
}

function drawerHref(params: Props["currentParams"], tab: Tab, key: string, value: string | null) {
  return mergeHref(BASE, params, { tab, [key]: value });
}

function RowLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={(href)} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"><Card interactive>{children}</Card></Link>;
}

export function CloseSetupWorkspace(props: Props) {
  const t = useTranslations("close.setup");
  const visibleTabs: readonly Tab[] = props.advancedClose ? TABS : ["calendars", "periods"];
  const rawTab = pickString(props.currentParams.tab);
  const tab: Tab = visibleTabs.includes(rawTab as Tab) ? rawTab as Tab : "calendars";
  return <div className="space-y-5">
    <div><h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t("title")}</h2><p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">{t("description")}</p></div>
    {!props.advancedClose ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal-200 bg-teal-50/70 p-4 text-sm text-teal-900 dark:border-teal-900 dark:bg-teal-950/30 dark:text-teal-200"><span>{t("simpleMode")}</span><Button variant="outline" size="sm" asChild><Link href="/admin/setup/features">{t("enableAdvanced")}</Link></Button></div> : null}
    <div className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">{visibleTabs.map((key) => <Link key={key} href={(mergeHref(BASE, props.currentParams, { tab: key }))} className={cn("whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors", tab === key ? "border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300" : "border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100")}>{t(`tabs.${key}`)}</Link>)}</div>
    {tab === "calendars" ? <CalendarsTab {...props} /> : null}
    {tab === "periods" ? <PeriodsTab {...props} /> : null}
    {tab === "blueprints" ? <BlueprintsTab {...props} /> : null}
    {tab === "policies" ? <PoliciesTab {...props} /> : null}
    {tab === "automation" ? <AutomationTab {...props} /> : null}
    {tab === "packages" ? <PackagesTab {...props} /> : null}
  </div>;
}

function CalendarsTab(props: Props) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const selected = pickString(props.currentParams.calendar);
  const row = selected && selected !== "new" ? props.calendars.find((item) => item.id === selected) : undefined;
  return <div className="space-y-4">
    <SectionHeading icon={<CalendarDays size={18} />} title={t("calendars.title")} description={t("calendars.description")} action={<Button size="sm" asChild><Link href={(drawerHref(props.currentParams, "calendars", "calendar", "new"))}><Plus size={14} />{t("actions.newCalendar")}</Link></Button>} />
    <ConfigListControls listKey="calendar" list={props.configLists.calendar} currentParams={props.currentParams} perPage={props.configPerPage} />
    <div className="grid gap-3 md:grid-cols-2">{props.calendars.map((item) => <RowLink key={item.id} href={drawerHref(props.currentParams, "calendars", "calendar", item.id)}><CardHeader className="p-4"><div className="flex items-center justify-between gap-2"><CardTitle className="text-base">{dataText(td, item.name)}</CardTitle><div className="flex gap-1">{item.is_default ? <Badge variant="success">{t("labels.default")}</Badge> : null}{!item.is_active ? <Badge variant="outline">{t("labels.inactive")}</Badge> : null}<ChevronRight size={16} className="text-slate-400" /></div></div><CardDescription>{t(`cadences.${item.cadence}`)} · {t("calendars.startsMonth", { month: item.year_start_month })}</CardDescription></CardHeader></RowLink>)}</div>
    {props.calendars.length === 0 ? <EmptyList>{t("empty.calendars")}</EmptyList> : null}
    {selected ? <CalendarDrawer key={selected} row={row} params={props.currentParams} /> : null}
  </div>;
}

function CalendarDrawer({ row, params }: { row?: Row; params: Props["currentParams"] }) {
  const t = useTranslations("close.setup"); const td = useTranslations("close"); const router = useRouter(); const closeHref = drawerHref(params, "calendars", "calendar", null);
  const [draft, setDraft] = useState<Row>(row ? { id: row.id, name: dataText(td, row.name), cadence: row.cadence, yearStartMonth: row.year_start_month, weekStartsOn: row.week_starts_on, timeZone: row.time_zone, adjustmentPeriodEnabled: row.adjustment_period_enabled, isDefault: row.is_default, isActive: row.is_active, anchorDate: row.anchor_date ?? "", configText: JSON.stringify(row.config ?? {}, null, 2) } : { name: "", cadence: "monthly", yearStartMonth: 1, weekStartsOn: 1, timeZone: "UTC", adjustmentPeriodEnabled: false, isDefault: false, isActive: true, anchorDate: "", configText: "{}" });
  const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); try { await post({ action: "save-calendar", ...draft, config: JSON.parse(draft.configText || "{}") }); toast.success(t("messages.calendarSaved")); router.push((closeHref)); router.refresh(); } catch { toast.error(t("errors.invalidConfiguration")); } finally { setBusy(false); } }
  return <UrlDrawer open closeHref={closeHref} size="lg" title={row ? t("calendars.editTitle") : t("calendars.newTitle")} description={t("calendars.formDescription")} footer={<div className="flex w-full justify-end gap-2"><Button variant="outline" onClick={() => router.push((closeHref))}>{t("actions.cancel")}</Button><Button disabled={busy || !draft.name} onClick={save}>{busy ? t("actions.saving") : t("actions.save")}</Button></div>}><div className="space-y-4 p-1"><Field label={t("fields.name")}><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field><div className="grid gap-3 sm:grid-cols-2"><Field label={t("fields.cadence")}><Select value={draft.cadence} onChange={(e) => setDraft({ ...draft, cadence: e.target.value })}>{["monthly", "four_four_five", "four_five_four", "five_four_four", "thirteen_period", "custom"].map((value) => <option key={value} value={value}>{t(`cadences.${value}`)}</option>)}</Select></Field><Field label={t("fields.yearStartMonth")}><Input type="number" min={1} max={12} value={draft.yearStartMonth} onChange={(e) => setDraft({ ...draft, yearStartMonth: Number(e.target.value) })} /></Field><Field label={t("fields.weekStartsOn")}><Select value={draft.weekStartsOn} onChange={(e) => setDraft({ ...draft, weekStartsOn: Number(e.target.value) })}>{[0,1,2,3,4,5,6].map((value) => <option key={value} value={value}>{t(`weekdays.${value}`)}</option>)}</Select></Field><Field label={t("fields.timeZone")}><Input value={draft.timeZone} onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })} /></Field></div>{draft.cadence !== "monthly" && draft.cadence !== "custom" ? <Field label={t("fields.anchorDate")} hint={t("calendars.anchorHint")}><Input type="date" value={draft.anchorDate} onChange={(e) => setDraft({ ...draft, anchorDate: e.target.value })} /></Field> : null}<Field label={t("fields.configuration")} hint={t("calendars.configurationHint")}><Textarea className="font-mono text-xs" rows={6} value={draft.configText} onChange={(e) => setDraft({ ...draft, configText: e.target.value })} /></Field><div className="space-y-2"><Check checked={draft.adjustmentPeriodEnabled} onChange={(value) => setDraft({ ...draft, adjustmentPeriodEnabled: value })}>{t("fields.adjustmentPeriod")}</Check><Check checked={draft.isDefault} onChange={(value) => setDraft({ ...draft, isDefault: value })}>{t("fields.defaultCalendar")}</Check><Check checked={draft.isActive} onChange={(value) => setDraft({ ...draft, isActive: value })}>{t("fields.active")}</Check></div></div></UrlDrawer>;
}

function PeriodsTab(props: Props) {
  const t = useTranslations("close.setup"); const td = useTranslations("close"); const router = useRouter(); const selected = pickString(props.currentParams.period); const reopenId = pickString(props.currentParams.reopen); const period = selected && selected !== "new" ? props.periods.find((item) => item.id === selected) : undefined; const reopen = reopenId ? props.reopenRequests.find((item) => item.id === reopenId) : undefined;
  return <div className="space-y-5"><SectionHeading icon={<LockKeyhole size={18} />} title={t("periods.title")} description={t("periods.description")} action={<Button size="sm" asChild><Link href={(drawerHref(props.currentParams, "periods", "period", "new"))}><Plus size={14} />{t("actions.generate")}</Link></Button>} />
    <div className="flex flex-wrap items-end justify-between gap-3"><div className="min-w-64 max-w-md flex-1"><SearchInput paramKey="periodQ" pageParamKey="periodPage" placeholder={t("periods.searchPlaceholder")} /></div><div className="flex flex-wrap items-end gap-2"><Field label={t("fields.book")}>{props.books.length > 1 ? <Select className="h-9 w-44" value={props.selectedBookId} onChange={(e) => router.push((mergeHref(BASE, props.currentParams, { tab: "periods", book: e.target.value, periodPage: 1 })))}>{props.books.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</Select> : <div className="flex h-9 w-44 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">{props.books[0]?.name ?? "—"}</div>}</Field><Button variant="outline" size="sm" asChild><Link href="/admin/setup/accounting-books">{t("actions.manageBooks")}</Link></Button><Field label={t("fields.fiscalYear")}><Input className="h-9 w-28" type="number" value={props.fiscalYear} onChange={(e) => router.push((mergeHref(BASE, props.currentParams, { tab: "periods", fy: e.target.value, periodPage: 1 })))} /></Field></div></div>
    <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800"><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>{t("table.period")}</TableHead><TableHead>{t("table.range")}</TableHead><TableHead className="text-right">{t("table.entries")}</TableHead><TableHead>{t("table.status")}</TableHead><TableHead className="w-10" /></TableRow></TableHeader><TableBody>{props.periods.map((item) => { const states = MODULES.map((module) => item.locks?.[module]?.state ?? "open"); const closed = states.filter((state) => state === "closed").length; const soft = states.filter((state) => state === "soft_closed").length; const overall = closed === MODULES.length ? "closed" : soft > 0 ? "soft_closed" : closed > 0 ? "partial" : "open"; return <TableRow key={item.id}><TableCell><div className="font-medium">{item.name}</div><div className="text-xs text-slate-500">{dataText(td, item.calendar_name)}</div></TableCell><TableCell className="whitespace-nowrap text-slate-500">{item.starts_on} → {item.ends_on}</TableCell><TableCell className="text-right tabular-nums">{Number(item.entries).toLocaleString()}</TableCell><TableCell><div className="flex items-center gap-2"><Badge variant={overall === "closed" ? "success" : overall === "soft_closed" || overall === "partial" ? "warning" : "outline"}>{t(`states.${overall}`)}</Badge><span className="hidden text-xs text-slate-500 lg:inline">{t("periods.moduleSummary", { closed, total: MODULES.length })}</span></div></TableCell><TableCell><Button variant="ghost" size="sm" asChild><Link href={(drawerHref(props.currentParams, "periods", "period", item.id))} aria-label={t("actions.managePeriod", { period: item.name })}><ChevronRight size={16} /></Link></Button></TableCell></TableRow>; })}</TableBody></Table></div><Pagination basePath={BASE} currentParams={props.currentParams} total={props.periodTotal} page={props.periodPage} perPage={props.periodPerPage} pageParamKey="periodPage" /></div>
    {props.periods.length === 0 ? <EmptyList>{t("empty.periods")}</EmptyList> : null}
    {props.reopenTotal > 0 || pickString(props.currentParams.reopenQ) ? <ReopenList {...props} /> : null}
    {selected ? <PeriodDrawer key={`${selected}-${props.selectedBookId}`} row={period} props={props} /> : null}
    {reopenId && reopen ? <ReopenDrawer key={reopenId} row={reopen} props={props} /> : null}
  </div>;
}

function PeriodDrawer({ row, props }: { row?: Row; props: Props }) {
  const t = useTranslations("close.setup"); const td = useTranslations("close"); const router = useRouter(); const closeHref = drawerHref(props.currentParams, "periods", "period", null); const creating = pickString(props.currentParams.period) === "new"; const selectedBook = props.books.find((book) => book.id === props.selectedBookId) ?? props.books[0]; const [calendarId, setCalendarId] = useState(props.calendarOptions.find((item) => item.is_default)?.id ?? props.calendarOptions[0]?.id ?? ""); const [year, setYear] = useState(props.fiscalYear); const [action, setAction] = useState<{ module: string; state: string } | null>(null); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false);
  async function generate() { setBusy(true); try { await post({ action: "generate-periods", calendarId, fiscalYear: year }); toast.success(t("messages.periodsGenerated")); router.push((mergeHref(closeHref, {}, { fy: year }))); router.refresh(); } catch { toast.error(t("errors.actionFailed")); } finally { setBusy(false); } }
  async function apply() { if (!row || !selectedBook || !action || !reason.trim()) return; setBusy(true); try { if (action.state === "reopen") await post({ action: "request-reopen", periodId: row.id, bookId: selectedBook.id, modules: [action.module], reason }); else await post({ action: "set-lock", periodId: row.id, bookId: selectedBook.id, module: action.module, state: action.state, reason }); toast.success(t(action.state === "reopen" ? "messages.reopenRequested" : "messages.lockSaved")); setAction(null); setReason(""); router.refresh(); } catch { toast.error(t("errors.actionFailed")); } finally { setBusy(false); } }
  if (creating) return <UrlDrawer open closeHref={closeHref} size="md" title={t("periods.generateTitle")} description={t("periods.generateDescription")} footer={<div className="flex w-full justify-end gap-2"><Button variant="outline" onClick={() => router.push((closeHref))}>{t("actions.cancel")}</Button><Button disabled={busy || !calendarId} onClick={generate}>{busy ? t("actions.saving") : t("actions.generate")}</Button></div>}><div className="space-y-4 p-1"><Field label={t("fields.calendar")}><Select value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>{props.calendarOptions.filter((item) => item.is_active).map((item) => <option key={item.id} value={item.id}>{dataText(td, item.name)}</option>)}</Select></Field><Field label={t("fields.fiscalYear")}><Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} /></Field></div></UrlDrawer>;
  if (!row) return null;
  return <UrlDrawer open closeHref={closeHref} size="lg" title={row.name} description={`${row.starts_on} → ${row.ends_on} · ${selectedBook?.name ?? ""}`}><div className="space-y-5 p-1"><div className="grid gap-2">{MODULES.map((module) => { const lock = row.locks?.[module]; const state = lock?.state ?? "open"; return <div key={module} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800"><div><div className="flex items-center gap-2"><span className="font-medium">{t(`modules.${module}`)}</span><Badge variant={state === "closed" ? "success" : state === "soft_closed" ? "warning" : "outline"}>{t(`states.${state}`)}</Badge></div>{lock?.lockedAt ? <p className="mt-1 text-xs text-slate-500">{t("periods.lockedOn", { date: new Date(lock.lockedAt).toLocaleDateString() })}</p> : null}</div><div className="flex gap-1">{state === "open" ? <Button variant="outline" size="sm" onClick={() => setAction({ module, state: "soft_closed" })}>{t("actions.softClose")}</Button> : null}<Button size="sm" variant={state === "closed" ? "outline" : "default"} disabled={state === "closed" && !props.canReopen} onClick={() => setAction({ module, state: state === "closed" ? "reopen" : "closed" })}>{state === "closed" ? t("actions.reopen") : t("actions.close")}</Button></div></div>; })}</div>{action ? <div className="space-y-3 rounded-lg border border-teal-300 bg-teal-50/50 p-4 dark:border-teal-800 dark:bg-teal-950/20"><div><h4 className="font-medium">{action.state === "reopen" ? t("periods.reopenTitle") : t("periods.lockTitle")}</h4><p className="text-sm text-slate-500">{t("periods.lockDescription", { period: row.name, module: t(`modules.${action.module}`) })}</p></div><Field label={t("fields.reason")}><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => { setAction(null); setReason(""); }}>{t("actions.cancel")}</Button><Button disabled={busy || !reason.trim()} onClick={apply}>{action.state === "reopen" ? t("actions.requestReopen") : t("actions.confirmClose")}</Button></div></div> : null}</div></UrlDrawer>;
}

function ReopenList(props: Props) { const t = useTranslations("close.setup"); return <Card><CardHeader className="pb-3"><CardTitle className="text-base">{t("periods.reopenRequests")}</CardTitle></CardHeader><CardContent className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-64 max-w-md flex-1"><SearchInput paramKey="reopenQ" pageParamKey="reopenPage" /></div><Pagination basePath={BASE} currentParams={props.currentParams} total={props.reopenTotal} page={props.reopenPage} perPage={props.reopenPerPage} pageParamKey="reopenPage" /></div><div className="divide-y divide-slate-200 dark:divide-slate-800">{props.reopenRequests.map((item) => <Link key={item.id} href={(drawerHref(props.currentParams, "periods", "reopen", item.id))} className="flex items-center justify-between gap-3 py-3 text-sm hover:text-teal-700 dark:hover:text-teal-300"><div><span className="font-medium">{item.period_name}</span><span className="text-slate-500"> · {item.book_name} · {t(`modules.${item.modules?.[0] ?? "gl"}`)}</span></div><div className="flex items-center gap-2"><Badge variant={item.status === "approved" ? "success" : item.status === "requested" ? "warning" : "outline"}>{t(`reopenStates.${item.status}`)}</Badge><ChevronRight size={16} /></div></Link>)}</div></CardContent></Card>; }

function ReopenDrawer({ row, props }: { row: Row; props: Props }) { const t = useTranslations("close.setup"); const router = useRouter(); const closeHref = drawerHref(props.currentParams, "periods", "reopen", null); const [busy, setBusy] = useState(false); async function decide(approve: boolean) { setBusy(true); try { await post({ action: "decide-reopen", requestId: row.id, approve }); toast.success(t(approve ? "messages.reopenApproved" : "messages.reopenRejected")); router.push((closeHref)); router.refresh(); } catch { toast.error(t("errors.actionFailed")); } finally { setBusy(false); } } return <UrlDrawer open closeHref={closeHref} size="md" title={t("periods.reopenTitle")} description={`${row.period_name} · ${row.book_name}`} footer={row.status === "requested" && props.canReopen ? <div className="flex w-full justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => decide(false)}>{t("actions.reject")}</Button><Button disabled={busy} onClick={() => decide(true)}>{t("actions.approve")}</Button></div> : undefined}><div className="space-y-4 p-1"><div><Label>{t("fields.reason")}</Label><p className="mt-1 text-sm text-slate-700 dark:text-slate-200">{row.reason}</p></div><div><Label>{t("periods.requestedBy", { name: row.requester_name })}</Label></div><Badge variant={row.status === "approved" ? "success" : row.status === "requested" ? "warning" : "outline"}>{t(`reopenStates.${row.status}`)}</Badge></div></UrlDrawer>; }

function BlueprintsTab(props: Props) { const t = useTranslations("close.setup"); const td = useTranslations("close"); const selected = pickString(props.currentParams.blueprint); const row = selected && selected !== "new" ? props.blueprints.find((item) => item.id === selected) : undefined; return <div className="space-y-4"><SectionHeading icon={<GitBranch size={18} />} title={t("blueprints.title")} description={t("blueprints.description")} action={<Button size="sm" asChild><Link href={(drawerHref(props.currentParams, "blueprints", "blueprint", "new"))}><Plus size={14} />{t("actions.newBlueprint")}</Link></Button>} /><ConfigListControls listKey="blueprint" list={props.configLists.blueprint} currentParams={props.currentParams} perPage={props.configPerPage} /><div className="grid gap-3 md:grid-cols-2">{props.blueprints.map((item) => <RowLink key={item.id} href={drawerHref(props.currentParams, "blueprints", "blueprint", item.id)}><CardHeader className="p-4"><div className="flex justify-between gap-2"><CardTitle className="text-base">{dataText(td, item.name)} <span className="text-xs font-normal text-slate-400">v{item.version}</span></CardTitle><div className="flex gap-1">{item.is_default ? <Badge variant="success">{t("labels.default")}</Badge> : null}{!item.is_active ? <Badge variant="outline">{t("labels.inactive")}</Badge> : null}<ChevronRight size={16} className="text-slate-400" /></div></div><CardDescription>{dataText(td, item.description)}</CardDescription></CardHeader><CardContent className="px-4 pb-4 text-xs text-slate-500">{t("blueprints.stepCount", { count: item.steps.length })} · {t(`periodTypes.${item.period_type}`)}</CardContent></RowLink>)}</div>{props.blueprints.length === 0 ? <EmptyList>{t("empty.blueprints")}</EmptyList> : null}{selected ? <BlueprintDrawer key={selected} row={row} params={props.currentParams} /> : null}</div>; }

function emptyStep(index: number): Row { return { key: `step-${index}`, title: "", description: "", workstream: "gl", taskType: "action", completionMode: "manual", gateType: "none", dueOffsetBusinessDays: 0, evidenceRequired: false, defaultOwnerRoleKey: "", defaultReviewerRoleKey: "", applicabilityText: "{}", dependsOn: [] }; }
function BlueprintDrawer({ row, params }: { row?: Row; params: Props["currentParams"] }) { const t = useTranslations("close.setup"); const td = useTranslations("close"); const router = useRouter(); const closeHref = drawerHref(params, "blueprints", "blueprint", null); const [draft, setDraft] = useState<Row>(row ? { id: row.id, name: dataText(td, row.name), description: dataText(td, row.description), periodType: row.period_type, isDefault: row.is_default, steps: row.steps.map((step: Row) => ({ key: step.key, title: dataText(td, step.title), description: dataText(td, step.description) ?? "", workstream: step.workstream, taskType: step.task_type, completionMode: step.completion_mode, gateType: step.gate_type, dueOffsetBusinessDays: step.due_offset_business_days, evidenceRequired: step.evidence_required, defaultOwnerRoleKey: step.default_owner_role_key ?? "", defaultReviewerRoleKey: step.default_reviewer_role_key ?? "", applicabilityText: JSON.stringify(step.applicability ?? {}, null, 2), dependsOn: step.depends_on ?? [] })) } : { name: "", description: "", periodType: "any", isDefault: false, steps: [emptyStep(1)] }); const [busy, setBusy] = useState(false); const updateStep = (index: number, changes: Row) => setDraft({ ...draft, steps: draft.steps.map((step: Row, i: number) => i === index ? { ...step, ...changes } : step) }); async function save() { setBusy(true); try { await post({ action: "save-blueprint", ...draft, steps: draft.steps.map((step: Row) => ({ ...step, applicability: JSON.parse(step.applicabilityText || "{}") })) }); toast.success(t("messages.blueprintSaved")); router.push((closeHref)); router.refresh(); } catch { toast.error(t("errors.invalidConfiguration")); } finally { setBusy(false); } } return <UrlDrawer open closeHref={closeHref} size="xl" title={row ? t("blueprints.newVersionTitle") : t("blueprints.newTitle")} description={t("blueprints.versionHint")} footer={<div className="flex w-full justify-end gap-2"><Button variant="outline" onClick={() => router.push((closeHref))}>{t("actions.cancel")}</Button><Button disabled={busy || !draft.name || draft.steps.length === 0} onClick={save}>{busy ? t("actions.saving") : t("actions.saveVersion")}</Button></div>}><div className="space-y-5 p-1"><div className="grid gap-3 sm:grid-cols-2"><Field label={t("fields.name")}><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field><Field label={t("fields.periodType")}><Select value={draft.periodType} onChange={(e) => setDraft({ ...draft, periodType: e.target.value })}>{["any","month","quarter","year","adjustment"].map((value) => <option key={value} value={value}>{t(`periodTypes.${value}`)}</option>)}</Select></Field></div><Field label={t("fields.description")}><Textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field><div className="flex items-center justify-between"><Label>{t("blueprints.steps")}</Label><Button variant="outline" size="sm" onClick={() => setDraft({ ...draft, steps: [...draft.steps, emptyStep(draft.steps.length + 1)] })}><Plus size={14} />{t("actions.addStep")}</Button></div><div className="space-y-3">{draft.steps.map((step: Row, index: number) => <div key={index} className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"><div className="grid gap-3 sm:grid-cols-2"><Field label={t("fields.stepKey")}><Input value={step.key} onChange={(e) => updateStep(index, { key: e.target.value })} /></Field><Field label={t("fields.stepTitle")}><Input value={step.title} onChange={(e) => updateStep(index, { title: e.target.value })} /></Field><Field label={t("fields.workstream")}><Select value={step.workstream} onChange={(e) => updateStep(index, { workstream: e.target.value })}>{["readiness","banking","ar","ap","assets","tax","payroll","intercompany","gl","review","publish"].map((value) => <option key={value} value={value}>{t(`workstreams.${value}`)}</option>)}</Select></Field><Field label={t("fields.taskType")}><Select value={step.taskType} onChange={(e) => updateStep(index, { taskType: e.target.value })}>{["check","action","reconciliation","journal","approval","report","publish"].map((value) => <option key={value} value={value}>{t(`taskTypes.${value}`)}</option>)}</Select></Field><Field label={t("fields.gate")}><Select value={step.gateType} onChange={(e) => updateStep(index, { gateType: e.target.value })}>{["none","soft","hard"].map((value) => <option key={value} value={value}>{t(`gates.${value}`)}</option>)}</Select></Field><Field label={t("fields.completion")}><Select value={step.completionMode} onChange={(e) => updateStep(index, { completionMode: e.target.value })}>{["manual","computed","automatic"].map((value) => <option key={value} value={value}>{t(`completionModes.${value}`)}</option>)}</Select></Field><Field label={t("fields.dueOffset")}><Input type="number" value={step.dueOffsetBusinessDays} onChange={(e) => updateStep(index, { dueOffsetBusinessDays: Number(e.target.value) })} /></Field><Field label={t("fields.dependencies")}><Input value={(step.dependsOn ?? []).join(", ")} onChange={(e) => updateStep(index, { dependsOn: e.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></Field><Field label={t("fields.ownerRole")}><Input value={step.defaultOwnerRoleKey} onChange={(e) => updateStep(index, { defaultOwnerRoleKey: e.target.value })} /></Field><Field label={t("fields.reviewerRole")}><Input value={step.defaultReviewerRoleKey} onChange={(e) => updateStep(index, { defaultReviewerRoleKey: e.target.value })} /></Field><Field label={t("fields.applicability")}><Textarea className="font-mono text-xs" rows={3} value={step.applicabilityText} onChange={(e) => updateStep(index, { applicabilityText: e.target.value })} /></Field></div><div className="mt-3 flex items-center justify-between"><Check checked={step.evidenceRequired} onChange={(value) => updateStep(index, { evidenceRequired: value })}>{t("fields.evidenceRequired")}</Check><Button variant="ghost" size="sm" onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_: Row, i: number) => i !== index) })}><Trash2 size={14} />{t("actions.remove")}</Button></div></div>)}</div><Check checked={draft.isDefault} onChange={(value) => setDraft({ ...draft, isDefault: value })}>{t("fields.defaultBlueprint")}</Check></div></UrlDrawer>; }

function PoliciesTab(props: Props) { return <SimpleConfigTab props={props} kind="policy" icon={<ShieldCheck size={18} />} />; }
function AutomationTab(props: Props) { return <SimpleConfigTab props={props} kind="automation" icon={<Bot size={18} />} />; }
function SimpleConfigTab({ props, kind, icon }: { props: Props; kind: "policy" | "automation"; icon: React.ReactNode }) { const t = useTranslations("close.setup"); const td = useTranslations("close"); const tab = kind === "policy" ? "policies" : "automation"; const listKey = kind; const param = pickString(props.currentParams[kind]); const rows = kind === "policy" ? props.policies : props.automations; const row = param && param !== "new" ? rows.find((item) => item.id === param) : undefined; return <div className="space-y-4"><SectionHeading icon={icon} title={t(`${tab}.title`)} description={t(`${tab}.description`)} action={<Button size="sm" asChild><Link href={(drawerHref(props.currentParams, tab, kind, "new"))}><Plus size={14} />{t(`actions.new${kind === "policy" ? "Policy" : "Automation"}`)}</Link></Button>} /><ConfigListControls listKey={listKey} list={props.configLists[listKey]} currentParams={props.currentParams} perPage={props.configPerPage} /><div className="grid gap-3 md:grid-cols-2">{rows.map((item) => <RowLink key={item.id} href={drawerHref(props.currentParams, tab, kind, item.id)}><CardHeader className="p-4"><div className="flex justify-between gap-2"><CardTitle className="text-base">{dataText(td, item.name)}</CardTitle><div className="flex gap-1"><Badge variant={item.is_active ? "success" : "outline"}>{t(item.is_active ? "labels.active" : "labels.inactive")}</Badge><ChevronRight size={16} className="text-slate-400" /></div></div><CardDescription>{kind === "policy" ? `${t(`policyTypes.${item.policy_type}`)} · ${item.code}` : `${t(`automationTriggers.${item.trigger}`)} → ${t(`automationActions.${item.action}`)}`}</CardDescription></CardHeader></RowLink>)}</div>{rows.length === 0 ? <EmptyList>{t(`empty.${tab}`)}</EmptyList> : null}{param ? (kind === "policy" ? <PolicyDrawer key={param} row={row} params={props.currentParams} /> : <AutomationDrawer key={param} row={row} props={props} />) : null}</div>; }

function PolicyDrawer({ row, params }: { row?: Row; params: Props["currentParams"] }) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const router = useRouter();
  const closeHref = drawerHref(params, "policies", "policy", null);
  const [draft, setDraft] = useState<Row>(row
    ? { id: row.id, code: row.code, name: dataText(td, row.name), description: dataText(td, row.description) ?? "", policyType: row.policy_type, rules: row.rules ?? {}, isActive: row.is_active }
    : { code: "", name: "", description: "", policyType: "materiality", rules: {}, isActive: true });
  const [advanced, setAdvanced] = useState<Array<{ key: string; value: string }>>(objectToRows(row?.rules));
  const [busy, setBusy] = useState(false);
  const rules = ((draft.rules ?? {}));
  const isAdvanced = draft.policyType === "review" || draft.policyType === "exception";
  const setRules = (patch: Record<string, unknown>) => setDraft({ ...draft, rules: { ...rules, ...patch } });
  function composeRules(): Record<string, unknown> {
    if (draft.policyType === "materiality") return { amount: String(rules.amount || "10000.0000"), percent: numberOrUndefined(String(rules.percent ?? "")) ?? 20 };
    if (draft.policyType === "lock") return { approvalRequired: rules.approvalRequired !== false, defaultHours: numberOrUndefined(String(rules.defaultHours ?? "")) ?? 24, maxHours: numberOrUndefined(String(rules.maxHours ?? "")) ?? 168 };
    if (draft.policyType === "segregation") return { prohibitSelfApproval: rules.prohibitSelfApproval !== false };
    return rowsToObject(advanced);
  }
  async function save() {
    setBusy(true);
    try {
      await post({ action: "save-policy", id: draft.id, code: draft.code, name: draft.name, description: draft.description, policyType: draft.policyType, rules: composeRules(), isActive: draft.isActive });
      toast.success(t("messages.policySaved"));
      router.push((closeHref));
      router.refresh();
    } catch { toast.error(t("errors.invalidConfiguration")); } finally { setBusy(false); }
  }
  return <UrlDrawer open closeHref={closeHref} size="lg" title={draft.policyType === "materiality" ? t("policies.materialityFormTitle") : t("policies.formTitle")} footer={<div className="flex w-full justify-end gap-2"><Button variant="outline" onClick={() => router.push((closeHref))}>{t("actions.cancel")}</Button><Button disabled={busy || !draft.name || !draft.code} onClick={save}>{busy ? t("actions.saving") : t("actions.save")}</Button></div>}>
    <div className="space-y-4 p-1">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("fields.code")}><Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} /></Field>
        <Field label={t("fields.policyType")}><Select value={draft.policyType} onChange={(e) => setDraft({ ...draft, policyType: e.target.value })}>{["materiality", "lock", "review", "segregation", "exception"].map((value) => <option key={value} value={value}>{t(`policyTypes.${value}`)}</option>)}</Select></Field>
      </div>
      <Field label={t("fields.name")}><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
      <Field label={t("fields.description")}><Textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
      <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        {draft.policyType === "materiality" ? <>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t("policyRules.materialityIntro")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("policyRules.amount")} hint={t("policyRules.amountHint")}><Input inputMode="decimal" value={String(rules.amount ?? "")} placeholder="10000.0000" onChange={(e) => setRules({ amount: e.target.value })} /></Field>
            <Field label={t("policyRules.percent")} hint={t("policyRules.percentHint")}><Input type="number" min={0} value={rules.percent ?? ""} placeholder="20" onChange={(e) => setRules({ percent: e.target.value === "" ? "" : Number(e.target.value) })} /></Field>
          </div>
        </> : null}
        {draft.policyType === "lock" ? <>
          <Check checked={rules.approvalRequired !== false} onChange={(value) => setRules({ approvalRequired: value })}>{t("policyRules.approvalRequired")}</Check>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("policyRules.defaultHours")}><Input type="number" min={1} value={rules.defaultHours ?? ""} placeholder="24" onChange={(e) => setRules({ defaultHours: e.target.value === "" ? "" : Number(e.target.value) })} /></Field>
            <Field label={t("policyRules.maxHours")}><Input type="number" min={1} value={rules.maxHours ?? ""} placeholder="168" onChange={(e) => setRules({ maxHours: e.target.value === "" ? "" : Number(e.target.value) })} /></Field>
          </div>
        </> : null}
        {draft.policyType === "segregation" ? <Check checked={rules.prohibitSelfApproval !== false} onChange={(value) => setRules({ prohibitSelfApproval: value })}>{t("policyRules.prohibitSelfApproval")}</Check> : null}
        {isAdvanced ? <><p className="text-xs text-slate-500 dark:text-slate-400">{t("policyRules.advancedIntro")}</p><KeyValueRows rows={advanced} onChange={setAdvanced} /></> : null}
      </div>
      <Check checked={draft.isActive !== false} onChange={(value) => setDraft({ ...draft, isActive: value })}>{t("fields.active")}</Check>
    </div>
  </UrlDrawer>;
}

function AutomationDrawer({ row, props }: { row?: Row; props: Props }) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const router = useRouter();
  const closeHref = drawerHref(props.currentParams, "automation", "automation", null);
  const [draft, setDraft] = useState<Row>(row
    ? { id: row.id, name: row.name, trigger: row.trigger, automationAction: row.action, conditions: row.conditions ?? {}, config: row.config ?? {}, isActive: row.is_active }
    : { name: "", trigger: "run_started", automationAction: "notify", conditions: {}, config: {}, isActive: true });
  const [busy, setBusy] = useState(false);
  const conditions = ((draft.conditions ?? {}));
  const config = ((draft.config ?? {}));
  const action = draft.automationAction;
  const setCondList = (key: string, values: string[]) => { const next = { ...conditions }; if (values.length) next[key] = values; else delete next[key]; setDraft({ ...draft, conditions: next }); };
  const setCondNum = (key: string, raw: string) => { const next = { ...conditions }; const num = numberOrUndefined(raw); if (num === undefined) delete next[key]; else next[key] = num; setDraft({ ...draft, conditions: next }); };
  const setConfig = (patch: Record<string, unknown>) => setDraft({ ...draft, config: { ...config, ...patch } });
  const userOptions: Option[] = props.users.map((u) => ({ value: u.id, label: u.name || u.email || u.id }));
  const roleOptions: Option[] = props.roles.map((r) => ({ value: r.key, label: r.name }));
  const reportOptions: Option[] = props.reportDefs.map((r) => ({ value: r.slug, label: r.name, group: t(`reportGroups.${r.kind}`) }));
  async function save() {
    setBusy(true);
    try {
      await post({ action: "save-automation", id: draft.id, name: draft.name, trigger: draft.trigger, automationAction: draft.automationAction, conditions: pruneEmpty(conditions), config: pruneEmpty(config), isActive: draft.isActive });
      toast.success(t("messages.automationSaved"));
      router.push((closeHref));
      router.refresh();
    } catch { toast.error(t("errors.invalidConfiguration")); } finally { setBusy(false); }
  }
  return <UrlDrawer open closeHref={closeHref} size="lg" title={t("automation.formTitle")} footer={<div className="flex w-full justify-end gap-2"><Button variant="outline" onClick={() => router.push((closeHref))}>{t("actions.cancel")}</Button><Button disabled={busy || !draft.name} onClick={save}>{busy ? t("actions.saving") : t("actions.save")}</Button></div>}>
    <div className="space-y-4 p-1">
      <Field label={t("fields.name")}><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("fields.trigger")}><Select value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}>{["run_started", "task_ready", "exception_opened", "deadline_approaching", "run_closed"].map((value) => <option key={value} value={value}>{t(`automationTriggers.${value}`)}</option>)}</Select></Field>
        <Field label={t("fields.action")}><Select value={draft.automationAction} onChange={(e) => setDraft({ ...draft, automationAction: e.target.value })}>{["notify", "assign", "run_check", "complete_task", "create_task", "generate_report", "start_flow"].map((value) => <option key={value} value={value}>{t(`automationActions.${value}`)}</option>)}</Select></Field>
      </div>
      <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <div><h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t("automationConfig.sectionConditions")}</h4><p className="text-xs text-slate-500 dark:text-slate-400">{t("conditions.intro")}</p></div>
        <Field label={t("conditions.runStatus")}><Chips options={RUN_STATUSES.map((value) => ({ value, label: td(`runStatus.${value}`) }))} value={asStringArray(conditions.runStatus)} onChange={(next) => setCondList("runStatus", next)} /></Field>
        <Field label={t("conditions.workstream")}><Chips options={ALL_WORKSTREAMS.map((value) => ({ value, label: t(`workstreams.${value}`) }))} value={asStringArray(conditions.workstream)} onChange={(next) => setCondList("workstream", next)} /></Field>
        <Field label={t("conditions.taskStatus")}><Chips options={TASK_STATUSES.map((value) => ({ value, label: td(`taskStatus.${value}`) }))} value={asStringArray(conditions.taskStatus)} onChange={(next) => setCondList("taskStatus", next)} /></Field>
        <Field label={t("conditions.severity")}><Chips options={SEVERITIES.map((value) => ({ value, label: td(`severity.${value}`) }))} value={asStringArray(conditions.severity)} onChange={(next) => setCondList("severity", next)} /></Field>
        <Field label={t("conditions.taskKey")} hint={t("conditions.taskKeyHint")}><Input value={asStringArray(conditions.taskKey).join(", ")} onChange={(e) => setCondList("taskKey", e.target.value.split(",").map((v) => v.trim()).filter(Boolean))} /></Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("conditions.minReadiness")}><Input type="number" min={0} max={100} value={conditions.minReadiness ?? ""} onChange={(e) => setCondNum("minReadiness", e.target.value)} /></Field>
          <Field label={t("conditions.maxReadiness")}><Input type="number" min={0} max={100} value={conditions.maxReadiness ?? ""} onChange={(e) => setCondNum("maxReadiness", e.target.value)} /></Field>
          <Field label={t("conditions.withinDays")}><Input type="number" value={conditions.withinDays ?? ""} onChange={(e) => setCondNum("withinDays", e.target.value)} /></Field>
        </div>
      </div>
      <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t("automationConfig.sectionConfig")}</h4>
        {action === "notify" ? <>
          <Field label={t("automationConfig.notifyUsers")} hint={t("automationConfig.notifyHint")}><TokenSelect options={userOptions} value={asStringArray(config.userIds)} onChange={(next) => setConfig({ userIds: next })} placeholder={t("automationConfig.notifyUsers")} /></Field>
          <Field label={t("automationConfig.notifyRoles")}><TokenSelect options={roleOptions} value={asStringArray(config.roleKeys)} onChange={(next) => setConfig({ roleKeys: next })} placeholder={t("automationConfig.notifyRoles")} /></Field>
          <Field label={t("automationConfig.title")}><Input value={config.title ?? ""} placeholder={t("automationConfig.titlePlaceholder")} onChange={(e) => setConfig({ title: e.target.value })} /></Field>
          <Field label={t("automationConfig.body")}><Textarea value={config.body ?? ""} placeholder={t("automationConfig.bodyPlaceholder")} onChange={(e) => setConfig({ body: e.target.value })} /></Field>
        </> : null}
        {action === "assign" ? <>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t("automationConfig.assignHint")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("automationConfig.owner")}><SearchSelect value={config.ownerUserId ?? ""} onChange={(v) => setConfig({ ownerUserId: v })} options={userOptions} clearable searchable ariaLabel={t("automationConfig.owner")} /></Field>
            <Field label={t("automationConfig.ownerRole")}><SearchSelect value={config.ownerRoleKey ?? ""} onChange={(v) => setConfig({ ownerRoleKey: v })} options={roleOptions} clearable searchable ariaLabel={t("automationConfig.ownerRole")} /></Field>
            <Field label={t("automationConfig.reviewer")}><SearchSelect value={config.reviewerUserId ?? ""} onChange={(v) => setConfig({ reviewerUserId: v })} options={userOptions} clearable searchable ariaLabel={t("automationConfig.reviewer")} /></Field>
            <Field label={t("automationConfig.reviewerRole")}><SearchSelect value={config.reviewerRoleKey ?? ""} onChange={(v) => setConfig({ reviewerRoleKey: v })} options={roleOptions} clearable searchable ariaLabel={t("automationConfig.reviewerRole")} /></Field>
          </div>
        </> : null}
        {action === "create_task" ? <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("automationConfig.taskKey")}><Input value={config.key ?? ""} placeholder={t("automationConfig.taskKeyPlaceholder")} onChange={(e) => setConfig({ key: e.target.value })} /></Field>
            <Field label={t("automationConfig.taskTitle")}><Input value={config.title ?? ""} onChange={(e) => setConfig({ title: e.target.value })} /></Field>
            <Field label={t("fields.workstream")}><Select value={config.workstream ?? "review"} onChange={(e) => setConfig({ workstream: e.target.value })}>{ALL_WORKSTREAMS.map((value) => <option key={value} value={value}>{t(`workstreams.${value}`)}</option>)}</Select></Field>
            <Field label={t("automationConfig.gate")}><Select value={config.gateType ?? "none"} onChange={(e) => setConfig({ gateType: e.target.value })}>{["none", "soft", "hard"].map((value) => <option key={value} value={value}>{t(`gates.${value}`)}</option>)}</Select></Field>
          </div>
          <Field label={t("automationConfig.taskDescription")}><Textarea value={config.description ?? ""} onChange={(e) => setConfig({ description: e.target.value })} /></Field>
          <Check checked={config.evidenceRequired === true} onChange={(value) => setConfig({ evidenceRequired: value })}>{t("automationConfig.evidenceRequired")}</Check>
        </> : null}
        {action === "generate_report" ? <>
          <Field label={t("automationConfig.report")}><SearchSelect value={config.report ?? ""} onChange={(v) => setConfig({ report: v })} options={reportOptions} searchable clearable ariaLabel={t("automationConfig.report")} emptyLabel={t("reportsEmpty")} /></Field>
          <Field label={t("automationConfig.label")}><Input value={config.label ?? ""} onChange={(e) => setConfig({ label: e.target.value })} /></Field>
        </> : null}
        {action === "start_flow" ? <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("automationConfig.subjectKind")}><Input value={config.subjectKind ?? ""} onChange={(e) => setConfig({ subjectKind: e.target.value })} /></Field>
            <Field label={t("automationConfig.subjectId")}><Select value={config.subjectId ?? "$run"} onChange={(e) => setConfig({ subjectId: e.target.value })}>{["$run", "$task"].map((value) => <option key={value} value={value}>{t(`subjectRefs.${value}`)}</option>)}</Select></Field>
          </div>
          <Field label={t("automationConfig.buttonId")}><Input value={config.buttonId ?? ""} onChange={(e) => setConfig({ buttonId: e.target.value })} /></Field>
        </> : null}
        {action === "run_check" || action === "complete_task" ? <p className="text-sm text-slate-500 dark:text-slate-400">{t("automationConfig.none")}</p> : null}
      </div>
      <Check checked={draft.isActive !== false} onChange={(value) => setDraft({ ...draft, isActive: value })}>{t("fields.active")}</Check>
    </div>
  </UrlDrawer>;
}

function PackagesTab(props: Props) { const t = useTranslations("close.setup"); const td = useTranslations("close"); const selected = pickString(props.currentParams.package); const row = selected && selected !== "new" ? props.packages.find((item) => item.id === selected) : undefined; return <div className="space-y-4"><SectionHeading icon={<FileOutput size={18} />} title={t("packages.title")} description={t("packages.description")} action={<Button size="sm" asChild><Link href={(drawerHref(props.currentParams, "packages", "package", "new"))}><Plus size={14} />{t("actions.newPackage")}</Link></Button>} /><ConfigListControls listKey="package" list={props.configLists.package} currentParams={props.currentParams} perPage={props.configPerPage} /><div className="grid gap-3 md:grid-cols-2">{props.packages.map((item) => <RowLink key={item.id} href={drawerHref(props.currentParams, "packages", "package", item.id)}><CardHeader className="p-4"><div className="flex justify-between gap-2"><CardTitle className="text-base">{dataText(td, item.name)}</CardTitle><div className="flex gap-1">{item.is_default ? <Badge variant="success">{t("labels.default")}</Badge> : null}{!item.is_active ? <Badge variant="outline">{t("labels.inactive")}</Badge> : null}<ChevronRight size={16} className="text-slate-400" /></div></div><CardDescription>{t("packages.reportCount", { count: item.reports?.length ?? 0 })}</CardDescription></CardHeader></RowLink>)}</div>{props.packages.length === 0 ? <EmptyList>{t("empty.packages")}</EmptyList> : null}{selected ? <PackageDrawer key={selected} row={row} props={props} /> : null}</div>; }

/** Read-only recap of the parameters a report already carries in its own
 * definition, shown above the editable overrides. */
function ReportDescriptorSummary({ descriptor }: { descriptor: ReportDescriptor }) {
  const t = useTranslations("close.setup");
  const parts: Array<[string, string[]]> = [
    [t("reportParams.definedDate"), descriptor.dateRange ? [descriptor.dateRange] : []],
    [t("reportParams.definedBreakouts"), descriptor.breakouts],
    [t("reportParams.definedFilters"), descriptor.filters],
    [t("reportParams.definedMeasures"), descriptor.measures],
  ];
  const shown = parts.filter(([, values]) => values.length > 0);
  if (shown.length === 0) return <p className="text-xs text-slate-400">{t("reportParams.noDefined")}</p>;
  return <div className="space-y-1 rounded-md bg-slate-50 p-2 text-xs dark:bg-slate-900/50">{shown.map(([label, values]) => <div key={label} className="flex flex-wrap gap-x-1.5"><span className="font-medium text-slate-500 dark:text-slate-400">{label}:</span><span className="text-slate-600 dark:text-slate-300">{values.join(" · ")}</span></div>)}</div>;
}

/** One attached report: its defined parameters (read-only) plus the author's
 * editable date-range / break-out / dimension-filter overrides for delivery. */
function ReportAttachmentCard({ attachment, meta, props, onChange, onRemove }: { attachment: ReportAttachment; meta?: Row; props: Props; onChange: (patch: Partial<ReportAttachment>) => void; onRemove: () => void }) {
  const t = useTranslations("close.setup");
  const [open, setOpen] = useState(false);
  const name = meta?.name ?? (((t)).has(`reports.${attachment.slug}`) ? t(`reports.${attachment.slug}`) : attachment.slug);
  const descriptor = (meta?.descriptor ?? { dateRange: null, breakouts: [], filters: [], measures: [] }) as ReportDescriptor;
  const period = attachment.period ?? "$close";
  const dimSelect = (label: string, key: keyof ReportAttachment, options: Row[]) =>
    <Field label={label}><SearchSelect value={String(attachment[key] ?? "")} onChange={(value) => onChange({ [key]: value || undefined } as Partial<ReportAttachment>)} options={options.map((option) => ({ value: option.id, label: option.name }))} clearable searchable ariaLabel={label} placeholder={t("reportParams.anyValue")} /></Field>;
  return <div className="rounded-lg border border-slate-200 dark:border-slate-800">
    <div className="flex items-center justify-between gap-2 p-3">
      <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <ChevronRight size={14} className={cn("shrink-0 text-slate-400 transition-transform", open && "rotate-90")} />
        <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{name}</span>
        {meta?.kind === "custom" ? <Badge variant="outline">{t("reportGroups.custom")}</Badge> : null}
      </button>
      <Button variant="ghost" size="sm" onClick={onRemove}><X size={14} /></Button>
    </div>
    {open ? <div className="space-y-3 border-t border-slate-200 p-3 dark:border-slate-800">
      <ReportDescriptorSummary descriptor={descriptor} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("reportParams.dateRange")}><SearchSelect value={period} onChange={(value) => onChange({ period: value })} options={periodOptions(t("reportParams.closePeriod"), t("reportParams.custom"))} searchable ariaLabel={t("reportParams.dateRange")} /></Field>
        <Field label={t("reportParams.breakout")}><Select value={attachment.breakout ?? "none"} onChange={(event) => onChange({ breakout: event.target.value })}>{BREAKOUT_DIMENSIONS.map((value) => <option key={value} value={value}>{t(`reportParams.breakouts.${value}`)}</option>)}</Select></Field>
      </div>
      {period === "custom" ? <div className="grid gap-3 sm:grid-cols-2"><Field label={t("reportParams.from")}><Input type="date" value={attachment.from ?? ""} onChange={(event) => onChange({ from: event.target.value })} /></Field><Field label={t("reportParams.to")}><Input type="date" value={attachment.to ?? ""} onChange={(event) => onChange({ to: event.target.value })} /></Field></div> : null}
      <div className="space-y-1.5">
        <Label className="text-xs uppercase tracking-wide text-slate-400">{t("reportParams.filters")}</Label>
        <div className="grid gap-3 sm:grid-cols-2">
          {dimSelect(t("reportParams.department"), "departmentId", props.dimensions.departments)}
          {dimSelect(t("reportParams.location"), "locationId", props.dimensions.locations)}
          {dimSelect(t("reportParams.class"), "classId", props.dimensions.classes)}
          {dimSelect(t("reportParams.project"), "projectId", props.dimensions.projects)}
          {props.subsidiaries.length > 0 ? dimSelect(t("reportParams.subsidiary"), "subsidiaryId", props.subsidiaries) : null}
        </div>
      </div>
    </div> : null}
  </div>;
}

function PackageDrawer({ row, props }: { row?: Row; props: Props }) {
  const t = useTranslations("close.setup");
  const td = useTranslations("close");
  const router = useRouter();
  const closeHref = drawerHref(props.currentParams, "packages", "package", null);
  const DELIVERY_KNOWN = ["format", "combine", "coverPage", "cadence"];
  const [draft, setDraft] = useState<Row>(row
    ? { id: row.id, name: dataText(td, row.name), description: dataText(td, row.description) ?? "", reports: normalizeAttachments(row.reports), recipientsText: (row.recipients ?? []).join("\n"), delivery: row.delivery ?? {}, isDefault: row.is_default, isActive: row.is_active }
    : { name: "", description: "", reports: ["profit-and-loss", "balance-sheet", "cash-flow", "trial-balance", "general-ledger"].map((slug) => ({ slug })), recipientsText: "", delivery: {}, isDefault: false, isActive: true });
  const [advancedDelivery, setAdvancedDelivery] = useState<Array<{ key: string; value: string }>>(objectToRows(row?.delivery && typeof row.delivery === "object" ? Object.fromEntries(Object.entries(row.delivery).filter(([key]) => !DELIVERY_KNOWN.includes(key))) : {}));
  const [busy, setBusy] = useState(false);
  const [sendPeriod, setSendPeriod] = useState("");
  const [sendBook, setSendBook] = useState(props.selectedBookId || props.books[0]?.id || "");
  const [sending, setSending] = useState(false);
  async function sendNow() {
    if (!draft.id || !sendPeriod || !sendBook) return;
    setSending(true);
    try {
      await post({ action: "send-package", packageId: draft.id, periodId: sendPeriod, bookId: sendBook });
      toast.success(t("packages.sendQueued"));
    } catch { toast.error(t("errors.actionFailed")); } finally { setSending(false); }
  }
  const delivery = ((draft.delivery ?? {}));
  const setDelivery = (patch: Record<string, unknown>) => setDraft({ ...draft, delivery: { ...delivery, ...patch } });
  const attachments: ReportAttachment[] = draft.reports;
  const metaBySlug = new Map(props.reportDefs.map((r) => [r.slug, r]));
  const attachedSlugs = new Set(attachments.map((item) => item.slug));
  const addOptions: Option[] = props.reportDefs
    .filter((r) => !attachedSlugs.has(r.slug))
    .map((r) => ({ value: r.slug, label: r.name, group: t(`reportGroups.${r.kind}`) }));
  const setAttachment = (index: number, patch: Partial<ReportAttachment>) =>
    setDraft({ ...draft, reports: attachments.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
  async function save() {
    setBusy(true);
    try {
      const composedDelivery = pruneEmpty({ format: delivery.format, combine: delivery.combine, coverPage: delivery.coverPage, cadence: delivery.cadence, ...rowsToObject(advancedDelivery) });
      await post({ action: "save-package", id: draft.id, name: draft.name, description: draft.description, reports: attachments, recipients: draft.recipientsText.split("\n").map((v: string) => v.trim()).filter(Boolean), delivery: composedDelivery, isDefault: draft.isDefault, isActive: draft.isActive });
      toast.success(t("messages.packageSaved"));
      router.push((closeHref));
      router.refresh();
    } catch { toast.error(t("errors.invalidConfiguration")); } finally { setBusy(false); }
  }
  return <UrlDrawer open closeHref={closeHref} size="lg" title={t("packages.formTitle")} footer={<div className="flex w-full justify-end gap-2"><Button variant="outline" onClick={() => router.push((closeHref))}>{t("actions.cancel")}</Button><Button disabled={busy || !draft.name} onClick={save}>{busy ? t("actions.saving") : t("actions.save")}</Button></div>}>
    <div className="space-y-4 p-1">
      <Field label={t("fields.name")}><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
      <Field label={t("fields.description")}><Textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
      <Field label={t("fields.reports")}>
        <div className="space-y-2">
          <SearchSelect value="" onChange={(slug) => { if (slug && !attachedSlugs.has(slug)) setDraft({ ...draft, reports: [...attachments, { slug }] }); }} options={addOptions} searchable placeholder={t("packages.addReport")} emptyLabel={t("reportsEmpty")} ariaLabel={t("packages.addReport")} />
          {attachments.length === 0 ? <p className="text-xs text-slate-400">{t("packages.noReports")}</p> : <div className="space-y-2">{attachments.map((attachment, index) => <ReportAttachmentCard key={`${attachment.slug}-${index}`} attachment={attachment} meta={metaBySlug.get(attachment.slug)} props={props} onChange={(patch) => setAttachment(index, patch)} onRemove={() => setDraft({ ...draft, reports: attachments.filter((_, i) => i !== index) })} />)}</div>}
        </div>
      </Field>
      <Field label={t("fields.recipients")} hint={t("packages.recipientsHint")}><Textarea rows={4} value={draft.recipientsText} onChange={(e) => setDraft({ ...draft, recipientsText: e.target.value })} /></Field>
      <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <div><h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t("delivery.title")}</h4><p className="text-xs text-slate-500 dark:text-slate-400">{t("delivery.intro")}</p></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("delivery.format")}><Select value={delivery.format ?? "pdf"} onChange={(e) => setDelivery({ format: e.target.value })}>{["pdf", "xlsx", "both"].map((value) => <option key={value} value={value}>{t(`delivery.formats.${value}`)}</option>)}</Select></Field>
          <Field label={t("delivery.cadence")}><Select value={delivery.cadence ?? "on_publish"} onChange={(e) => setDelivery({ cadence: e.target.value })}>{["on_publish", "manual"].map((value) => <option key={value} value={value}>{t(`delivery.cadences.${value}`)}</option>)}</Select></Field>
        </div>
        <Check checked={delivery.combine === true} onChange={(value) => setDelivery({ combine: value })}>{t("delivery.combine")}</Check>
        <Check checked={delivery.coverPage === true} onChange={(value) => setDelivery({ coverPage: value })}>{t("delivery.coverPage")}</Check>
        <details className="text-sm"><summary className="cursor-pointer text-slate-500 dark:text-slate-400">{t("delivery.advanced")}</summary><div className="pt-2"><KeyValueRows rows={advancedDelivery} onChange={setAdvancedDelivery} /></div></details>
      </div>
      <div className="space-y-2">
        <Check checked={draft.isDefault} onChange={(value) => setDraft({ ...draft, isDefault: value })}>{t("fields.defaultPackage")}</Check>
        <Check checked={draft.isActive} onChange={(value) => setDraft({ ...draft, isActive: value })}>{t("fields.active")}</Check>
      </div>
      {draft.id ? <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <div><h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t("packages.sendNowTitle")}</h4><p className="text-xs text-slate-500 dark:text-slate-400">{t("packages.sendNowHint")}</p></div>
        {props.periods.length === 0 ? <p className="text-xs text-slate-400">{t("packages.sendNoPeriods")}</p> : <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("fields.book")}><Select value={sendBook} onChange={(e) => setSendBook(e.target.value)}>{props.books.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</Select></Field>
            <Field label={t("packages.sendPeriod")}><Select value={sendPeriod} onChange={(e) => setSendPeriod(e.target.value)}><option value="">{t("packages.selectPeriod")}</option>{props.periods.map((period) => <option key={period.id} value={period.id}>{period.name}</option>)}</Select></Field>
          </div>
          <Button variant="outline" size="sm" disabled={sending || !sendPeriod || !sendBook} onClick={sendNow}><Send size={14} />{sending ? t("packages.sending") : t("packages.sendNow")}</Button>
        </>}
      </div> : null}
    </div>
  </UrlDrawer>;
}
