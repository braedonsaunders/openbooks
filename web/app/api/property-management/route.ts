import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { canonicalDecimal } from "../../../lib/exact-decimal";
import {
  PropertyManagementError,
  activatePropertyLease,
  addLeaseCharge,
  addLeaseEscalation,
  applyLeaseEscalation,
  assessLeaseLateFees,
  billCamReconciliation,
  billDueLeaseCharges,
  cancelCamPool,
  cancelPropertyLease,
  createCamPool,
  createManagedProperty,
  deleteManagedProperty,
  deletePropertyUnit,
  updateManagedProperty,
  createPropertyLease,
  createPropertyUnit,
  updatePropertyLease,
  updatePropertyUnit,
  finalizeCamPool,
  propertyManagementWorkspace,
  recordSecurityDeposit,
  reverseSecurityDepositTransaction,
  reopenFinalizedCamPool,
  scheduleLeaseCharges,
  terminatePropertyLease,
  updateCamPool,
} from "@openbooks/engine/src/property-management.ts";
import { guardPermission } from "../../../lib/authz";
import type { Authz } from "../../../lib/authz";
import {
  loadFieldDefs,
  validateCustomValues,
} from "../../../lib/custom-fields";
import { isFeatureEnabled } from "../../../lib/features";
import { guardPropertyManagementFeature } from "../../../lib/property-management-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const authz = await guardPermission("ar.read");
  if (authz instanceof NextResponse) return authz;
  const feature = await guardPropertyManagementFeature(authz.user.orgId);
  if (feature) return feature;
  const workspace = await propertyManagementWorkspace(authz.user.orgId);
  if (!authz.allowedSubsidiaryIds) return NextResponse.json(workspace);
  const properties = workspace.properties.filter((row) =>
    authz.allowedSubsidiaryIds!.has(String(row.subsidiaryId)),
  );
  const propertyIds = new Set(properties.map((row) => String(row.id)));
  const units = workspace.units.filter((row) =>
    propertyIds.has(String(row.propertyId)),
  );
  const leases = workspace.leases.filter((row) =>
    propertyIds.has(String(row.propertyId)),
  );
  const leaseIds = new Set(leases.map((row) => String(row.id)));
  const camPools = workspace.camPools.filter((row) =>
    propertyIds.has(String(row.propertyId)),
  );
  const poolIds = new Set(camPools.map((row) => String(row.id)));
  return NextResponse.json({
    properties,
    units,
    leases,
    charges: workspace.charges.filter((row) =>
      leaseIds.has(String(row.leaseId)),
    ),
    escalations: workspace.escalations.filter((row) =>
      leaseIds.has(String(row.leaseId)),
    ),
    schedules: workspace.schedules.filter((row) =>
      leaseIds.has(String(row.leaseId)),
    ),
    deposits: workspace.deposits.filter((row) =>
      leaseIds.has(String(row.leaseId)),
    ),
    camPools,
    camAllocations: workspace.camAllocations.filter(
      (row) =>
        poolIds.has(String(row.poolId)) && leaseIds.has(String(row.leaseId)),
    ),
  });
}

