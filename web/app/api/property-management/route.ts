import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  PropertyManagementError,
  activatePropertyLease,
  addLeaseCharge,
  addLeaseEscalation,
  applyLeaseEscalation,
  assessLeaseLateFees,
  billCamReconciliation,
  billDueLeaseCharges,
  createCamPool,
  createManagedProperty,
  updateManagedProperty,
  createPropertyLease,
  createPropertyUnit,
  finalizeCamPool,
  propertyManagementWorkspace,
  recordSecurityDeposit,
  scheduleLeaseCharges,
  terminatePropertyLease,
} from "@openbooks/engine/src/property-management.ts";
import { guardPermission } from "../../../lib/authz";
import type { Authz } from "../../../lib/authz";
import {
  loadFieldDefs,
  validateCustomValues,
} from "../../../lib/custom-fields";
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

const glActions = new Set(["recordDeposit", "finalizeCam"]);
const billingActions = new Set(["billRent", "billCam", "assessLateFees"]);
const knownActions = new Set([
  "createProperty",
  "updateProperty",
  "createUnit",
  "createLease",
  "activateLease",
  "terminateLease",
  "addCharge",
  "addEscalation",
  "applyEscalation",
  "scheduleLease",
  "billRent",
  "assessLateFees",
  "recordDeposit",
  "createCamPool",
  "finalizeCam",
  "billCam",
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function guardSubsidiaryAccess(
  authz: Authz,
  action: string,
  body: Record<string, any>,
): Promise<NextResponse | null> {
  const allowed = authz.allowedSubsidiaryIds;
  if (!allowed) return null;
  if ((action === "billRent" && !body.leaseId) || action === "assessLateFees") {
    return NextResponse.json(
      {
        error: "Bulk portfolio billing requires unrestricted subsidiary access",
      },
      { status: 403 },
    );
  }
  const recordId = String(
    body.propertyId ?? body.leaseId ?? body.escalationId ?? body.poolId ?? "",
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
  } else if (
    ["updateProperty", "createUnit", "createLease", "createCamPool"].includes(
      action,
    )
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
  } else if (["finalizeCam", "billCam"].includes(action)) {
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

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, any>;
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
  const common = { orgId: authz.user.orgId, actorId: authz.user.id };
  try {
    let result: unknown;
    switch (action) {
      case "createProperty":
        result = await createManagedProperty({ ...body, ...common } as any);
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
        } as any);
        break;
      }
      case "createUnit":
        result = await createPropertyUnit({ ...body, ...common } as any);
        break;
      case "createLease":
        result = await createPropertyLease({ ...body, ...common } as any);
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
        result = await addLeaseCharge({ ...body, ...common } as any);
        break;
      case "addEscalation":
        result = await addLeaseEscalation({ ...body, ...common } as any);
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
        );
        break;
      case "assessLateFees":
        result = await assessLeaseLateFees(
          common.orgId,
          common.actorId,
          body.asOf,
        );
        break;
      case "recordDeposit":
        result = await recordSecurityDeposit({ ...body, ...common } as any);
        break;
      case "createCamPool":
        result = await createCamPool({ ...body, ...common } as any);
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
        { error: (error as Error).message },
        { status: 422 },
      );
    const code = (error as { code?: string }).code;
    if (code === "23505")
      return NextResponse.json(
        {
          error:
            "That code, number, or active unit assignment is already in use",
        },
        { status: 409 },
      );
    console.error("[property-management] action failed", error);
    return NextResponse.json(
      { error: "Property management action failed" },
      { status: 500 },
    );
  }
}
