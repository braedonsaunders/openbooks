import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/src/db.ts";
import {
  PaymentAcceptanceError,
  createPaymentLink,
  listPaymentLinks,
} from "@openbooks/engine/src/payment-acceptance.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";
import { nullableUuidId, parseJsonBody, uuidId } from "../../../../lib/api/json";

export const runtime = "nodejs";

const createLinkBody = z.object({
  provider: z.enum(["stripe", "adyen", "gocardless"], {
    error: "provider must be stripe, adyen or gocardless",
  }),
  documentId: z
    .string({ error: "documentId is required" })
    .refine((v) => uuidId.safeParse(v).success, "documentId is required"),
  bankAccountId: nullableUuidId.optional(),
  expiresOn: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
});

export async function GET(req: Request) {
  const gate = await guardPermission("ar.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "onlinePayments"))) {
    return NextResponse.json({ error: "feature disabled" }, { status: 404 });
  }
  const documentId = new URL(req.url).searchParams.get("documentId");
  if (!documentId || !isUuid(documentId)) {
    return NextResponse.json({ error: "documentId is required" }, { status: 400 });
  }
  const [links, providers] = await Promise.all([
    listPaymentLinks(gate.user.orgId, documentId),
    db.execute<{ provider: string }>(sql`
      select provider from psp_provider_configs
       where org_id = ${gate.user.orgId} and is_enabled and acceptance_enabled
         and default_bank_account_id is not null
       order by provider
    `),
  ]);
  return NextResponse.json({ links, providers: providers.rows.map((r) => r.provider) });
}

export async function POST(req: Request) {
  const gate = await guardPermission("ar.create");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "onlinePayments"))) {
    return NextResponse.json({ error: "feature disabled" }, { status: 404 });
  }
  const parsed = await parseJsonBody(req, createLinkBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  try {
    const link = await createPaymentLink(gate.user.orgId, gate.user.id, {
      documentId: body.documentId,
      provider: body.provider,
      bankAccountId: body.bankAccountId ?? null,
      expiresOn: body.expiresOn ?? null,
      memo: body.memo ?? null,
    });
    return NextResponse.json(link, { status: 201 });
  } catch (e) {
    const status = e instanceof PaymentAcceptanceError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