const glActions = new Set(["recordDeposit", "reverseDeposit", "finalizeCam"]);
const billingActions = new Set(["billRent", "billCam", "assessLateFees"]);
const knownActions = new Set([
  "createProperty",
  "updateProperty",
  "deleteProperty",
  "createUnit",
  "updateUnit",
  "deleteUnit",
  "createLease",
  "updateLease",
  "cancelLease",
  "activateLease",
  "terminateLease",
  "addCharge",
  "addEscalation",
  "applyEscalation",
  "scheduleLease",
  "billRent",
  "assessLateFees",
  "recordDeposit",
  "reverseDeposit",
  "createCamPool",
  "updateCamPool",
  "cancelCamPool",
  "reopenCamPool",
  "finalizeCam",
  "billCam",
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

function persistMoney(value: unknown): string | null {
  if (value == null || value === "") return null;
  const exact = canonicalDecimal(value, 4);
  if (exact === null) {
    throw new PropertyManagementError(
      "Amount must be a number with no more than four decimal places",
    );
  }
  return normalizeMoney(exact);
}

function requireMoney(value: unknown): string {
  const persisted = persistMoney(value);
  if (persisted === null) {
    throw new PropertyManagementError(
      "Amount must be a number with no more than four decimal places",
    );
  }
  return persisted;
}

async function guardSubsidiaryAccess(
  authz: Authz,
  action: string,
  body: Record<string, unknown>,
): Promise<NextResponse | null> {
  const allowed = authz.allowedSubsidiaryIds;
  if (!allowed) return null;
  if (
    ((action === "billRent" || action === "assessLateFees") &&
      !body.leaseId &&
      !body.propertyId)
  ) {
    return NextResponse.json(
      {
        error: "Bulk portfolio billing requires unrestricted subsidiary access",
      },
      { status: 403 },
    );
  }
  const recordId = String(
    body.propertyId ??
      body.leaseId ??
      body.unitId ??
      body.transactionId ??
      body.escalationId ??
      body.poolId ??
      "",
  );
  if (action !== "createProperty" && !UUID.test(recordId)) {
    return NextResponse.json(
      { error: "Property-management record not found" },
      { status: 404 },
    );
  }

  let subsidiaryId: string | null = null;
  if (action === "createProperty") {
    subsidiaryId =
      typeof body.subsidiaryId === "string" ? body.subsidiaryId : null;
  } else if (["updateUnit", "deleteUnit"].includes(action)) {
    const result = (await db.execute(
      sql`select p.subsidiary_id as "subsidiaryId" from property_units u join managed_properties p on p.id=u.property_id and p.org_id=u.org_id where u.org_id=${authz.user.orgId} and u.id=${String(body.unitId ?? "")}`,
    )) as any;
    subsidiaryId = result.rows[0]?.subsidiaryId ?? null;
  } else if (action === "reverseDeposit") {
    const result = (await db.execute(
      sql`select p.subsidiary_id as "subsidiaryId" from security_deposit_transactions d join property_leases l on l.id=d.lease_id and l.org_id=d.org_id join managed_properties p on p.id=l.property_id and p.org_id=l.org_id where d.org_id=${authz.user.orgId} and d.id=${String(body.transactionId ?? "")}`,
    )) as any;
    subsidiaryId = result.rows[0]?.subsidiaryId ?? null;
  } else if (
    [
      "updateProperty",
      "deleteProperty",
      "createUnit",
      "createLease",
      "createCamPool",
      "billRent",
      "assessLateFees",
    ].includes(action) && body.propertyId
  ) {
    const result = (await db.execute(
      sql`select subsidiary_id as "subsidiaryId" from managed_properties where org_id=${authz.user.orgId} and id=${String(body.propertyId ?? "")}`,
    )) as any;
    subsidiaryId = result.rows[0]?.subsidiaryId ?? null;
    if (
      action === "updateProperty" &&
      typeof body.subsidiaryId === "string" &&
      !allowed.has(body.subsidiaryId)
    ) {
      return NextResponse.json(
        { error: "Target subsidiary is outside your access" },
        { status: 403 },
      );
    }
  } else if (
    [
      "updateLease",
      "cancelLease",
      "activateLease",
      "terminateLease",
      "addCharge",
      "addEscalation",
      "scheduleLease",
      "billRent",
      "recordDeposit",
    ].includes(action)
  ) {
    const result = (await db.execute(
      sql`select p.subsidiary_id as "subsidiaryId" from property_leases l join managed_properties p on p.id=l.property_id and p.org_id=l.org_id where l.org_id=${authz.user.orgId} and l.id=${String(body.leaseId ?? "")}`,
    )) as any;
    subsidiaryId = result.rows[0]?.subsidiaryId ?? null;
  } else if (action === "applyEscalation") {
    const result = (await db.execute(
      sql`select p.subsidiary_id as "subsidiaryId" from lease_escalations e join property_leases l on l.id=e.lease_id and l.org_id=e.org_id join managed_properties p on p.id=l.property_id and p.org_id=l.org_id where e.org_id=${authz.user.orgId} and e.id=${String(body.escalationId ?? "")}`,
    )) as any;
    subsidiaryId = result.rows[0]?.subsidiaryId ?? null;
  } else if (
    ["updateCamPool", "cancelCamPool", "reopenCamPool", "finalizeCam", "billCam"].includes(action)
  ) {
    const result = (await db.execute(
      sql`select p.subsidiary_id as "subsidiaryId" from cam_pools cp join managed_properties p on p.id=cp.property_id and p.org_id=cp.org_id where cp.org_id=${authz.user.orgId} and cp.id=${String(body.poolId ?? "")}`,
    )) as any;
    subsidiaryId = result.rows[0]?.subsidiaryId ?? null;
  }
  if (!subsidiaryId)
    return NextResponse.json(
      { error: "Property-management record not found" },
      { status: 404 },
    );
  if (!allowed.has(String(subsidiaryId)))
    return NextResponse.json(
      { error: "Property-management record is outside your subsidiary access" },
      { status: 403 },
    );
  return null;
}

function submittedFixedAssetId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

async function refuseDisabledPropertyFixedAsset(
  orgId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<NextResponse | null> {
  if (action !== "createProperty" && action !== "updateProperty") return null;
  const submitted = submittedFixedAssetId(body.fixedAssetId);
  if (action === "createProperty") {
    if (!submitted) return null;
  } else if (submitted === undefined) {
    return null;
  } else {
    const current = (await db.execute<{ fixed_asset_id: string | null }>(sql`
      select fixed_asset_id from managed_properties
       where org_id=${orgId} and id=${String(body.propertyId ?? "")}
    `));
    const currentId = current.rows[0]?.fixed_asset_id
      ? String(current.rows[0].fixed_asset_id)
      : null;
    if (currentId === submitted) return null;
  }
  if (await isFeatureEnabled(orgId, "fixedAssets")) return null;
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

async function refuseDisabledPropertyCurrency(
  orgId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<NextResponse | null> {
  if (action !== "createProperty" && action !== "updateProperty") return null;
  if (
    body.currency !== undefined &&
    !(await isFeatureEnabled(orgId, "multiCurrency"))
  ) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return null;
}

/** Stored charges stay when item_id is omitted. A new inventory / assembly / kit
 *  item is Inventory configuration — refuse it when that switch is off. */
async function refuseDisabledLeaseChargeInventory(
  orgId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<NextResponse | null> {
  if (action !== "addCharge") return null;
  const itemId = body.itemId;
  if (itemId === undefined || itemId === null || itemId === "") return null;
  if (await isFeatureEnabled(orgId, "inventory")) return null;
  const item = (await db.execute<{ kind: string }>(sql`
    select kind from items where id = ${String(itemId)} and org_id = ${orgId}`));
  if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return null;
}

export async function POST(request: Request) {
  const parsedBody = await parseJsonBody(request, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = ((parsedBody.data));
  const action = String(body.action ?? "");
  if (!knownActions.has(action))
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  const permission = glActions.has(action)
    ? "gl.post"
    : billingActions.has(action)
      ? "ar.create"
      : "ar.create";
  const authz = await guardPermission(permission);
  if (authz instanceof NextResponse) return authz;
  const feature = await guardPropertyManagementFeature(authz.user.orgId);
  if (feature) return feature;
  const subsidiary = await guardSubsidiaryAccess(authz, action, body);
  if (subsidiary) return subsidiary;
  const assetGate = await refuseDisabledPropertyFixedAsset(
    authz.user.orgId,
    action,
    body,
  );
  if (assetGate) return assetGate;
  const currencyGate = await refuseDisabledPropertyCurrency(
    authz.user.orgId,
    action,
    body,
  );
  if (currencyGate) return currencyGate;
  const inventoryGate = await refuseDisabledLeaseChargeInventory(
    authz.user.orgId,
    action,
    body,
  );
  if (inventoryGate) return inventoryGate;
  const common = { orgId: authz.user.orgId, actorId: authz.user.id };
  // Audit correlation for financial-term writes (createLease, updateLease,
  // addCharge, addEscalation): a caller-supplied correlation id lands in
  // audit_log.request_id next to its actor.
  const requestCorrelation = {
    requestId: (request.headers.get("x-request-id") ?? "").trim().slice(0, 256) || null,
  };
  try {
    let result: unknown;
    switch (action) {
      case "createProperty":
        result = await createManagedProperty({ ...body, ...common } as unknown as { orgId: string; actorId: string; subsidiaryId: string; locationId?: string | null; fixedAssetId?: string | null; code: string; name: string; propertyType: string; currency?: string | null; address?: Record<string, string>; rentIncomeAccountId?: string | null; camIncomeAccountId?: string | null; depositLiabilityAccountId?: string | null; defaultBankAccountId?: string | null; });
        break;
      case "updateProperty": {
        const validation = validateCustomValues(
          await loadFieldDefs("managed_properties"),
          body.custom,
        );
        if (!validation.ok) {
          return NextResponse.json(
            {
              error:
                Object.values(validation.errors)[0] ?? "Invalid custom fields",
              errors: validation.errors,
            },
            { status: 400 },
          );
        }
        result = await updateManagedProperty({
          ...body,
          custom: validation.cleaned,
          ...common,
        } as unknown as { orgId: string; actorId: string; propertyId: string; subsidiaryId: string; locationId?: string | null; fixedAssetId?: string | null; code: string; name: string; propertyType: string; status: string; currency?: string; address?: Record<string, string>; rentIncomeAccountId?: string | null; camIncomeAccountId?: string | null; depositLiabilityAccountId?: string | null; defaultBankAccountId?: string | null; custom?: Record<string, unknown>; });
        break;
      }
      case "deleteProperty":
        result = await deleteManagedProperty(
          common.orgId,
          common.actorId,
          String(body.propertyId),
        );
        break;
      case "createUnit":
        result = await createPropertyUnit({
          ...body,
          ...common,
          rentableArea: persistMoney(body.rentableArea),
        } as unknown as { orgId: string; actorId: string; propertyId: string; code: string; name?: string | null; unitType?: string | null; rentableArea?: string | null; bedrooms?: number | null; });
        break;
      case "updateUnit":
        result = await updatePropertyUnit({
          ...body,
          ...common,
          rentableArea: persistMoney(body.rentableArea),
        } as unknown as { orgId: string; actorId: string; unitId: string; code: string; name?: string | null; unitType?: string | null; rentableArea?: string | null; bedrooms?: number | null; status?: string; });
        break;
      case "deleteUnit":
        result = await deletePropertyUnit(
          common.orgId,
          common.actorId,
          String(body.unitId),
        );
        break;
      case "createLease":
        result = await createPropertyLease({
          ...body,
          ...common,
          ...requestCorrelation,
          baseRent: requireMoney(body.baseRent),
          securityDepositRequired: persistMoney(body.securityDepositRequired) ?? "0",
          camSharePercent: persistMoney(body.camSharePercent),
          lateFeeValue: persistMoney(body.lateFeeValue) ?? "0",
        } as unknown as { orgId: string; actorId: string; propertyId: string; unitId?: string | null; tenantId: string; leaseNumber: string; startsOn: string; endsOn?: string | null; baseRent: string; billingDay?: number; paymentTermsDays?: number; securityDepositRequired?: string; camMethod?: "none" | "fixed" | "pro_rata"; camSharePercent?: string | null; lateFeeType?: "none" | "fixed" | "percent"; lateFeeValue?: string; graceDays?: number; autoInvoice?: boolean; autoPost?: boolean; });
        break;
      case "updateLease":
        result = await updatePropertyLease({
          ...body,
          ...common,
          ...requestCorrelation,
          baseRent: requireMoney(body.baseRent),
          securityDepositRequired: persistMoney(body.securityDepositRequired) ?? "0",
          camSharePercent: persistMoney(body.camSharePercent),
          lateFeeValue: persistMoney(body.lateFeeValue) ?? "0",
        } as unknown as { orgId: string; actorId: string; leaseId: string; propertyId: string; unitId?: string | null; tenantId: string; leaseNumber: string; startsOn: string; endsOn?: string | null; baseRent: string; billingDay: number; paymentTermsDays: number; securityDepositRequired: string; camMethod: "none" | "fixed" | "pro_rata"; camSharePercent?: string | null; lateFeeType: "none" | "fixed" | "percent"; lateFeeValue: string; graceDays: number; autoInvoice: boolean; autoPost: boolean; });
        break;
      case "cancelLease":
        result = await cancelPropertyLease(
          common.orgId,
          common.actorId,
          String(body.leaseId),
        );
        break;
      case "activateLease":
        result = await activatePropertyLease(
          common.orgId,
          common.actorId,
          String(body.leaseId),
        );
        break;
      case "terminateLease":
        result = await terminatePropertyLease(
          common.orgId,
          common.actorId,
          String(body.leaseId),
          String(body.terminatedOn),
          String(body.reason ?? ""),
        );
        break;
      case "addCharge":
        result = await addLeaseCharge({
          ...body,
          ...common,
          ...requestCorrelation,
          amount: requireMoney(body.amount),
        } as unknown as { orgId: string; actorId: string; leaseId: string; chargeType: string; description: string; amount: string; frequency: string; effectiveFrom: string; effectiveTo?: string | null; incomeAccountId?: string | null; itemId?: string | null; taxCodeId?: string | null; });
        break;
      case "addEscalation":
        result = await addLeaseEscalation({
          ...body,
          ...common,
          ...requestCorrelation,
          value: requireMoney(body.value),
        } as unknown as { orgId: string; actorId: string; leaseId: string; effectiveOn: string; method: "percent" | "fixed" | "new_amount"; value: string; });
        break;
      case "applyEscalation":
        result = await applyLeaseEscalation(
          common.orgId,
          common.actorId,
          String(body.escalationId),
        );
        break;
      case "scheduleLease":
        result = await scheduleLeaseCharges(
          common.orgId,
          common.actorId,
          String(body.leaseId),
          body.throughOn,
        );
        break;
      case "billRent":
        result = await billDueLeaseCharges(
          common.orgId,
          common.actorId,
          body.asOf,
          body.leaseId,
          body.propertyId,
        );
        break;
      case "assessLateFees":
        result = await assessLeaseLateFees(
          common.orgId,
          common.actorId,
          body.asOf,
          body.leaseId,
          body.propertyId,
        );
        break;
      case "recordDeposit":
        result = await recordSecurityDeposit({
          ...body,
          ...common,
          amount: requireMoney(body.amount),
        } as unknown as { orgId: string; actorId: string; leaseId: string; kind: string; occurredOn: string; amount: string; bankAccountId?: string | null; offsetAccountId?: string | null; appliedDocumentId?: string | null; memo?: string | null; importKey?: string | null; });
        break;
      case "reverseDeposit":
        result = await reverseSecurityDepositTransaction({
          ...body,
          ...common,
        } as unknown as { orgId: string; actorId: string; transactionId: string; occurredOn: string; reason: string; });
        break;
      case "createCamPool":
        result = await createCamPool({
          ...body,
          ...common,
          budgetAmount: requireMoney(body.budgetAmount),
        } as unknown as { orgId: string; actorId: string; propertyId: string; name: string; fiscalYear: number; periodStartsOn: string; periodEndsOn: string; allocationBasis: "rentable_area" | "equal" | "custom"; budgetAmount: string; expenseAccountIds: string[]; });
        break;
      case "updateCamPool":
        result = await updateCamPool({
          ...body,
          ...common,
          budgetAmount: requireMoney(body.budgetAmount),
        } as unknown as { orgId: string; actorId: string; poolId: string; name: string; fiscalYear: number; periodStartsOn: string; periodEndsOn: string; allocationBasis: "rentable_area" | "equal" | "custom"; budgetAmount: string; expenseAccountIds: string[]; });
        break;
      case "cancelCamPool":
        await cancelCamPool(common.orgId, common.actorId, String(body.poolId));
        break;
      case "reopenCamPool":
        await reopenFinalizedCamPool(
          common.orgId,
          common.actorId,
          String(body.poolId),
          String(body.reason ?? ""),
        );
        break;
      case "finalizeCam":
        result = await finalizeCamPool(
          common.orgId,
          common.actorId,
          String(body.poolId),
        );
        break;
      case "billCam":
        result = await billCamReconciliation(
          common.orgId,
          common.actorId,
          String(body.poolId),
          body.invoiceDate,
        );
        break;
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    return NextResponse.json(result ?? { ok: true }, {
      status:
        action.startsWith("create") ||
        action.startsWith("add") ||
        action === "recordDeposit"
          ? 201
          : 200,
    });
  } catch (error) {
    if (error instanceof PropertyManagementError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    // Drizzle wraps driver errors, so the PostgreSQL code can sit on `cause`.
    const pgCode = error as { code?: string; cause?: { code?: string } };
    const code = pgCode.code ?? pgCode.cause?.code;
    if (code === "23505")
      return NextResponse.json(
        {
          error:
            "That code, number, or active unit assignment is already in use",
        },
        { status: 409 },
      );
    if (code === "23P01")
      return NextResponse.json(
        { error: "A base-rent charge already covers that effective window" },
        { status: 409 },
      );
    console.error("[property-management] action failed", error);
    return NextResponse.json(
      { error: "Property management action failed" },
      { status: 500 },
    );
  }
}
