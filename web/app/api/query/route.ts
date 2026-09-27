import { apiErrorResponse } from '@/lib/api/error-response'
import { z } from 'zod'
import { NextResponse } from "next/server";
import { runUserSql, validateUserSql } from "@openbooks/engine/src/platform/sqlapi.ts";
import { defineRoute } from '@/lib/api/route'
import { hasUnrestrictedQueryScope } from "../../../lib/query-console-access";

const queryBody = z.looseObject({
  sql: z.unknown().optional(),
  maxRows: z.unknown().optional(),
})

/**
 * Pure pre-validation failures (thrown as plain Errors by validateUserSql)
 * are safe to echo at 400 — the sanitizer needs a named refusal to carry
 * them instead of genericizing them to a 500.
 */
class UserSqlValidationRefusal extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "UserSqlValidationRefusal";
  }
}

export const POST = defineRoute({
  permission: 'sql.execute',
  feature: 'queryConsole',
  body: queryBody,
  handler: async ({ authz: gate, body }) => {
  if (!hasUnrestrictedQueryScope(gate.allowedSubsidiaryIds)) {
    return NextResponse.json(
      { error: "query console requires unrestricted subsidiary access" },
      { status: 403 },
    );
  }

  if (typeof body.sql !== "string" || !body.sql.trim()) {
    return NextResponse.json({ error: "missing sql" }, { status: 400 });
  }

  // Pure pre-validation: its messages are schema-free ("one statement per
  // query", "read-only: …") and safe to echo. Anything thrown past this point
  // is a real PostgreSQL error and must not leak relation/column names.
  try {
    validateUserSql(body.sql);
  } catch (e) {
    return apiErrorResponse(e instanceof Error ? new UserSqlValidationRefusal(e.message) : e);
  }

  try {
    const result = await runUserSql(body.sql, {
      orgId: gate.user.orgId,
      maxRows: Math.min(Math.max(Math.trunc(Number(body.maxRows)) || 500, 1), 5_000),
      // An analyst console over a real ledger runs genuine aggregate scans;
      // ten seconds cancelled ordinary work on a large tenant.
      timeoutMs: 30_000,
    });
    return NextResponse.json(result);
  } catch (e) {
    // Full error stays in the server log only; the client gets a generic
    // message so database internals never reach the browser.
    console.error("[query-console] execution failed", e);
    return NextResponse.json({ error: "query failed" }, { status: 400 });
  }
  },
})
