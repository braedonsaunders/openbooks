import "server-only";
import { z } from "zod";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import {
  propertyManagementWorkspace,
  securityDepositReconciliation,
} from "@openbooks/engine/src/property-management.ts";
import { add, cmp, sum } from "@openbooks/engine/src/money.ts";
import { isFeatureEnabled } from "../features";
import type { AssistantToolDef, ToolResult } from "./types";
import { truncateText } from "./types";
import { dateInput, uuidInput, num, capList } from "./tools-shared";

/**
 * Property-management read/search tools for the agentic assistant. Every tool
 * carries the same `ar.read` gate and `propertyManagement` feature flag as
 * the property routes, and reads through the same engine loaders the screens
 * use (`propertyManagementWorkspace`, `securityDepositReconciliation`) with
 * the same subsidiary filtering the GET route applies (properties narrow by
 * the caller's allowlist; everything else follows the visible properties).
 *
 * The rent-roll figures reuse the exact predicates behind the rent-roll
 * screen (RentRollTable `monthlyCharges` / `pastDue`): monthly charges in
 * effect on the date, and posted invoices past due with per-invoice
 * de-duplication. Money is summed with the engine decimal helpers and
 * presented with the shared 2-dp projection.
 */

const FEATURE_ERROR = "propertyManagement_feature_disabled";

async function featureOff(orgId: string): Promise<boolean> {
  return !(await isFeatureEnabled(orgId, "propertyManagement"));
}

type Workspace = Awaited<ReturnType<typeof propertyManagementWorkspace>>;
type LeaseRow = Workspace["leases"][number];
type ChargeRow = Workspace["charges"][number];
type ScheduleRow = Workspace["schedules"][number];

async function visibleWorkspace(orgId: string, allowed: ReadonlySet<string> | null): Promise<Workspace> {
  // Same narrowing as GET /api/property-management: restricted callers see
  // only their subsidiaries' properties, and every child collection follows
  // the visible properties and leases.
  const workspace = await propertyManagementWorkspace(orgId);
  if (allowed === null) return workspace;
  const properties = workspace.properties.filter((row) => allowed.has(String(row.subsidiaryId)));
  const propertyIds = new Set(properties.map((row) => String(row.id)));
  const leases = workspace.leases.filter((row) => propertyIds.has(String(row.propertyId)));
  const leaseIds = new Set(leases.map((row) => String(row.id)));
  const camPools = workspace.camPools.filter((row) => propertyIds.has(String(row.propertyId)));
  const poolIds = new Set(camPools.map((row) => String(row.id)));
  return {
    properties,
    units: workspace.units.filter((row) => propertyIds.has(String(row.propertyId))),
    leases,
    charges: workspace.charges.filter((row) => leaseIds.has(String(row.leaseId))),
    escalations: workspace.escalations.filter((row) => leaseIds.has(String(row.leaseId))),
    schedules: workspace.schedules.filter((row) => leaseIds.has(String(row.leaseId))),
    deposits: workspace.deposits.filter((row) => leaseIds.has(String(row.leaseId))),
    camPools,
    camAllocations: workspace.camAllocations.filter(
      (row) => poolIds.has(String(row.poolId)) && leaseIds.has(String(row.leaseId)),
    ),
  };
}

/** Rent-roll screen predicate: monthly charges in effect on the date. */
function monthlyChargesFor(charges: ChargeRow[], lease: LeaseRow, asOf: string): string {
  const current = charges.filter(
    (charge) =>
      String(charge.leaseId) === String(lease.id) && charge.frequency === "monthly"
      && String(charge.effectiveFrom) <= asOf
      && (!charge.effectiveTo || String(charge.effectiveTo) >= asOf),
  );
  if (current.length) return sum(current.map((charge) => String(charge.amount)));
  return lease.status === "draft" ? String(lease.baseRent ?? "0") : "0";
}

