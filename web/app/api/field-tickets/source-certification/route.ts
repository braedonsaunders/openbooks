import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json-schema";
import {
  certifyFieldTicketSourceIdentity,
  listFieldTicketSourceCertificationCandidates,
  FieldTicketSourceCertificationError,
} from "@openbooks/engine/projects/field-ticket-source-certification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const referenceMap = z.strictObject({
  jobRef: z.string().trim().min(1).max(200),
  customerRef: z.string().trim().max(200).nullable(),
  foremanRef: z.string().trim().max(200).nullable(),
  superintendentRef: z.string().trim().max(200).nullable().optional(),
  projectId: uuidId,
  customerPartyId: uuidId.nullable(),
  foremanPartyId: uuidId.nullable(),
  superintendentPartyId: uuidId.nullable(),
});

const body = z.strictObject({
  requestId: uuidId,
  nativeDocumentId: uuidId,
  expectedNativeRevision: z.string().regex(/^\d{1,20}$/),
  sourceSystem: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i),
  sourceTicketId: z.string().min(1).max(200),
  sourceFileId: uuidId,
  sourceVersionId: uuidId,
  sourceFileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  attestation: z.string().trim().min(8).max(2000),
  reason: z.string().trim().min(8).max(2000),
  explicitReferenceMap: referenceMap,
});

export const GET = defineRoute({
  permission: "time.read",
  feature: "fieldTickets",
  handler: async ({ authz }) => {
    try {
      return NextResponse.json(
        await listFieldTicketSourceCertificationCandidates({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
        }),
      );
    } catch (error) {
      return apiErrorResponse(error, {
        ...(error instanceof FieldTicketSourceCertificationError ? { safeStatus: 422 } : {}),
      });
    }
  },
});

export const POST = defineRoute({
  permission: "time.manage",
  feature: "fieldTickets",
  body,
  invalidBodyStatus: 422,
  handler: async ({ request, authz, body: input }) => {
    try {
      const record = await certifyFieldTicketSourceIdentity({
        ...input,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
      });
      return NextResponse.json({ record });
    } catch (error) {
      return apiErrorResponse(error, {
        request,
        ...(error instanceof FieldTicketSourceCertificationError ? { safeStatus: 422 } : {}),
      });
    }
  },
});
