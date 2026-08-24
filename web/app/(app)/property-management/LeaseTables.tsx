"use client";

import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@openbooks/ui";
import { Empty, Status } from "./workspace-ui";
import type { DepositRow, LeaseRow, Money, ScheduleRow } from "./types";

export function LeasesTable({ leases, money, onOpen }: { leases: LeaseRow[]; money: Money; onOpen: (id: string) => void }) {
  if (!leases.length)
    return (
      <Empty
        title="No leases yet"
        detail="Create a tenant lease to establish rent, CAM, deposit, and billing policy."
      />
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Lease</TableHead>
          <TableHead>Property / unit</TableHead>
          <TableHead>Tenant</TableHead>
          <TableHead>Term</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Deposit held</TableHead>
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
              {lease.startsOn} – {lease.endsOn || "Open"}
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
  if (!schedules.length)
    return (
      <Empty
        title="No rent schedule yet"
        detail="Activate a lease to generate effective-dated rent and additional-charge periods."
      />
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Due</TableHead>
          <TableHead>Lease</TableHead>
          <TableHead>Charge</TableHead>
          <TableHead>Period</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Invoice</TableHead>
          <TableHead className="text-right">Amount</TableHead>
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
  if (!deposits.length)
    return (
      <Empty
        title="No security-deposit activity"
        detail="Deposit receipts, applications, interest, adjustments, and refunds appear here with journal evidence."
      />
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Lease</TableHead>
          <TableHead>Transaction</TableHead>
          <TableHead>Memo</TableHead>
          <TableHead>Journal</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          {onReverse ? <TableHead className="text-right">Actions</TableHead> : null}
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
                  {row.reversalOfId ? <Badge variant="secondary">Reversal</Badge> : null}
                  {row.reversed ? <Badge variant="secondary">Reversed</Badge> : null}
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
                      Reverse
                    </Button>
                  ) : (
                    <span className="text-xs text-slate-400">Locked</span>
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