/** Rent-roll screen predicate: posted invoices past due, de-duplicated per invoice. */
function pastDueInvoices(schedules: ScheduleRow[], leaseId: unknown, asOf: string): Map<string, ScheduleRow> {
  const invoices = new Map<string, ScheduleRow>();
  for (const line of schedules) {
    if (
      String(line.leaseId) === String(leaseId) && line.invoiceDocumentId
      && line.invoiceStatus === "posted" && line.invoiceDueOn && String(line.invoiceDueOn) < asOf
    ) {
      invoices.set(String(line.invoiceDocumentId), line);
    }
  }
  return invoices;
}

function pastDueFor(schedules: ScheduleRow[], leaseId: unknown, asOf: string): string {
  return sum([...pastDueInvoices(schedules, leaseId, asOf).values()].map((line) => String(line.invoiceOpenBalance ?? "0")));
}

const listProperties: AssistantToolDef = {
  name: "list_properties",
  description:
    "List managed properties: code, name, type, status, currency, unit and occupancy counts. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["ar.read"] },
  feature: "propertyManagement",
  inputSchema: z.object({
    query: z.string().max(100).optional().describe("Substring over property code or name"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as { query?: string };
    const workspace = await visibleWorkspace(authz.user.orgId, authz.allowedSubsidiaryIds);
    const q = (a.query ?? "").toLowerCase();
    const rows = workspace.properties.filter(
      (p) => !q || String(p.code).toLowerCase().includes(q) || String(p.name).toLowerCase().includes(q),
    );
    const capped = capList(
      rows.map((p) => ({
        propertyId: p.id,
        code: p.code,
        name: p.name,
        propertyType: p.propertyType,
        status: p.status,
        currency: p.currency,
        subsidiaryName: p.subsidiaryName,
        locationName: p.locationName,
        unitCount: p.unitCount,
        occupiedUnits: p.occupiedUnits,
      })),
    );
    return {
      ok: true,
      data: {
        returned: capped.items.length,
        total: rows.length,
        truncated: capped.truncated,
        properties: capped.items,
        href: "/property-management",
      },
    };
  },
};

const listLeasesSchema = z.object({
  query: z.string().max(100).optional().describe("Substring over lease number, tenant, property, or unit"),
  propertyId: uuidInput.optional().describe("Property id; omit for every property"),
  status: z.string().max(20).optional().describe("Lease status (active, notice, draft, …); omit for active and notice"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50); totals always cover ALL matches"),
});

const listLeases: AssistantToolDef = {
  name: "list_leases",
  description:
    "List property leases: number, property/unit, tenant, status, term dates, current base rent, and deposit balance. Returns a capped page plus counts by status over ALL matches. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["ar.read"] },
  feature: "propertyManagement",
  inputSchema: listLeasesSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as z.infer<typeof listLeasesSchema>;
    const limit = Math.min(a.limit ?? 50, 200);
    const workspace = await visibleWorkspace(authz.user.orgId, authz.allowedSubsidiaryIds);
    const q = (a.query ?? "").toLowerCase();
    const rows = workspace.leases.filter(
      (l) =>
        (!a.status ? l.status === "active" || l.status === "notice" : l.status === a.status)
        && (!a.propertyId || String(l.propertyId) === a.propertyId)
        && (!q || [l.leaseNumber, l.tenantName, l.propertyName, l.unitCode]
          .some((v) => String(v ?? "").toLowerCase().includes(q))),
    );
    const byStatus = new Map<string, number>();
    for (const l of workspace.leases) {
      const key = String(l.status);
      byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
    }
    const capped = capList(
      rows.map((l) => ({
        leaseId: l.id,
        leaseNumber: l.leaseNumber,
        propertyName: l.propertyName,
        unitCode: l.unitCode,
        tenantName: l.tenantName,
        status: l.status,
        startsOn: l.startsOn,
        endsOn: l.endsOn,
        baseRent: l.baseRent == null ? null : num(l.baseRent),
        currency: l.currency,
        depositBalance: num(l.depositBalance ?? 0),
        autoInvoice: l.autoInvoice,
      })),
      limit
    );
    return {
      ok: true,
      data: {
        returned: capped.items.length,
        total: rows.length,
        truncated: capped.truncated,
        leases: capped.items,
        byStatus: [...byStatus].map(([status, count]) => ({ status, count })),
        href: "/property-management",
      },
    };
  },
};

const getLease: AssistantToolDef = {
  name: "get_lease",
  description:
    "One lease's full detail: term and billing facts, charges, escalations, schedule lines with invoice state, and deposit movements — the same record the lease drawer shows. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read"] },
  feature: "propertyManagement",
  inputSchema: z.object({ leaseId: uuidInput.describe("Lease id from list_leases or rent_roll") }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as { leaseId: string };
    const workspace = await visibleWorkspace(authz.user.orgId, authz.allowedSubsidiaryIds);
    // The workspace is already narrowed to the caller's properties, so a
    // lease outside subsidiary scope reads as missing, like the route.
    const lease = workspace.leases.find((l) => String(l.id) === a.leaseId) as LeaseRow | undefined;
    if (!lease) return { ok: false, error: "lease_not_found" };
    const asOf = await businessToday(authz.user.orgId);
    const charges = workspace.charges.filter((c) => String(c.leaseId) === a.leaseId);
    const escalations = workspace.escalations.filter((e) => String(e.leaseId) === a.leaseId);
    const schedules = capList(
      workspace.schedules
        .filter((s) => String(s.leaseId) === a.leaseId)
        .map((s) => ({
          periodStartsOn: s.periodStartsOn,
          periodEndsOn: s.periodEndsOn,
          dueOn: s.dueOn,
          amount: num(s.amount),
          status: s.status,
          chargeType: s.chargeType,
          description: s.description,
          invoiceDocumentId: s.invoiceDocumentId,
          invoiceNumber: s.invoiceNumber,
          invoiceStatus: s.invoiceStatus,
          invoiceDueOn: s.invoiceDueOn,
          invoiceOpenBalance: s.invoiceOpenBalance == null ? null : num(s.invoiceOpenBalance),
        })),
      50,
    );
    const deposits = capList(
      workspace.deposits
        .filter((d) => String(d.leaseId) === a.leaseId)
        .map((d) => ({
          kind: d.kind,
          occurredOn: d.occurredOn,
          amount: num(d.amount),
          memo: d.memo == null ? null : truncateText(String(d.memo), 200),
          reversed: d.reversed,
        })),
      20,
    );
    return {
      ok: true,
      data: {
        lease: {
          leaseId: lease.id,
          leaseNumber: lease.leaseNumber,
          propertyName: lease.propertyName,
          unitCode: lease.unitCode,
          tenantName: lease.tenantName,
          status: lease.status,
          startsOn: lease.startsOn,
          endsOn: lease.endsOn,
          billingDay: lease.billingDay,
          paymentTermsDays: lease.paymentTermsDays,
          securityDepositRequired: lease.securityDepositRequired == null ? null : num(lease.securityDepositRequired),
          camMethod: lease.camMethod,
          camSharePercent: lease.camSharePercent,
          lateFeeType: lease.lateFeeType,
          lateFeeValue: lease.lateFeeValue,
          graceDays: lease.graceDays,
          autoInvoice: lease.autoInvoice,
          autoPost: lease.autoPost,
          baseRent: lease.baseRent == null ? null : num(lease.baseRent),
          currency: lease.currency,
          depositBalance: num(lease.depositBalance ?? 0),
          monthlyCharges: num(monthlyChargesFor(workspace.charges, lease, asOf)),
          pastDue: num(pastDueFor(workspace.schedules, lease.id, asOf)),
          notes: lease.notes == null ? null : truncateText(String(lease.notes), 500),
        },
        charges: charges.map((c) => ({
          chargeType: c.chargeType,
          description: c.description,
          amount: num(c.amount),
          frequency: c.frequency,
          effectiveFrom: c.effectiveFrom,
          effectiveTo: c.effectiveTo,
        })),
        escalations,
        schedules: schedules.items,
        schedulesTruncated: schedules.truncated,
        deposits: deposits.items,
        depositsTruncated: deposits.truncated,
        href: "/property-management",
      },
    };
  },
};

