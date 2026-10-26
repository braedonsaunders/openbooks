"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Input,
  SearchSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  UrlDrawer,
} from "@openbooks/ui";
import { DrawerTabStrip } from "../../../../components/drawer-tab-strip";
import { JournalEntryLink } from "@/components/journal-entry-link";
import { useMoney } from "@/components/money-provider";
import { readApiErrorMessage } from "@/lib/api-error";
import type { AmortizationScheduleDrawerData } from "./view";
import { DateField } from "@/components/date-field";
import { amortizationSourceHref } from "@/lib/amortization-source-link";

export const SCHEDULE_STATUS_VARIANT: Record<
  string,
  "success" | "secondary" | "warning" | "outline" | "destructive"
> = {
  draft: "outline",
  active: "success",
  on_hold: "warning",
  completed: "secondary",
  cancelled: "destructive",
};

type ActionKey =
  "activate" | "hold" | "resume" | "change_term" | "change_destination" | "reduce" | "cancel";

/** Actions each status admits; the engine enforces the same lifecycle. */
const ACTIONS_BY_STATUS: Record<string, ActionKey[]> = {
  draft: ["activate", "change_term", "change_destination", "cancel"],
  active: ["hold", "change_term", "change_destination", "reduce", "cancel"],
  on_hold: ["resume", "change_term", "change_destination", "reduce", "cancel"],
  completed: ["reduce", "cancel"],
  cancelled: [],
};

/**
 * One amortization schedule: its facts and balances, the plan against what
 * posted by period, its history, and the governed changes it admits. Plan,
 * history and changes are sibling tabs; one body shows at a time.
 */
