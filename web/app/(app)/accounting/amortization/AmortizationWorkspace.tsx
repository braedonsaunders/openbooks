"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Badge, Button, Drawer, Input, SearchSelect, Textarea } from "@openbooks/ui";
import { PagedTable } from "../../../../components/paged-table";
import { useMoney } from "@/components/money-provider";
import { readApiErrorMessage } from "@/lib/api-error";
import { SCHEDULE_STATUS_VARIANT } from "./ScheduleDrawer";
import type {
  AmortizationDueRow,
  AmortizationNewScheduleData,
  AmortizationReconciliationRow,
  AmortizationScheduleRow,
} from "./view";
import { DateField } from "@/components/date-field";

const CELL = "px-4 py-2.5";
const HEAD = "px-4 py-2 font-medium";

function searchText(row: object): string {
  return Object.values(row)
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ");
}

/** The schedule list, filtered by status, each row opening its drawer. */
export function AmortizationSchedulesPanel({
  rows,
  statusTabs,
  templatesHref,
  waterfallHref,
}: {
  rows: AmortizationScheduleRow[];
  statusTabs: { href: string; label: string; active: boolean }[];
  templatesHref: string;
  waterfallHref: string | null;
}) {
  const t = useTranslations("amortization");
  const { money } = useMoney();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex flex-wrap gap-1" aria-label={t("list.statusFilter")}>
          {statusTabs.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={tab.active ? "page" : undefined}
              className={
                tab.active
                  ? "rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-slate-100 dark:text-slate-900"
                  : "rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              }
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <div className="flex gap-3 text-xs">
          <Link href={templatesHref} className="font-medium text-teal-700 dark:text-teal-300">
            {t("list.templates")}
          </Link>
          {waterfallHref && (
            <Link href={waterfallHref} className="font-medium text-teal-700 dark:text-teal-300">
              {t("list.waterfall")}
            </Link>
          )}
        </div>
      </div>
      <PagedTable
        prepared
        searchable
        source="amortization_schedules"
        rows={rows}
        rowKey={(row) => row.id}
        empty={t("list.empty")}
        columns={[
          {
            key: "number",
            header: <>{t("list.columns.number")}</>,
            headerClassName: HEAD,
            className: CELL,
            cell: (row) => (
              <Link
                className="font-mono font-medium text-teal-700 hover:underline dark:text-teal-300"
                href={row.href}
              >
                {row.number}
              </Link>
            ),
            search: searchText,
          },
          {
            key: "status",
            header: <>{t("list.columns.status")}</>,
            headerClassName: HEAD,
            className: CELL,
            cell: (row) => (
              <Badge variant={SCHEDULE_STATUS_VARIANT[row.status] ?? "secondary"}>
                {t(`status.${row.status}`)}
              </Badge>
            ),
          },
          {
            key: "source",
            header: <>{t("list.columns.source")}</>,
            headerClassName: HEAD,
            className: CELL,
            cell: (row) =>
              row.sourceHref ? (
                <Link
                  className="text-teal-700 hover:underline dark:text-teal-300"
                  href={row.sourceHref}
                >
                  {row.source}
                </Link>
              ) : (
                <>{row.source}</>
              ),
          },
          {
            key: "template",
            header: <>{t("list.columns.template")}</>,
            headerClassName: HEAD,
            className: CELL,
            cell: (row) => <>{row.template}</>,
          },
          {
            key: "subsidiary",
            header: <>{t("list.columns.subsidiary")}</>,
            headerClassName: HEAD,
            className: CELL,
            cell: (row) => <>{row.subsidiary}</>,
          },
          {
            key: "total",
            header: <>{t("list.columns.total")}</>,
            headerClassName: `${HEAD} text-right`,
            className: `${CELL} text-right tabular-nums`,
            cell: (row) => <>{money(row.total, { currency: row.currency })}</>,
            sortValue: (row) => row.total,
            sortType: "decimal",
            sortKey: "total",
          },
          {
            key: "remaining",
            header: <>{t("list.columns.remaining")}</>,
            headerClassName: `${HEAD} text-right`,
            className: `${CELL} text-right tabular-nums`,
            cell: (row) => <>{money(row.remaining, { currency: row.currency })}</>,
            sortValue: (row) => row.remaining,
            sortType: "decimal",
            sortKey: "remaining",
          },
          {
            key: "next",
            header: <>{t("list.columns.nextPeriod")}</>,
            headerClassName: HEAD,
            className: `${CELL} font-mono`,
            cell: (row) => <>{row.nextPeriod ?? "—"}</>,
          },
        ]}
      />
    </div>
  );
}

/**
 * The period run: pick the period, review what is due through its end, and
 * post it. Each problem (a closed period, an inactive book) is listed with
 * its remedy; the rest of the run is unaffected.
 */
export function AmortizationRunPanel({
  periods,
  selectedPeriodId,
  due,
  canManage,
}: {
  periods: { id: string; name: string; endsOn: string }[];
  selectedPeriodId: string | null;
  due: AmortizationDueRow[];
  canManage: boolean;
}) {
  const t = useTranslations("amortization");
  const { money } = useMoney();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<
    { scheduleNumber: string; periodStart: string; message: string; remedy: string }[]
  >([]);

  async function run() {
    if (!selectedPeriodId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/accounting/amortization/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodId: selectedPeriodId }),
      });
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("run.failed")));
      const result = (await res.json()) as {
        posted: number;
        problems: {
          scheduleNumber: string;
          periodStart: string;
          message: string;
          remedy: string;
        }[];
      };
      toast.success(t("run.saved", { posted: result.posted }));
      setProblems(result.problems);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("run.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 space-y-1">
          <label className="text-sm font-medium">{t("run.period")}</label>
          <SearchSelect
            value={selectedPeriodId ?? ""}
            options={periods.map((period) => ({ value: period.id, label: period.name }))}
            onChange={(value) =>
              value && router.push(`/accounting/amortization?view=run&period=${value}`)
            }
            ariaLabel={t("run.period")}
          />
        </div>
        {canManage && (
          <Button onClick={run} disabled={busy || !selectedPeriodId || due.length === 0}>
            {t("run.submit", { count: due.length })}
          </Button>
        )}
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400">{t("run.description")}</p>
      {problems.length > 0 && (
        <ul className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          {problems.map((problem) => (
            <li key={`${problem.scheduleNumber}:${problem.periodStart}`}>
              <span className="font-mono">{problem.scheduleNumber}</span> ·{" "}
              {problem.periodStart.slice(0, 7)} — {problem.message} {problem.remedy}
            </li>
          ))}
        </ul>
      )}
      <PagedTable
        prepared
        searchable
        source="amortization_due"
        rows={due}
        rowKey={(row) => row.id}
        empty={t("run.empty")}
        columns={[
          {
            key: "schedule",
            header: <>{t("run.columns.schedule")}</>,
            headerClassName: HEAD,
            className: CELL,
            cell: (row) => (
              <Link
                className="font-mono font-medium text-teal-700 hover:underline dark:text-teal-300"
                href={row.scheduleHref}
              >
                {row.scheduleNumber}
              </Link>
            ),
            search: searchText,
          },
          {
            key: "period",
            header: <>{t("run.columns.period")}</>,
            headerClassName: HEAD,
            className: `${CELL} font-mono`,
            cell: (row) => <>{row.period}</>,
          },
          {
            key: "account",
            header: <>{t("run.columns.account")}</>,
            headerClassName: HEAD,
            className: CELL,
            cell: (row) => <>{row.account}</>,
          },
          {
            key: "amount",
            header: <>{t("run.columns.amount")}</>,
            headerClassName: `${HEAD} text-right`,
            className: `${CELL} text-right tabular-nums`,
            cell: (row) => <>{money(row.amount, { currency: row.currency })}</>,
          },
        ]}
      />
    </div>
  );
}

