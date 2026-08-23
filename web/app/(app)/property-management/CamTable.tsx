"use client";

import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@openbooks/ui";
import { Empty, Small, Status } from "./workspace-ui";

export function CamTable({
  data,
  propertyId,
  money,
  busy,
  permissions,
  act,
  onEdit,
  onReopen,
}: any) {
  const pools = propertyId
    ? data.camPools.filter((pool: any) => pool.propertyId === propertyId)
    : data.camPools;
  if (!pools.length)
    return (
      <Empty
        title="No CAM pools yet"
        detail={propertyId
          ? "Create this property's first operating-expense pool and tenant reconciliation."
          : "Create an annual operating-expense pool, allocate actual GL costs, and invoice tenant true-ups."}
      />
    );
  return (
    <div className="divide-y divide-slate-200 dark:divide-slate-800">
      {pools.map((pool: any) => {
        const property = data.properties.find(
          (item: any) => item.id === pool.propertyId,
        );
        const allocations = data.camAllocations.filter(
          (item: any) => item.poolId === pool.id,
        );
        return (
          <div key={pool.id} className="space-y-3 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-medium">
                  {pool.name} · {pool.fiscalYear}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {property?.name} · {pool.periodStartsOn}–{pool.periodEndsOn} ·{" "}
                  {pool.allocationBasis.replaceAll("_", " ")}
                </div>
              </div>
              <div className="flex gap-2">
                <Status value={pool.status} />
                {permissions.manage &&
                ["draft", "open"].includes(pool.status) ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onEdit?.(pool)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Cancel ${pool.name}? The pool will remain in CAM history.`,
                          )
                        )
                          void act(
                            { action: "cancelCamPool", poolId: pool.id },
                            "CAM pool cancelled",
                          );
                      }}
                    >
                      Cancel
                    </Button>
                  </>
                ) : null}
                {permissions.account &&
                ["draft", "open"].includes(pool.status) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      act(
                        { action: "finalizeCam", poolId: pool.id },
                        "CAM actuals finalized",
                      )
                    }
                  >
                    Finalize
                  </Button>
                ) : null}
                {permissions.account && pool.status === "finalized" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onReopen?.(pool)}
                  >
                    Reopen for correction
                  </Button>
                ) : null}
                {permissions.bill && pool.status === "finalized" ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      act(
                        { action: "billCam", poolId: pool.id },
                        "CAM reconciliations created",
                      )
                    }
                  >
                    Create true-ups
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Small
                label="Budget"
                value={money(
                  pool.budgetAmount,
                  property?.currency
                    ? { currency: property.currency }
                    : undefined,
                )}
              />
              <Small
                label="Actual"
                value={
                  pool.actualAmount == null
                    ? "—"
                    : money(
                        pool.actualAmount,
                        property?.currency
                          ? { currency: property.currency }
                          : undefined,
                      )
                }
              />
              <Small
                label="Lease allocations"
                value={String(allocations.length)}
              />
            </div>
            {allocations.length ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Lease</TableHead>
                      <TableHead className="text-right">Share</TableHead>
                      <TableHead className="text-right">Actual</TableHead>
                      <TableHead className="text-right">
                        Previously billed
                      </TableHead>
                      <TableHead className="text-right">True-up</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allocations.map((allocation: any) => (
                      <TableRow key={allocation.id}>
                        <TableCell>
                          {
                            data.leases.find(
                              (lease: any) => lease.id === allocation.leaseId,
                            )?.leaseNumber
                          }
                        </TableCell>
                        <TableCell className="text-right">
                          {allocation.sharePercent}%
                        </TableCell>
                        <TableCell className="text-right">
                          {money(allocation.actualAllocation ?? 0)}
                        </TableCell>
                        <TableCell className="text-right">
                          {money(allocation.billedEstimate)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {money(allocation.reconciliationAmount ?? 0)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
