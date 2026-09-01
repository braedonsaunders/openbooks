"use client";

import { useTranslations } from "next-intl";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@openbooks/ui";
import { Empty, Status } from "./workspace-ui";
import type { DepositRow, LeaseRow, Money, ScheduleRow } from "./types";

export function LeasesTable({ leases, money, onOpen }: { leases: LeaseRow[]; money: Money; onOpen: (id: string) => void }) {
  const t = useTranslations("entities.propertyManagement");
  if (!leases.length)
    return (
      <Empty
        title={t("detail.leases.emptyTitle")}
        detail={t("detail.leases.emptyDetail")}
      />
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("detail.leases.table.lease")}</TableHead>
          <TableHead>{t("detail.leases.table.unit")}</TableHead>
          <TableHead>{t("detail.leases.table.tenant")}</TableHead>
          <TableHead>{t("detail.leases.table.term")}</TableHead>
          <TableHead>{t("detail.leases.table.status")}</TableHead>
          <TableHead className="text-right">{t("workspace.metrics.depositsHeld")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {leases.map((lease) => (
          <TableRow
            key={lease.id}
            role="button"
            tabIndex={0}
            className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600"
            onClick={() => onOpen(lease.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(lease.id);
              }
            }}
          >
            <TableCell className="font-medium">{lease.leaseNumber}</TableCell>
            <TableCell>
              {lease.propertyName}
              {lease.unitCode ? ` · ${lease.unitCode}` : ""}
            </TableCell>
            <TableCell>{lease.tenantName}</TableCell>
            <TableCell>
              {lease.startsOn} – {lease.endsOn || t("detail.leases.openTerm")}
            </TableCell>
            <TableCell>
              <Status value={lease.status} />
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {money(lease.depositBalance, { currency: lease.currency })}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RentTable({ schedules, leases, money }: { schedules: ScheduleRow[]; leases: LeaseRow[]; money: Money }) {
  const t = useTranslations("entities.propertyManagement");
  const tc = useTranslations("common");
  if (!schedules.length)
    return (
      <Empty
        title={t("detail.rent.title")}
        detail={t("detail.rent.description")}
      />
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc("labels.dueDate")}</TableHead>
          <TableHead>{t("detail.leases.table.lease")}</TableHead>
          <TableHead>{t("leaseSections.charges.table.charge")}</TableHead>
          <TableHead>{tc("labels.period")}</TableHead>
          <TableHead>{t("detail.leases.table.status")}</TableHead>
          <TableHead>{tc("transactionTypes.invoice")}</TableHead>
          <TableHead className="text-right">{tc("labels.amount")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {schedules.slice(0, 300).map((line) => {
          const lease = leases.find((item) => item.id === line.leaseId);
          return (
            <TableRow key={line.id}>
              <TableCell>{line.dueOn}</TableCell>
              <TableCell>{lease?.leaseNumber ?? "—"}</TableCell>
              <TableCell>{line.description}</TableCell>
              <TableCell>
                {line.periodStartsOn} – {line.periodEndsOn}
              </TableCell>
              <TableCell>
                <Status value={line.status} />
              </TableCell>
              <TableCell>{line.invoiceNumber || "—"}</TableCell>
              <TableCell className="text-right tabular-nums">
                {money(
                  line.amount,
                  lease?.currency ? { currency: lease.currency } : undefined,
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function DepositTable({ deposits, leases, money, onReverse }: { deposits: DepositRow[]; leases: LeaseRow[]; money: Money; onReverse?: (row: DepositRow) => void }) {
  const t = useTranslations("entities.propertyManagement");
  const tc = useTranslations("common");
  if (!deposits.length)
    return (
      <Empty
        title={t("leaseSections.deposits.emptyTitle")}
        detail={t("leaseSections.deposits.emptyDetail")}
      />
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc("labels.date")}</TableHead>
          <TableHead>{t("detail.leases.table.lease")}</TableHead>
          <TableHead>{t("leaseSections.deposits.labels.transaction")}</TableHead>
          <TableHead>{tc("labels.memo")}</TableHead>
          <TableHead>{tc("transactionTypes.journal")}</TableHead>
          <TableHead className="text-right">{tc("labels.amount")}</TableHead>
          {onReverse ? <TableHead className="text-right">{tc("labels.actions")}</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {deposits.map((row) => {
          const lease = leases.find((item) => item.id === row.leaseId);
          return (
            <TableRow key={row.id}>
              <TableCell>{row.occurredOn}</TableCell>
              <TableCell>{lease?.leaseNumber ?? "—"}</TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-2">
                  <Status value={row.kind} />
                  {row.reversalOfId ? <Badge variant="secondary">{tc("status.reversed")}</Badge> : null}
                  {row.reversed ? <Badge variant="secondary">{tc("status.reversed")}</Badge> : null}
                </div>
              </TableCell>
              <TableCell>{row.memo || "—"}</TableCell>
              <TableCell className="font-mono text-xs">
                {row.journalEntryId.slice(0, 8)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {money(
                  row.amount,
                  lease?.currency ? { currency: lease.currency } : undefined,
                )}
              </TableCell>
              {onReverse ? (
                <TableCell className="text-right">
                  {!row.reversalOfId && !row.reversed ? (
                    <Button size="sm" variant="outline" onClick={() => onReverse(row)}>
                      {t("leaseSections.deposits.postReversal")}
                    </Button>
                  ) : (
                    <span className="text-xs text-slate-400">{tc("status.closed")}</span>
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