/**
 * The deferral-account reconciliation as of a date: the ledger balance of
 * each deferral account beside the schedules' unamortized balance, by book,
 * subsidiary and currency. A difference names an unexplained posting.
 */
export function AmortizationReconciliationPanel({
  asOf,
  rows,
  reportHref,
}: {
  asOf: string;
  rows: AmortizationReconciliationRow[];
  reportHref: string | null;
}) {
  const t = useTranslations("amortization");
  const { money } = useMoney();
  const router = useRouter();
  const tied = rows.every((row) => row.difference === "0.0000");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="amortization-as-of">
            {t("reconciliation.asOf")}
          </label>
          <DateField
            id="amortization-as-of"
            defaultValue={asOf}
            onChange={(value) =>
              value && router.push(`/accounting/amortization?view=reconciliation&asOf=${value}`)
            }
          />
        </div>
        {reportHref && (
          <Link href={reportHref} className="text-xs font-medium text-teal-700 dark:text-teal-300">
            {t("reconciliation.report")}
          </Link>
        )}
      </div>
      {rows.length > 0 && (
        <p
          className={
            tied
              ? "text-sm text-emerald-700 dark:text-emerald-300"
              : "text-sm text-amber-700 dark:text-amber-300"
          }
        >
          {tied ? t("reconciliation.tied") : t("reconciliation.untied")}
        </p>
      )}
      <PagedTable
        prepared
        source="amortization_reconciliation"
        rows={rows}
        rowKey={(row) => row.id}
        empty={t("reconciliation.empty")}
        searchable={false}
        columns={[
          {
            key: "account",
            header: <>{t("reconciliation.columns.account")}</>,
            headerClassName: HEAD,
            className: CELL,
            cell: (row) => <>{row.account}</>,
          },
          {
            key: "subsidiary",
            header: <>{t("reconciliation.columns.subsidiary")}</>,
            headerClassName: HEAD,
            className: CELL,
            cell: (row) => <>{row.subsidiary}</>,
          },
          {
            key: "book",
            header: <>{t("reconciliation.columns.book")}</>,
            headerClassName: HEAD,
            className: CELL,
            cell: (row) => <>{row.book}</>,
          },
          {
            key: "ledger",
            header: <>{t("reconciliation.columns.ledger")}</>,
            headerClassName: `${HEAD} text-right`,
            className: `${CELL} text-right tabular-nums`,
            cell: (row) => <>{money(row.ledger, { currency: row.currency })}</>,
          },
          {
            key: "subledger",
            header: <>{t("reconciliation.columns.subledger")}</>,
            headerClassName: `${HEAD} text-right`,
            className: `${CELL} text-right tabular-nums`,
            cell: (row) => <>{money(row.subledger, { currency: row.currency })}</>,
          },
          {
            key: "difference",
            header: <>{t("reconciliation.columns.difference")}</>,
            headerClassName: `${HEAD} text-right`,
            className: `${CELL} text-right tabular-nums`,
            cell: (row) => (
              <span
                className={
                  row.difference === "0.0000"
                    ? ""
                    : "font-semibold text-amber-700 dark:text-amber-300"
                }
              >
                {money(row.difference, { currency: row.currency })}
              </span>
            ),
          },
          {
            key: "open",
            header: <>{t("reconciliation.columns.openSchedules")}</>,
            headerClassName: `${HEAD} text-right`,
            className: `${CELL} text-right tabular-nums`,
            cell: (row) => <>{row.openSchedules}</>,
          },
        ]}
      />
    </div>
  );
}

