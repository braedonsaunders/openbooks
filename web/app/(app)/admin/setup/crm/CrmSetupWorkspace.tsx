"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Button,
  Card,
  CardContent,
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
  cn,
} from "@openbooks/ui";
import { toast } from "sonner";
const TABS = [
  "accountStatuses",
  "opportunityStatuses",
  "sources",
  "territories",
  "teams",
  "quotas",
] as const;
type CrmSetupTab = (typeof TABS)[number];

export function CrmSetupWorkspace({ data }: { data: any }) {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
  const router = useRouter();
  const requestedTab = useSearchParams().get("tab");
  const tab: CrmSetupTab = TABS.includes(requestedTab as CrmSetupTab)
    ? (requestedTab as CrmSetupTab)
    : "accountStatuses";
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, any>>({
    lifecycleStage: "lead",
    defaultForecastCategory: "most_likely",
    probability: "0",
    sequence: "10",
    matchMode: "all",
    rules: [],
    members: [],
    periodStart: "",
    periodEnd: "",
    currency: "CAD",
    amount: "",
  });
  async function save(action: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/crm/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...form }),
      });
      if (!response.ok) throw new Error();
      toast.success(tc("feedback.saved"));
      setForm((current) => ({
        ...current,
        name: "",
        description: "",
        amount: "",
      }));
      router.refresh();
    } catch {
      toast.error(tc("feedback.saveFailed"));
    } finally {
      setBusy(false);
    }
  }
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
            href={`/admin/setup/crm?tab=${key}`}
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
      {tab === "accountStatuses" ? (
        <SetupCard
          title={t("setup.tabs.accountStatuses")}
          onSave={() => save("save-account-status")}
          busy={busy}
        >
          <TextField
            label={tc("labels.name")}
            value={form.name ?? ""}
            onChange={(v) => setForm({ ...form, name: v })}
          />
          <SelectField
            label={t("fields.lifecycleStage")}
            value={form.lifecycleStage}
            onChange={(v) => setForm({ ...form, lifecycleStage: v })}
            options={["lead", "prospect", "customer"].map((v) => ({
              value: v,
              label: t(`stages.${v}`),
            }))}
          />
          <TextField
            label={t("setup.sequence")}
            value={form.sequence}
            onChange={(v) => setForm({ ...form, sequence: v })}
          />
          <Rows
            rows={data.accountStatuses}
            columns={["name", "lifecycle_stage", "sequence"]}
          />
        </SetupCard>
      ) : null}
      {tab === "opportunityStatuses" ? (
        <SetupCard
          title={t("setup.tabs.opportunityStatuses")}
          onSave={() => save("save-opportunity-status")}
          busy={busy}
        >
          <TextField
            label={tc("labels.name")}
            value={form.name ?? ""}
            onChange={(v) => setForm({ ...form, name: v })}
          />
          <TextField
            label={t("fields.probability")}
            value={form.probability}
            onChange={(v) => setForm({ ...form, probability: v })}
          />
          <SelectField
            label={t("fields.forecastCategory")}
            value={form.defaultForecastCategory}
            onChange={(v) => setForm({ ...form, defaultForecastCategory: v })}
            options={["omitted", "worst_case", "most_likely", "upside"].map(
              (v) => ({ value: v, label: t(`forecastCategories.${v}`) }),
            )}
          />
          <Rows
            rows={data.opportunityStatuses}
            columns={["name", "probability", "default_forecast_category"]}
          />
        </SetupCard>
      ) : null}
      {tab === "sources" ? (
        <SetupCard
          title={t("setup.tabs.sources")}
          onSave={() => save("save-lead-source")}
          busy={busy}
        >
          <TextField
            label={tc("labels.name")}
            value={form.name ?? ""}
            onChange={(v) => setForm({ ...form, name: v })}
          />
          <TextField
            label={t("fields.description")}
            value={form.description ?? ""}
            onChange={(v) => setForm({ ...form, description: v })}
          />
          <Rows rows={data.sources} columns={["name", "description"]} />
        </SetupCard>
      ) : null}
      {tab === "territories" ? (
        <SetupCard
          title={t("setup.tabs.territories")}
          onSave={() => save("save-territory")}
          busy={busy}
        >
          <TextField
            label={tc("labels.name")}
            value={form.name ?? ""}
            onChange={(v) => setForm({ ...form, name: v })}
          />
          <TextField
            label={t("setup.priority")}
            value={form.priority ?? "100"}
            onChange={(v) => setForm({ ...form, priority: v })}
          />
          <SelectField
            label={t("setup.defaultOwner")}
            value={form.defaultOwnerUserId ?? ""}
            onChange={(v) =>
              setForm({ ...form, defaultOwnerUserId: v || null })
            }
            options={[
              { value: "", label: t("fields.unassigned") },
              ...data.users.map((u: any) => ({ value: u.id, label: u.name })),
            ]}
          />
          <Rows
            rows={data.territories}
            columns={["name", "priority", "owner_name"]}
          />
        </SetupCard>
      ) : null}
      {tab === "teams" ? (
        <SetupCard
          title={t("setup.tabs.teams")}
          onSave={() => save("save-team")}
          busy={busy}
        >
          <TextField
            label={tc("labels.name")}
            value={form.name ?? ""}
            onChange={(v) => setForm({ ...form, name: v })}
          />
          <SelectField
            label={t("setup.manager")}
            value={form.managerUserId ?? ""}
            onChange={(v) =>
              setForm({
                ...form,
                managerUserId: v || null,
                members: v ? [{ userId: v, role: "manager" }] : [],
              })
            }
            options={[
              { value: "", label: t("fields.unassigned") },
              ...data.users.map((u: any) => ({ value: u.id, label: u.name })),
            ]}
          />
          <Rows rows={data.teams} columns={["name", "manager_name"]} />
        </SetupCard>
      ) : null}
      {tab === "quotas" ? (
        <SetupCard
          title={t("setup.tabs.quotas")}
          onSave={() => save("save-quota")}
          busy={busy}
        >
          <SelectField
            label={t("forecasts.target")}
            value={form.ownerUserId ?? ""}
            onChange={(v) =>
              setForm({ ...form, ownerUserId: v || null, salesTeamId: null })
            }
            options={[
              { value: "", label: t("fields.unassigned") },
              ...data.users.map((u: any) => ({ value: u.id, label: u.name })),
            ]}
          />
          <TextField
            label={t("fields.periodStart")}
            type="date"
            value={form.periodStart}
            onChange={(v) => setForm({ ...form, periodStart: v })}
          />
          <TextField
            label={t("fields.periodEnd")}
            type="date"
            value={form.periodEnd}
            onChange={(v) => setForm({ ...form, periodEnd: v })}
          />
          <TextField
            label={t("forecasts.quota")}
            value={form.amount}
            onChange={(v) => setForm({ ...form, amount: v })}
          />
          <Rows
            rows={data.quotas}
            columns={["owner_name", "period_start", "period_end", "amount"]}
          />
        </SetupCard>
      ) : null}
    </div>
  );
}
function SetupCard({
  title,
  onSave,
  busy,
  children,
}: {
  title: string;
  onSave: () => void;
  busy: boolean;
  children: React.ReactNode;
}) {
  const tc = useTranslations("common");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-5 grid gap-4 sm:grid-cols-3">{children}</div>
        <Button onClick={onSave} disabled={busy}>
          {busy ? tc("actions.saving") : tc("actions.save")}
        </Button>
      </CardContent>
    </Card>
  );
}
function TextField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
function Rows({ rows, columns }: { rows: any[]; columns: string[] }) {
  const t = useTranslations("crm");
  return (
    <div className="sm:col-span-3">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c}>{t(`setup.columns.${c}`)}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              {columns.map((c) => (
                <TableCell key={c}>{r[c] ?? "—"}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