export function ScheduleDrawer({
  detail,
  canManage,
  closeHref,
  destinationAccounts,
}: AmortizationScheduleDrawerData) {
  const t = useTranslations("amortization");
  const { money } = useMoney();
  const s = detail.schedule;
  const [panel, setPanel] = useState<"plan" | "history" | "changes">("plan");
  const amount = (value: string | null) =>
    value === null ? "—" : money(value, { currency: s.currency });
  const actions = canManage ? (ACTIONS_BY_STATUS[s.status] ?? []) : [];
  const nextPeriod =
    detail.periods.find((period) => period.status === "planned")?.periodStart.slice(0, 7) ?? "—";
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{s.scheduleNumber}</span>
          <Badge variant={SCHEDULE_STATUS_VARIANT[s.status] ?? "secondary"}>
            {t(`status.${s.status}`)}
          </Badge>
        </span>
      }
      description={`${s.templateCode} · ${s.templateName}`}
    >
      <div className="space-y-6 p-1">
        <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label={t("drawer.total")} value={amount(s.totalAmount)} />
          <Stat label={t("drawer.amortized")} value={amount(detail.balance.amortized)} />
          <Stat label={t("drawer.remaining")} value={amount(detail.balance.remaining)} />
          <Stat label={t("drawer.nextPeriod")} value={nextPeriod} />
        </section>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <Fact label={t("drawer.source")}>
            {s.source ? (
              <SourceLink
                kind={s.source.kind}
                documentId={s.source.documentId}
                label={`${t(`sourceKind.${s.source.kind}`)} ${s.source.documentNumber ?? ""}${s.source.lineNumber ? ` · ${t("drawer.line", { line: s.source.lineNumber })}` : ""}`}
              />
            ) : (
              t("sourceKind.manual")
            )}
          </Fact>
          <Fact label={t("drawer.serviceWindow")}>{`${s.serviceStartOn} → ${s.serviceEndOn}`}</Fact>
          <Fact label={t("drawer.method")}>{t(`method.${s.method}`)}</Fact>
          <Fact label={t("drawer.deferralAccount")}>{s.deferralAccount}</Fact>
          <Fact label={t("drawer.destinationAccount")}>{s.destinationAccount}</Fact>
          <Fact label={t("drawer.subsidiary")}>{s.subsidiaryName ?? "—"}</Fact>
          <Fact label={t("drawer.currency")}>{s.currency}</Fact>
          {s.openingAmortized !== "0.0000" && (
            <Fact label={t("drawer.openingAmortized")}>{amount(s.openingAmortized)}</Fact>
          )}
          {s.holdReason && <Fact label={t("drawer.holdReason")}>{s.holdReason}</Fact>}
        </dl>

        <DrawerTabStrip
          tabs={[
            { key: "plan", label: t("drawer.planTab") },
            { key: "history", label: t("drawer.historyTab") },
            ...(actions.length > 0
              ? [{ key: "changes" as const, label: t("drawer.changesTab") }]
              : []),
          ]}
          activeKey={panel}
          onSelect={(key) => setPanel(key as typeof panel)}
          ariaLabel={s.scheduleNumber}
        />

        <div hidden={panel !== "plan"}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("drawer.period")}</TableHead>
                <TableHead>{t("drawer.account")}</TableHead>
                <TableHead className="text-right">{t("drawer.planned")}</TableHead>
                <TableHead className="text-right">{t("drawer.posted")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.periods.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-slate-500">
                    {t("drawer.noPlan")}
                  </TableCell>
                </TableRow>
              ) : (
                detail.periods.map((period) => (
                  <TableRow key={period.periodStart}>
                    <TableCell className="font-mono">{period.periodStart.slice(0, 7)}</TableCell>
                    <TableCell>{period.account}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {amount(period.planned)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {period.journalEntryId ? (
                        <JournalEntryLink
                          entryId={period.journalEntryId}
                          className="font-medium text-teal-700 dark:text-teal-300"
                        >
                          {amount(period.posted)}
                        </JournalEntryLink>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div hidden={panel !== "history"}>
          <ul className="space-y-3">
            {detail.history.map((event) => (
              <li
                key={event.id}
                className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{t(`event.${event.kind}`)}</span>
                  <span className="text-xs text-slate-500">
                    {event.effectiveOn}
                    {event.actorName ? ` · ${event.actorName}` : ""}
                  </span>
                </div>
                <p className="mt-1 text-slate-600 dark:text-slate-400">{event.reason}</p>
                {event.balanceDelta !== "0.0000" && (
                  <p className="mt-1 text-xs text-slate-500">
                    {t("drawer.balanceChange", { amount: amount(event.balanceDelta) })}
                  </p>
                )}
                {event.journalEntryId && (
                  <JournalEntryLink
                    entryId={event.journalEntryId}
                    className="mt-1 inline-block text-xs font-medium text-teal-700 dark:text-teal-300"
                  >
                    {t("drawer.viewEntry")}
                  </JournalEntryLink>
                )}
              </li>
            ))}
          </ul>
        </div>

        {actions.length > 0 && (
          <div hidden={panel !== "changes"}>
            <ScheduleChangeForm
              key={`${s.id}:${s.status}`}
              scheduleId={s.id}
              revision={s.revision}
              actions={actions}
              destinationAccounts={destinationAccounts.filter((account) =>
                account.subsidiaryIds.includes(s.subsidiaryId),
              )}
            />
          </div>
        )}
      </div>
    </UrlDrawer>
  );
}

function SourceLink({
  kind,
  documentId,
  label,
}: {
  kind: string;
  documentId: string;
  label: string;
}) {
  const href = amortizationSourceHref(kind, documentId);
  return href ? (
    <Link href={href} className="font-medium text-teal-700 dark:text-teal-300">
      {label}
    </Link>
  ) : (
    <>{label}</>
  );
}

/**
 * One governed change at a time: the operator picks the change, fills its
 * fields and a reason, and submits with the revision they reviewed. Refusals
 * show the engine's message and remedy.
 */
function ScheduleChangeForm({
  scheduleId,
  revision,
  actions,
  destinationAccounts,
}: {
  scheduleId: string;
  revision: number;
  actions: ActionKey[];
  destinationAccounts: { value: string; label: string; subsidiaryIds: string[] }[];
}) {
  const t = useTranslations("amortization");
  const router = useRouter();
  const [action, setAction] = useState<ActionKey>(actions[0]!);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [effectivePeriod, setEffectivePeriod] = useState("");
  const [newLastPeriod, setNewLastPeriod] = useState("");
  const [destinationAccountId, setDestinationAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [mode, setMode] = useState<"write_off" | "reverse">("write_off");

  function body(): Record<string, unknown> {
    const base = { action, reason, expectedRevision: revision };
    switch (action) {
      case "change_term":
        return {
          ...base,
          effectivePeriod: monthStart(effectivePeriod),
          newLastPeriod: monthStart(newLastPeriod),
        };
      case "change_destination":
        return { ...base, effectivePeriod: monthStart(effectivePeriod), destinationAccountId };
      case "reduce":
        return { ...base, amount, effectiveDate };
      case "cancel":
        return { ...base, mode, effectiveDate };
      default:
        return base;
    }
  }

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch(`/api/accounting/amortization/schedules/${scheduleId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body()),
      });
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("changes.failed")));
      toast.success(t("changes.saved"));
      setReason("");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("changes.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="text-sm font-medium">{t("changes.action")}</label>
        <SearchSelect
          value={action}
          options={actions.map((key) => ({ value: key, label: t(`changes.actions.${key}`) }))}
          onChange={(value) => value && setAction(value as ActionKey)}
          ariaLabel={t("changes.action")}
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">{t(`changes.hints.${action}`)}</p>
      </div>
      {(action === "change_term" || action === "change_destination") && (
        <Field label={t("changes.effectivePeriod")}>
          <Input
            type="month"
            value={effectivePeriod}
            onChange={(e) => setEffectivePeriod(e.target.value)}
          />
        </Field>
      )}
      {action === "change_term" && (
        <Field label={t("changes.newLastPeriod")}>
          <Input
            type="month"
            value={newLastPeriod}
            onChange={(e) => setNewLastPeriod(e.target.value)}
          />
        </Field>
      )}
      {action === "change_destination" && (
        <Field label={t("changes.destinationAccount")}>
          <SearchSelect
            value={destinationAccountId}
            options={destinationAccounts}
            onChange={(value) => setDestinationAccountId(value ?? "")}
            ariaLabel={t("changes.destinationAccount")}
          />
        </Field>
      )}
      {action === "reduce" && (
        <Field label={t("changes.amount")}>
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </Field>
      )}
      {action === "cancel" && (
        <Field label={t("changes.cancelMode")}>
          <SearchSelect
            value={mode}
            options={[
              { value: "write_off", label: t("changes.modes.write_off") },
              { value: "reverse", label: t("changes.modes.reverse") },
            ]}
            onChange={(value) => value && setMode(value as "write_off" | "reverse")}
            ariaLabel={t("changes.cancelMode")}
          />
        </Field>
      )}
      {(action === "reduce" || action === "cancel") && (
        <Field label={t("changes.effectiveDate")}>
          <DateField value={effectiveDate} onChange={(value) => setEffectiveDate(value)} />
        </Field>
      )}
      <Field label={t("changes.reason")}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
      </Field>
      <div className="flex justify-end">
        <Button onClick={submit} disabled={busy || reason.trim().length < 5}>
          {t(`changes.actions.${action}`)}
        </Button>
      </div>
    </div>
  );
}

/** `<input type="month">` yields YYYY-MM; the API takes the period's first day. */
function monthStart(value: string): string {
  return /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