/**
 * Record a manual schedule for a prepaid balance carried in from elsewhere.
 * It is saved as a draft that posts nothing; activation starts amortization.
 */
export function AmortizationNewScheduleButton({
  data,
  templatesHref,
}: {
  data: AmortizationNewScheduleData | null;
  templatesHref: string;
}) {
  const t = useTranslations("amortization");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    bookId: data?.books[0]?.id ?? "",
    templateId: "",
    subsidiaryId: data?.subsidiaries[0]?.id ?? "",
    totalAmount: "",
    openingAmortizedAmount: "",
    serviceStartOn: "",
    serviceEndOn: "",
    amortizeFromPeriod: "",
    destinationAccountId: "",
    memo: "",
    reason: "",
  });
  if (!data) return null;
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (
        key === "subsidiaryId" &&
        !data.destinationAccounts
          .find((account) => account.value === current.destinationAccountId)
          ?.subsidiaryIds.includes(value)
      )
        next.destinationAccountId = "";
      return next;
    });

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/accounting/amortization/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookId: form.bookId || null,
          templateId: form.templateId,
          subsidiaryId: form.subsidiaryId,
          totalAmount: form.totalAmount,
          ...(form.openingAmortizedAmount
            ? { openingAmortizedAmount: form.openingAmortizedAmount }
            : {}),
          serviceStartOn: form.serviceStartOn,
          serviceEndOn: form.serviceEndOn || null,
          amortizeFromPeriod: /^\d{4}-\d{2}$/.test(form.amortizeFromPeriod)
            ? `${form.amortizeFromPeriod}-01`
            : null,
          destinationAccountId: form.destinationAccountId || null,
          memo: form.memo || null,
          reason: form.reason,
        }),
      });
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("newSchedule.failed")));
      const created = (await res.json()) as { scheduleId: string; scheduleNumber: string };
      toast.success(t("newSchedule.saved", { number: created.scheduleNumber }));
      setOpen(false);
      router.push(`/accounting/amortization?schedule=${created.scheduleId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("newSchedule.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>{t("newSchedule.open")}</Button>
      {open && (
        <Drawer
          open
          onClose={() => setOpen(false)}
          title={t("newSchedule.title")}
          description={t("newSchedule.description")}
        >
          <div className="space-y-4 p-4">
            {data.templates.length === 0 ? (
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {t("newSchedule.noTemplates")}{" "}
                <Link href={templatesHref} className="font-medium text-teal-700 dark:text-teal-300">
                  {t("list.templates")}
                </Link>
              </p>
            ) : (
              <>
                <Field label={t("newSchedule.template")}>
                  <SearchSelect
                    value={form.templateId}
                    options={data.templates.map((x) => ({ value: x.id, label: x.label }))}
                    onChange={(v) => set("templateId")(v ?? "")}
                    ariaLabel={t("newSchedule.template")}
                  />
                </Field>
                {data.books.length > 1 && (
                  <Field label={t("reconciliation.columns.book")}>
                    <SearchSelect
                      value={form.bookId}
                      options={data.books.map((book) => ({ value: book.id, label: book.label }))}
                      onChange={(value) => set("bookId")(value ?? "")}
                      ariaLabel={t("reconciliation.columns.book")}
                    />
                  </Field>
                )}
                <Field label={t("newSchedule.subsidiary")}>
                  <SearchSelect
                    value={form.subsidiaryId}
                    options={data.subsidiaries.map((x) => ({ value: x.id, label: x.label }))}
                    onChange={(v) => set("subsidiaryId")(v ?? "")}
                    ariaLabel={t("newSchedule.subsidiary")}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label={`${t("newSchedule.totalAmount")} (${data.books.find((book) => book.id === form.bookId)?.currencies[form.subsidiaryId] ?? "—"})`}
                  >
                    <Input
                      inputMode="decimal"
                      value={form.totalAmount}
                      onChange={(e) => set("totalAmount")(e.target.value)}
                      placeholder="0.00"
                    />
                  </Field>
                  <Field label={t("newSchedule.openingAmortized")}>
                    <Input
                      inputMode="decimal"
                      value={form.openingAmortizedAmount}
                      onChange={(e) => set("openingAmortizedAmount")(e.target.value)}
                      placeholder="0.00"
                    />
                  </Field>
                  <Field label={t("newSchedule.serviceStart")}>
                    <DateField
                      value={form.serviceStartOn}
                      onChange={(value) => set("serviceStartOn")(value)}
                    />
                  </Field>
                  <Field label={t("newSchedule.serviceEnd")}>
                    <DateField
                      value={form.serviceEndOn}
                      onChange={(value) => set("serviceEndOn")(value)}
                    />
                  </Field>
                  <Field label={t("newSchedule.amortizeFrom")}>
                    <Input
                      type="month"
                      value={form.amortizeFromPeriod}
                      onChange={(e) => set("amortizeFromPeriod")(e.target.value)}
                    />
                  </Field>
                </div>
                <Field label={t("newSchedule.destinationAccount")}>
                  <SearchSelect
                    value={form.destinationAccountId}
                    options={data.destinationAccounts.filter((account) =>
                      account.subsidiaryIds.includes(form.subsidiaryId),
                    )}
                    onChange={(v) => set("destinationAccountId")(v ?? "")}
                    ariaLabel={t("newSchedule.destinationAccount")}
                    clearable
                  />
                </Field>
                <Field label={t("newSchedule.memo")}>
                  <Input value={form.memo} onChange={(e) => set("memo")(e.target.value)} />
                </Field>
                <Field label={t("newSchedule.reason")}>
                  <Textarea
                    value={form.reason}
                    onChange={(e) => set("reason")(e.target.value)}
                    rows={3}
                  />
                </Field>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setOpen(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    onClick={submit}
                    disabled={
                      busy ||
                      !form.templateId ||
                      !form.subsidiaryId ||
                      !form.totalAmount ||
                      !form.serviceStartOn ||
                      form.reason.trim().length < 5
                    }
                  >
                    {t("newSchedule.submit")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </Drawer>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}
