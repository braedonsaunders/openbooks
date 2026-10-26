import { z } from "zod";
import { NextResponse } from "next/server";
import type { PermissionRouteOptions } from "@/lib/api/route";
import { civilDateInput } from "@/lib/api/civil-date";
import { uuidId } from "@/lib/api/json-schema";
import {
  getBenefitTransactionPolicy,
  saveBenefitTransactionPolicy,
} from "@openbooks/engine/hrm/benefits";
import { benefitsErrorResponse } from "../benefits/_lib";

export const transactionPolicyParams = z.object({ id: uuidId });
const decimal = z.string().trim().min(1).max(64);
export const transactionPolicyBody = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
  changeEffectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  documentKind: z.enum(["sales_order", "customer_invoice", "field_ticket", "quote"]),
  dateBasis: z.enum(["document_date", "work_date"]),
  unassignedShare: z.enum(["refuse", "forfeit"]).default("refuse"),
  rounding: z.enum(["per_group", "per_recipient"]).default("per_group"),
  capPercent: decimal.nullish().transform((value) => value ?? null),
  capProjectTypeId: uuidId.nullish().transform((value) => value ?? null),
  groupingSegmentId: uuidId.nullable(),
  itemIds: z.array(uuidId).min(1).max(10000),
  positions: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(120),
        name: z.string().trim().min(1).max(200),
        weight: decimal,
        recipientSource: z
          .enum([
            "assignment",
            "field_ticket_foreman",
            "field_ticket_superintendent",
            "project_foreman",
            "project_manager",
          ])
          .default("assignment"),
        fallbackOnlyWhenContextAbsent: z.boolean().optional(),
        fallbackSource: z
          .enum([
            "field_ticket_foreman",
            "field_ticket_superintendent",
            "project_foreman",
            "project_manager",
          ])
          .nullish()
          .transform((value) => value ?? null),
      }),
    )
    .min(1)
    .max(100),
  responsibilities: z
    .array(
      z.object({
        groupId: uuidId,
        positionKey: z.string().trim().min(1).max(120),
        employmentId: uuidId,
        effectiveFrom: civilDateInput(),
        effectiveTo: civilDateInput().nullable(),
      }),
    )
    .max(10000),
  limits: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ groupId: uuidId, kind: z.literal("none"), amount: z.null() }),
        z.object({ groupId: uuidId, kind: z.literal("amount"), amount: decimal }),
      ]),
    )
    .max(10000),
});

/** Both program and Setup addresses use the same native aggregate command. */
export const readTransactionPolicy: PermissionRouteOptions<
  typeof transactionPolicyParams
>["handler"] = async ({ authz, params }) => {
  try {
    return NextResponse.json({
      record: await getBenefitTransactionPolicy({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        programId: params.id,
      }),
    });
  } catch (error) {
    return benefitsErrorResponse(error);
  }
};

export const writeTransactionPolicy: PermissionRouteOptions<
  typeof transactionPolicyParams,
  typeof transactionPolicyBody
>["handler"] = async ({ authz, params, body }) => {
  try {
    const { expectedRevision, reason, changeEffectiveFrom, ...policy } = body;
    return NextResponse.json({
      record: await saveBenefitTransactionPolicy({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        programId: params.id,
        expectedRevision,
        reason,
        policy,
        changeEffectiveFrom,
      }),
    });
  } catch (error) {
    return benefitsErrorResponse(error);
  }
};
