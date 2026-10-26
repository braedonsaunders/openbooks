import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/list-params";
import {
  createPayrollWorkLocation,
  listPayrollWorkLocations,
  updatePayrollWorkLocation,
} from "@openbooks/engine/payroll/work-location-admin";
import { z } from "zod";

export const dynamic = "force-dynamic";

const dateShape = /^\d{4}-\d{2}-\d{2}$/;
const shareShape = /^(?:0(?:\.\d{1,10})?|1(?:\.0{1,10})?)$/;

export const GET = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  handler: async ({ request: request, authz: gate }) => {
    const orgId = gate.user.orgId;
    const url = new URL(request.url);
    const employmentId = url.searchParams.get("employmentId");
    const periodStart = url.searchParams.get("periodStart");
    const periodEnd = url.searchParams.get("periodEnd");
    if (!employmentId && !periodStart && !periodEnd) {
      const result = await listPayrollWorkLocations({
        orgId,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      if (result.kind === "employment_out_of_scope") {
        return NextResponse.json(
          { error: "employment is outside your subsidiary scope" },
          { status: 403 },
        );
      }
      return NextResponse.json({ employees: result.employees });
    }
    if (
      !employmentId ||
      !isUuid(employmentId) ||
      !periodStart ||
      !dateShape.test(periodStart) ||
      !periodEnd ||
      !dateShape.test(periodEnd) ||
      periodStart > periodEnd
    ) {
      return NextResponse.json(
        { error: "employment and a valid payroll period are required" },
        { status: 422 },
      );
    }
    const result = await listPayrollWorkLocations({
      orgId,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      detail: { employmentId, periodStart, periodEnd },
    });
    if (result.kind === "employment_out_of_scope") {
      return NextResponse.json(
        { error: "employment is outside your payroll scope" },
        { status: 404 },
      );
    }
    if (result.kind !== "detail") return NextResponse.json({ employees: result.employees });
    return NextResponse.json({ employees: result.employees, rows: result.rows });
  },
});

const saveSchema = z
  .object({
    employmentId: z
      .string()
      .refine(
        isUuid,
        "employmentId must be a valid UUID; select an employment in your payroll scope",
      ),
    periodStart: z.string().regex(dateShape),
    periodEnd: z.string().regex(dateShape),
    region: z.string().trim().min(1).max(32),
    subregion: z.string().trim().max(64).nullable().optional(),
    serviceDays: z.number().int().nonnegative().nullable().optional(),
    workShare: z.string().regex(shareShape).nullable().optional(),
    source: z.enum(["hr_records", "certificate", "adequate_records"]),
    evidenceDocumentId: z
      .string()
      .refine(isUuid, "evidenceDocumentId must be a valid UUID; select a saved evidence document")
      .nullable()
      .optional(),
    changeReason: z.string().trim().min(1).max(1000),
  })
  .refine((value) => value.periodStart <= value.periodEnd, {
    message: "period start must not follow period end",
  })
  .refine((value) => (value.serviceDays != null) !== (value.workShare != null), {
    message: "enter either service days or a work share",
  });

export const POST = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  body: saveSchema,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body: value }) => {
    const orgId = gate.user.orgId;
    const result = await createPayrollWorkLocation(
      orgId,
      gate.user.id,
      gate.allowedSubsidiaryIds,
      value,
    );
    if (result.kind === "employment_out_of_scope") {
      return NextResponse.json(
        { error: "employment is outside your payroll scope" },
        { status: 404 },
      );
    }
    return NextResponse.json({ row: result.row }, { status: 201 });
  },
});

const updateSchema = saveSchema.extend({ id: z.string().refine(isUuid) });

export const PATCH = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  body: updateSchema,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body: value }) => {
    const orgId = gate.user.orgId;
    const result = await updatePayrollWorkLocation(
      orgId,
      gate.user.id,
      gate.allowedSubsidiaryIds,
      value,
    );
    if (result.kind === "employment_out_of_scope") {
      return NextResponse.json(
        { error: "employment is outside your payroll scope" },
        { status: 404 },
      );
    }
    if (result.kind === "not_found") {
      return NextResponse.json(
        { error: "allocation was not found for this employment period" },
        { status: 404 },
      );
    }
    return NextResponse.json({ row: result.row });
  },
});
