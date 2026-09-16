import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { guardPermission } from "../../../../lib/authz";
import {
  readCompanySettings,
  SETTINGS_READ_PERMISSION,
  SETTINGS_WRITE_PERMISSION,
  updateCompanySettings,
} from "../../../../lib/company-settings";

export const runtime = "nodejs";

/**
 * Company & Accounting settings. GET preserves the user-administration view of
 * organization identity, locale, and the two independent accounting policies.
 * PUT persists the complete setup policy: identity, base currency, fiscal
 * calendar, reporting/tax policy, and control accounts.
 *
 * Reads retain the existing user-administration gate because the response is
 * still the company-administration view rather than a posting endpoint.
 * Every write is a setup operation and is separately gated by
 * admin.setup.manage: even an
 * identity-only payload shares one authoritative settings mutation boundary
 * with ledger policy and must never inherit user-administration authority.
 *
 * A fresh organization may change its fiscal-year start month. Once its active
 * default calendar has posted/reversed journals or a non-open period lock, the
 * fiscal foundation is immutable and the transaction refuses the entire PUT.
 */

// The settings read and mutation live in web/lib/company-settings.ts so the
// assistant/MCP `get_company_settings` / `update_company_settings` commands
// are the same operations; this route is the HTTP adapter.

export async function GET() {
  const gate = await guardPermission(SETTINGS_READ_PERMISSION);
  if (gate instanceof NextResponse) return gate;
  const result = await readCompanySettings(gate.user.orgId);
  return NextResponse.json(result.body, { status: result.status });
}

export async function PUT(req: Request) {
  const gate = await guardPermission(SETTINGS_WRITE_PERMISSION);
  if (gate instanceof NextResponse) return gate;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const result = await updateCompanySettings(gate.user, parsedBody.data as Record<string, unknown>);
  return NextResponse.json(result.body, { status: result.status });
}