const rentRollSchema = z.object({
  asOf: dateInput.optional().describe("Roll date; defaults to today"),
  propertyId: uuidInput.optional().describe("Property id; omit for every property"),
  query: z.string().max(100).optional().describe("Substring over lease number, tenant, property, or unit"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50); totals always cover ALL matches"),
});

const rentRoll: AssistantToolDef = {
  name: "rent_roll",
  description:
    "Rent roll for a date: every operating lease with monthly charges in effect and posted past-due balances, plus charge and arrears totals per currency and occupancy across the visible properties. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read"] },
  feature: "propertyManagement",
  inputSchema: rentRollSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as z.infer<typeof rentRollSchema>;
    const limit = Math.min(a.limit ?? 50, 200);
    const asOf = a.asOf ?? (await businessToday(authz.user.orgId));
    const workspace = await visibleWorkspace(authz.user.orgId, authz.allowedSubsidiaryIds);
    const q = (a.query ?? "").toLowerCase();
    const leases = workspace.leases.filter(
      (l) =>
        (l.status === "active" || l.status === "notice")
        && (!a.propertyId || String(l.propertyId) === a.propertyId)
        && (!q || [l.leaseNumber, l.tenantName, l.propertyName, l.unitCode]
          .some((v) => String(v ?? "").toLowerCase().includes(q))),
    );
    const rows = leases.map((l) => ({
      lease: l,
      monthly: monthlyChargesFor(workspace.charges, l, asOf),
      pastDue: pastDueFor(workspace.schedules, l.id, asOf),
    }));
    const chargesByCurrency = new Map<string, string>();
    const pastDueByCurrency = new Map<string, string>();
    for (const row of rows) {
      const code = String(row.lease.currency ?? "").trim().toUpperCase() || "UNKNOWN";
      chargesByCurrency.set(code, add(chargesByCurrency.get(code) ?? "0", row.monthly));
      pastDueByCurrency.set(code, add(pastDueByCurrency.get(code) ?? "0", row.pastDue));
    }
    const capped = capList(
      rows.map((row) => ({
        leaseId: row.lease.id,
        leaseNumber: row.lease.leaseNumber,
        propertyName: row.lease.propertyName,
        unitCode: row.lease.unitCode,
        tenantName: row.lease.tenantName,
        status: row.lease.status,
        currency: row.lease.currency,
        monthlyCharges: num(row.monthly),
        pastDue: num(row.pastDue),
      })),
      limit
    );
    const units = a.propertyId
      ? workspace.units.filter((u) => String(u.propertyId) === a.propertyId)
      : workspace.units;
    return {
      ok: true,
      data: {
        asOf,
        returned: capped.items.length,
        total: rows.length,
        truncated: capped.truncated,
        roll: capped.items,
        monthlyChargesByCurrency: [...chargesByCurrency].map(([currency, amount]) => ({ currency, amount: num(amount) })),
        pastDueByCurrency: [...pastDueByCurrency].map(([currency, amount]) => ({ currency, amount: num(amount) })),
        occupancy: {
          totalUnits: units.length,
          occupiedUnits: units.filter((u) => String(u.status) === "occupied").length,
        },
        href: "/property-management",
      },
    };
  },
};

