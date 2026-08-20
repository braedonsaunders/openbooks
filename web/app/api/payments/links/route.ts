import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  PaymentAcceptanceError,
  createPaymentLink,
  listPaymentLinks,
} from "@openbooks/engine/src/payment-acceptance.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { isUuid } from "../../../../lib/list-params";

export const runtime = "nodejs";

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
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const provider = body.provider;
  if (provider !== "stripe" && provider !== "adyen" && provider !== "gocardless") {
    return NextResponse.json({ error: "provider must be stripe, adyen or gocardless" }, { status: 400 });
  }
  if (typeof body.documentId !== "string" || !isUuid(body.documentId)) {
    return NextResponse.json({ error: "documentId is required" }, { status: 400 });
  }
  try {
    const link = await createPaymentLink(gate.user.orgId, gate.user.id, {
      documentId: body.documentId,
      provider,
      bankAccountId: typeof body.bankAccountId === "string" ? body.bankAccountId : null,
      expiresOn: typeof body.expiresOn === "string" ? body.expiresOn : null,
      memo: typeof body.memo === "string" ? body.memo : null,
    });
    return NextResponse.json(link, { status: 201 });
  } catch (e) {
    const status = e instanceof PaymentAcceptanceError ? 422 : 500;
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
