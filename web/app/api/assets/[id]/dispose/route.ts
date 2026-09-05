import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { disposeAsset } from "@openbooks/engine/src/asset-lifecycle.ts";
import {
  businessToday,
  isIsoCalendarDate,
} from "@openbooks/engine/src/business-date.ts";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { guardFeaturePermission } from "../../../../../lib/feature-gates";
import { isUuid } from "../../../../../lib/list-params";
import {
  canonicalDecimal,
  compareDecimal,
} from "../../../../../lib/exact-decimal";

export const runtime = "nodejs";

interface Body {
  date?: string;
  proceeds?: string;
  proceedsAccountId?: string;
  writeOff?: boolean;
}

/**
 * Dispose an asset by sale (or write it off): posts the disposal journal
 * (clear cost + accumulated, recognize proceeds, book gain/loss) and flips the
 * asset's status. Idempotency is enforced by the engine (an already-disposed
 * asset is rejected).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardFeaturePermission("assets.manage", "fixedAssets");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id))
    return NextResponse.json({ error: "invalid asset" }, { status: 422 });

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as Body;
  if (body.date !== undefined && !isIsoCalendarDate(body.date)) {
    return NextResponse.json(
      { error: "date must be a valid calendar date (YYYY-MM-DD)" },
      { status: 422 },
    );
  }
  const date =
    body.date === undefined ? await businessToday(gate.user.orgId) : body.date;
  const writeOff = body.writeOff === true;
  const proceedsRaw = writeOff
    ? "0"
    : canonicalDecimal(body.proceeds ?? "0", 4);
  if (proceedsRaw === null || compareDecimal(proceedsRaw, "0") < 0) {
    return NextResponse.json(
      { error: "proceeds must be a non-negative amount" },
      { status: 422 },
    );
  }
  const proceeds = normalizeMoney(proceedsRaw);
  if (
    !writeOff &&
    compareDecimal(proceeds, "0") > 0 &&
    (!body.proceedsAccountId || !isUuid(body.proceedsAccountId))
  ) {
    return NextResponse.json(
      { error: "select the account the proceeds are deposited to" },
      { status: 422 },
    );
  }

  try {
    const result = await disposeAsset(gate.user.orgId, id, {
      proceeds,
      proceedsAccountId: body.proceedsAccountId ?? null,
      date,
      actorId: gate.user.id,
      writeOff,
      ...(gate.allowedSubsidiaryIds ? { allowedSubsidiaryIds: [...gate.allowedSubsidiaryIds] } : {}),
    });
    return NextResponse.json(result);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "disposal failed" },
      { status: 422 },
    );
  }
}