const leaseArrearsSchema = z.object({
  asOf: dateInput.optional().describe("Arrears date; defaults to today"),
  propertyId: uuidInput.optional().describe("Property id; omit for every property"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50); totals always cover ALL matches"),
});

const leaseArrears: AssistantToolDef = {
  name: "lease_arrears",
  description:
    "Rent arrears for a date: leases with posted past-due invoice balances, each with its overdue invoices and per-currency arrears totals over ALL matches. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read"] },
  feature: "propertyManagement",
  inputSchema: leaseArrearsSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as z.infer<typeof leaseArrearsSchema>;
    const limit = Math.min(a.limit ?? 50, 200);
    const asOf = a.asOf ?? (await businessToday(authz.user.orgId));
    const workspace = await visibleWorkspace(authz.user.orgId, authz.allowedSubsidiaryIds);
    const leases = workspace.leases.filter(
      (l) => !a.propertyId || String(l.propertyId) === a.propertyId,
    );
    const rows = leases
      .map((l) => {
        const invoices = [...pastDueInvoices(workspace.schedules, l.id, asOf).values()];
        const pastDue = sum(invoices.map((line) => String(line.invoiceOpenBalance ?? "0")));
        return { lease: l, invoices, pastDue };
      })
      .filter((row) => cmp(row.pastDue, "0") > 0)
      .sort((x, y) => cmp(y.pastDue, x.pastDue));
    const totalsByCurrency = new Map<string, string>();
    for (const row of rows) {
      const code = String(row.lease.currency ?? "").trim().toUpperCase() || "UNKNOWN";
      totalsByCurrency.set(code, add(totalsByCurrency.get(code) ?? "0", row.pastDue));
    }
    const capped = capList(
      rows.map((row) => ({
        leaseId: row.lease.id,
        leaseNumber: row.lease.leaseNumber,
        propertyName: row.lease.propertyName,
        unitCode: row.lease.unitCode,
        tenantName: row.lease.tenantName,
        status: row.lease.status,
        currency: row.lease.currency,
        pastDue: num(row.pastDue),
        invoices: row.invoices.map((line) => ({
          invoiceDocumentId: line.invoiceDocumentId,
          invoiceNumber: line.invoiceNumber,
          invoiceDueOn: line.invoiceDueOn,
          invoiceOpenBalance: line.invoiceOpenBalance == null ? null : num(line.invoiceOpenBalance),
        })),
      })),
      limit
    );
    return {
      ok: true,
      data: {
        asOf,
        returned: capped.items.length,
        total: rows.length,
        truncated: capped.truncated,
        arrears: capped.items,
        totalsByCurrency: [...totalsByCurrency].map(([currency, amount]) => ({ currency, amount: num(amount) })),
        href: "/property-management",
      },
    };
  },
};

