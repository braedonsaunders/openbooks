"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Alert, AlertDescription, Badge, Button } from "@openbooks/ui";
import type { RemittanceEntitySlice, RemittanceGroup } from "@openbooks/engine/payroll/remittance";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { PagedTable, type PagedColumn } from "../../../../components/paged-table";
import { useMoney } from "../../../../components/money-provider";
import { DateField } from "../../../../components/date-field";

/**
 * Remittances list: one row per destination (CRA vendor, union funds,
 * unassigned components) and payroll filing account, with the period's accrued
 * amounts per component and a one-click draft vendor bill. Already-raised
 * bills for the same period show inline so a double remittance is an explicit,
 * visible choice.
 */

/** Row identity — mirrors the engine's (destination, filing account) group. */
const groupKey = (partyId: string | null, filingAccountId: string | null) =>
  `${partyId ?? "unassigned"}::${filingAccountId ?? ""}`;

/** Search text mirrors the displayed row: destination, filing account,
// currency and component names. Internal accrual rows never cross over. */
function groupSearchText(group: RemittanceGroup): string {
  return [
    group.partyName,
    group.filingAccount.accountNumber,
    group.filingAccount.name,
    group.currency,
    ...group.components.flatMap((component) => [component.name, component.accountLabel]),
  ]
    .map((value) => String(value ?? ""))
    .join(" ");
}

export function RemittancesView({
  groups,
  from,
  to,
  canCreate,
  populationRefusal,
}: {
  groups: RemittanceGroup[];
  from: string;
  to: string;
  canCreate: boolean;
  populationRefusal?: string | null;
}) {
  const t = useTranslations("payroll.remittances");
  const router = useRouter();
  const [busyParty, setBusyParty] = useState<string | null>(null);
  // The applied period arrives as props on every navigation (Apply, browser
  // Back and Forward) while this view stays mounted. The draft follows the
  // applied period, so a stale draft can never silently disable the bill
  // actions.
  const [applied, setApplied] = useState({ from, to });
  const [range, setRange] = useState({ from, to });
  if (applied.from !== from || applied.to !== to) {
    setApplied({ from, to });
    setRange({ from, to });
  }
  const rangeChanged = range.from !== from || range.to !== to;

  async function createBill(
    partyId: string,
    filingAccountId: string | null,
    subsidiaryId: string | null,
  ) {
    // The rows and their totals represent the server-applied period. Never
    // create a bill for dates that the operator has only entered as a draft.
    if (rangeChanged) {
      toast.error(t("applyPeriodFirst"));
      return;
    }
    setBusyParty(`${groupKey(partyId, filingAccountId)}::${subsidiaryId ?? ""}`);
    try {
      const res = await fetch("/api/payroll/remittances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-bill",
          partyId,
          filingAccountId,
          subsidiaryId,
          from,
          to,
        }),
      });
      // The status is checked before the body is parsed: a non-JSON error body
      // (this route rethrows non-domain errors as an unhandled empty 500) must
      // surface the failure, never a SyntaxError from res.json().
      if (!res.ok)
        throw new Error(await readApiErrorMessage(res, "failed to create the remittance bill"));
      const j = await res.json();
      toast.success(t("billCreated", { number: j.documentNumber }));
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyParty(null);
    }
  }

  // The period sits on the list toolbar beside search, like every other
  // list filter. It applies explicitly: bill actions always act on the
  // period the rows were read for, never on an unapplied draft.
  const period = (
    <form
      className="flex flex-wrap items-center gap-1.5"
      action="/payroll/remittances"
      method="get"
    >
      <DateField
        name="from"
        aria-label={t("from")}
        className="w-auto"
        value={range.from}
        onChange={(value) => setRange((r) => ({ ...r, from: value }))}
      />
      <span aria-hidden className="text-slate-400 dark:text-slate-500">
        –
      </span>
      <DateField
        name="to"
        aria-label={t("to")}
        className="w-auto"
        value={range.to}
        onChange={(value) => setRange((r) => ({ ...r, to: value }))}
      />
      <Button type="submit" variant="outline">
        {t("apply")}
      </Button>
      {rangeChanged ? (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
          {t("applyPeriodFirst")}
        </p>
      ) : null}
    </form>
  );

  if (populationRefusal) {
    return (
      <div className="space-y-3">
        {period}
        <Alert variant="warning">
          <AlertDescription>{populationRefusal}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const columns: PagedColumn<RemittanceGroup>[] = [
    {
      key: "destination",
      header: t("columns.destination"),
      cell: (group) => <DestinationCell group={group} />,
      search: groupSearchText,
    },
    {
      key: "due",
      header: t("columns.due"),
      cell: (group) =>
        group.schedule ? (
          // A pack-declared destination schedule (Revenu Québec's) dates the
          // bill from the destination's own timetable and names the rule.
          // Destinations without one show nothing: their due date is stamped
          // when the bill is created.
          <div className="min-w-40">
            <p className="text-sm text-slate-700 dark:text-slate-300">
              {t("dueOn", { dueDate: group.schedule.dueDate, authority: group.schedule.authority })}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{group.schedule.rule}</p>
          </div>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      key: "components",
      header: t("columns.components"),
      cell: (group) => <ComponentsCell group={group} />,
    },
    {
      key: "employees",
      header: t("columns.employees"),
      align: "right",
      cell: (group) => <span className="tabular-nums">{group.employeeCount}</span>,
    },
    {
      key: "gross",
      header: t("columns.gross"),
      align: "right",
      cell: (group) => <GroupAmount currency={group.currency} amount={group.grossPayroll} />,
    },
    {
      key: "total",
      header: t("total"),
      align: "right",
      cell: (group) => <GroupAmount currency={group.currency} amount={group.total} strong />,
    },
    {
      key: "actions",
      header: <span className="sr-only">{t("columns.actions")}</span>,
      align: "right",
      cell: (group) => (
        <GroupActions
          group={group}
          canCreate={canCreate}
          busy={busyParty !== null}
          rangeChanged={rangeChanged}
          onCreate={(subsidiaryId) =>
            void createBill(group.partyId!, group.filingAccount.id, subsidiaryId)
          }
        />
      ),
    },
  ];

  return (
    <PagedTable
      source="payroll_remittance_groups"
      rows={groups}
      rowKey={(group) => groupKey(group.partyId, group.filingAccount.id)}
      searchable
      emptyAsRow
      toolbarAfter={period}
      empty={t("empty")}
      columns={columns}
    />
  );
}

/** An amount stated in the group's own currency — a EUR-only scope under a
 * GBP org formats as euros, never pounds. */
function GroupAmount({
  currency,
  amount,
  strong,
}: {
  currency: string;
  amount: string;
  strong?: boolean;
}) {
  const { money } = useMoney(currency);
  return (
    <span className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>{money(amount)}</span>
  );
}

function DestinationCell({ group }: { group: RemittanceGroup }) {
  const t = useTranslations("payroll.remittances");
  return (
    <div className="min-w-48 space-y-1">
      <p className="font-medium text-slate-900 dark:text-slate-100">
        {group.partyName ?? t("unassigned")}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {/* A PD7A is filed per payroll program account, so each account
            remits on its own bill. */}
        {group.filingAccount.accountNumber && (
          <Badge variant="outline">
            {group.filingAccount.accountNumber}
            {group.filingAccount.name ? ` · ${group.filingAccount.name}` : ""}
          </Badge>
        )}
        {/* The stated currency of every amount in the row. An ISO code, like
            the account number beside it, is data rather than prose. */}
        {group.currency && <Badge variant="outline">{group.currency}</Badge>}
      </div>
      {group.translated && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t("translated", { currency: group.currency })}
        </p>
      )}
    </div>
  );
}

/** The period's accrued components for one destination, each with its kind
 * and liability account, in the group's currency. */
function ComponentsCell({ group }: { group: RemittanceGroup }) {
  const t = useTranslations("payroll.remittances");
  const { money } = useMoney(group.currency);
  if (group.components.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <ul className="min-w-56 space-y-0.5">
      {group.components.map((component) => (
        <li key={component.componentId} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0">
            <span className="text-slate-700 dark:text-slate-200">{component.name}</span>
            <span className="ml-1.5 text-xs text-slate-500 dark:text-slate-400">
              {component.kind === "deduction" ? t("withheld") : t("employer")}
              {" · "}
              {component.accountLabel ?? t("noAccount")}
            </span>
          </span>
          <span className="shrink-0 tabular-nums">{money(component.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Already-raised bills for the period plus the one available remedy: create
 * a bill, attribute the runs to a legal entity, or assign a vendor. */
function GroupActions({
  group,
  canCreate,
  busy,
  rangeChanged,
  onCreate,
}: {
  group: RemittanceGroup;
  canCreate: boolean;
  busy: boolean;
  rangeChanged: boolean;
  onCreate: (subsidiaryId: string | null) => void;
}) {
  const t = useTranslations("payroll.remittances");
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {group.existingBills.map((bill) => (
        <Link
          key={bill.documentId}
          href={`/ap/bills?doc=${bill.documentId}` as never}
          className="inline-flex items-center gap-1.5 text-xs"
        >
          <Badge variant="outline">
            {bill.documentNumber} · {bill.status}
          </Badge>
        </Link>
      ))}
      {group.hasEntitylessAccruals ? (
        <Link
          className="text-xs font-medium text-teal-700 underline dark:text-teal-300"
          href={"/payroll/runs" as never}
        >
          {t("attributeEntity")}
        </Link>
      ) : group.partyId ? (
        canCreate &&
        (group.slices.length > 1 ? (
          group.slices.map((slice) => (
            <SliceBillButton
              key={slice.subsidiaryId}
              slice={slice}
              busy={busy || rangeChanged}
              onCreate={() => onCreate(slice.subsidiaryId)}
            />
          ))
        ) : (
          <Button
            size="sm"
            disabled={busy || rangeChanged}
            onClick={() =>
              onCreate(group.slices.length === 1 ? group.slices[0]!.subsidiaryId : null)
            }
          >
            {group.existingBills.length > 0 ? t("createAnother") : t("createBill")}
          </Button>
        ))
      ) : (
        <Link
          className="text-xs font-medium text-teal-700 underline dark:text-teal-300"
          href={"/admin/setup/payroll?tab=components" as never}
        >
          {t("assignVendor")}
        </Link>
      )}
    </div>
  );
}

/**
 * One bill button per legal entity. A multi-entity group's row shows the
 * consolidated total, so each button names its own entity and native share —
 * formatted in the entity's currency, never the org's — or the operator
 * cannot tell the two drafts apart. Single-entity groups show one button.
 */
function SliceBillButton({
  slice,
  busy,
  onCreate,
}: {
  slice: RemittanceEntitySlice;
  busy: boolean;
  onCreate: () => void;
}) {
  const t = useTranslations("payroll.remittances");
  const { money } = useMoney(slice.currency);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={onCreate}
      title={`${slice.subsidiaryName ?? slice.subsidiaryId} · ${money(slice.total)}`}
    >
      {slice.existingBills.length > 0 ? t("createAnother") : t("createBill")}
      {" · "}
      {slice.subsidiaryName ?? slice.subsidiaryId}
    </Button>
  );
}