const propertyDepositsSchema = z.object({
  asOf: dateInput.optional().describe("Reconciliation date; defaults to today"),
});

const propertyDeposits: AssistantToolDef = {
  name: "property_deposits",
  description:
    "Security-deposit reconciliation for a date: per-property subledger, linked GL, and cash-activity balances with discrepancy and configuration-required counts — the same readout as the deposit reconciliation screen. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read"] },
  feature: "propertyManagement",
  inputSchema: propertyDepositsSchema,
  execute: async (raw, authz): Promise<ToolResult> => {
    if (await featureOff(authz.user.orgId)) return { ok: false, error: FEATURE_ERROR };
    const a = raw as z.infer<typeof propertyDepositsSchema>;
    let reconciliation: Awaited<ReturnType<typeof securityDepositReconciliation>>;
    try {
      // securityDepositReconciliation is the route's loader: it validates the
      // date and re-checks the feature itself.
      reconciliation = await securityDepositReconciliation(authz.user.orgId, a.asOf);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "reconciliation failed" };
    }
    // Same subsidiary narrowing and totals as the route.
    const rows = authz.allowedSubsidiaryIds === null
      ? reconciliation.rows
      : reconciliation.rows.filter((row) => authz.allowedSubsidiaryIds!.has(String(row.subsidiaryId)));
    return {
      ok: true,
      data: {
        asOf: reconciliation.asOf,
        returned: rows.length,
        rows: capList(rows, 200).items,
        totals: {
          subledgerBalance: num(sum(rows.map((row) => row.subledgerBalance))),
          linkedGlBalance: num(sum(rows.map((row) => row.linkedGlBalance))),
          cashActivity: num(sum(rows.map((row) => row.cashActivity))),
          discrepancies: rows.filter((row) => row.status === "discrepancy").length,
          configurationRequired: rows.filter((row) => row.status === "configuration_required").length,
        },
        href: "/property-management",
      },
    };
  },
};

export const PROPERTY_TOOLS: AssistantToolDef[] = [
  listProperties,
  listLeases,
  getLease,
  rentRoll,
  leaseArrears,
  propertyDeposits,
];
