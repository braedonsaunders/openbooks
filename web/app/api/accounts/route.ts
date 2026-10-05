import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  lockScopeRow,
  ScopeNotFoundError,
} from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { ACCOUNT_TYPES } from "@openbooks/schema";
import {
  guardSubsidiaryScope,
  guardUnrestrictedScope,
} from "../../../lib/authz";
import {
  isFeatureEnabled,
  subsidiaryFeatureEnabled,
} from "../../../lib/features";
import {
  findUnownedCustomReferences,
  loadFieldDefs,
  validateCustomValues,
} from "../../../lib/custom-fields";
import { assetBankHygieneWarning } from "../../../lib/accounts-hygiene";
import { isUuid } from "../../../lib/list-params";
import { loadAccount, orgBaseCurrency } from "./_lib";
import { accountInputFields } from "./_input";

import {
  claimIdempotentCreate,
  resolveIdempotentReplay,
  SetupCreateConflict,
} from "../../../lib/api/idempotency";
import { conflict } from "../../../lib/api/responses";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const CURRENCY_RE = /^[A-Z]{3}$/;

const createBodySchema = z.strictObject({
  ...accountInputFields,
  name: z.string().trim().min(1, "name is required"),
  type: z.enum(ACCOUNT_TYPES),
});

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status });
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Create one tenant-owned account.
 *
 * The caller supplies a UUID idempotency key, which becomes the account ID.
 * Retrying the same request therefore returns the same account without a
 * duplicate insert or duplicate audit event.
 */
export const POST = defineRoute({
  permission: "gl.manage",
  feature: {
    none: "Chart of accounts setup is always available and is governed by account permissions.",
  },
  body: createBodySchema,
  handler: async ({ request, authz: gate, body: routeBody }) => {
    const requestId = request.headers.get("Idempotency-Key")?.trim() ?? "";
    if (!isUuid(requestId))
      return bad("invalid_idempotency_key", undefined, 400);

    const body = routeBody;
    // Multi-currency off refuses settlement-currency writes — except the one the
    // reconcilable invariant forces: a reconcilable account must carry a
    // currency, and a single-currency org has only its base.
    if (
      body.currencyRestriction !== undefined &&
      !(await isFeatureEnabled(gate.user.orgId, "multiCurrency"))
    ) {
      const restriction = body.currencyRestriction?.toUpperCase() ?? null;
      const base = await orgBaseCurrency(gate.user.orgId);
      if (!(
        body.reconcilable === true &&
        restriction &&
        base &&
        restriction === base
      )) {
        return notFound("record");
      }
    }
    if (
      body.eliminate !== undefined &&
      !(await subsidiaryFeatureEnabled(gate.user.orgId))
    ) {
      return notFound("record");
    }

    const name = body.name?.trim() ?? "";
    if (!name) return bad("name_required", "name");
    if (
      !body.type ||
      !ACCOUNT_TYPES.includes(body.type as (typeof ACCOUNT_TYPES)[number])
    ) {
      return bad("invalid_type", "type");
    }

    const number = textOrNull(body.number);
    const description = textOrNull(body.description);
    const parentId = textOrNull(body.parentId);
    const isSummary = body.isSummary === true;
    const isActive = body.isActive !== false;
    const reconcilable = body.reconcilable === true;
    if (isSummary && reconcilable) return bad("summary_reconcilable_conflict");

    if (parentId && !isUuid(parentId)) return bad("invalid_parent", "parentId");

    const currencyRestriction =
      textOrNull(body.currencyRestriction)?.toUpperCase() ?? null;
    if (currencyRestriction) {
      if (!CURRENCY_RE.test(currencyRestriction))
        return bad("invalid_currency", "currencyRestriction");
      const currency = await db.execute(sql`
      select 1 from currencies where code = ${currencyRestriction}
    `);
      if (!currency.rows[0])
        return bad("invalid_currency", "currencyRestriction");
    }
    // Storage requires reconcilable accounts to carry a settlement currency
    // (accounts_reconcilable_currency_required). Refuse the combination here
    // as a request-state failure instead of surfacing a raw constraint error.
    if (reconcilable && !currencyRestriction) {
      return bad("reconcilable_currency_required", "currencyRestriction");
    }

    const subsidiaryId = textOrNull(body.subsidiaryId);
    if (subsidiaryId) {
      if (!isUuid(subsidiaryId))
        return bad("invalid_subsidiary", "subsidiaryId");
      const subsidiary = await db.execute(sql`
      select 1 from subsidiaries
       where id = ${subsidiaryId} and org_id = ${gate.user.orgId}
    `);
      if (!subsidiary.rows[0]) return bad("invalid_subsidiary", "subsidiaryId");
      // A restricted caller may never mint an account for a subsidiary they
      // cannot see; a missing or foreign id stays invalid_subsidiary above.
      const denied = guardSubsidiaryScope(gate, subsidiaryId);
      if (denied) return denied;
    } else if (!parentId) {
      // No subsidiary means the shared chart: an org-wide write.
      const orgWideDenied = guardUnrestrictedScope(gate);
      if (orgWideDenied) return orgWideDenied;
    }
    // With a parent and no explicit subsidiary the account inherits the
    // parent's subsidiary, so the org-wide gate must not fire before the
    // parent lock: a hidden parent would answer 403 while a genuinely absent
    // one answers 404, and the difference discloses the hidden row. The
    // effective subsidiary is resolved inside the write transaction below.

    const definitions = await db.execute<{ key: string }>(sql`
    select key from segment_definitions
     where org_id = ${gate.user.orgId} and is_active and allow_account_requirement
  `);
    const allowedDimensions = new Set([
      "party",
      ...definitions.rows.map((row) => row.key),
    ]);
    const requestedDimensions = body.requiredDimensions ?? [];
    if (
      !Array.isArray(requestedDimensions) ||
      requestedDimensions.some(
        (dimension) =>
          typeof dimension !== "string" || !allowedDimensions.has(dimension),
      )
    ) {
      return bad("invalid_dimensions", "requiredDimensions");
    }
    const requiredDimensions = [...new Set(requestedDimensions)];

    const customDefs = await loadFieldDefs("accounts");
    const validatedCustom = validateCustomValues(customDefs, body.custom ?? {});
    if (!validatedCustom.ok) return bad("invalid_custom_fields", "custom");
    // Reference custom values are uuid-SHAPED at this point but nothing proves
    // the referenced row belongs to the caller: refuse foreign or dangling ids
    // instead of persisting a cross-tenant pointer.
    const unownedCreateRefs = await findUnownedCustomReferences(
      gate.user.orgId,
      customDefs,
      validatedCustom.cleaned,
    );
    if (unownedCreateRefs.length > 0)
      return bad("unknown_custom_reference", "custom");
    const custom = validatedCustom.cleaned;

    let created: boolean | NextResponse = false;
    try {
      created = await db.transaction(async (tx) => {
        // The account inherits its parent's subsidiary when the body names
        // none. Resolve it under the hierarchy lock so the scope decision and
        // the stored row agree, and so a hidden parent reads as not found
        // exactly like an absent one.
        let effectiveSubsidiaryId = subsidiaryId;
        if (parentId) {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`accounts-hierarchy:${gate.user.orgId}`}, 0))`,
          );
          try {
            await lockScopeRow(
              tx,
              gate.user.orgId,
              "account",
              parentId,
              gate.allowedSubsidiaryIds,
              "share",
              { orgWideNull: true },
            );
          } catch (error) {
            if (!(error instanceof ScopeNotFoundError)) throw error;
            return notFound("record");
          }
          const parent = (
            await tx.execute<{
              is_summary: boolean;
              is_active: boolean;
              type: string;
              subsidiary_id: string | null;
            }>(sql`
          select is_summary, is_active, type, subsidiary_id from accounts where id = ${parentId} and org_id = ${gate.user.orgId}
        `)
          ).rows[0];
          if (!parent) return notFound("record");
          if (!parent.is_summary)
            return bad("parent_must_be_summary", "parentId");
          if (!parent.is_active) return bad("inactive_parent", "parentId");
          if (parent.type !== body.type)
            return bad("parent_type_mismatch", "parentId");
          if (effectiveSubsidiaryId === null) {
            effectiveSubsidiaryId = parent.subsidiary_id;
            if (effectiveSubsidiaryId === null) {
              const orgWideDenied = guardUnrestrictedScope(gate);
              if (orgWideDenied) return orgWideDenied;
            } else {
              const denied = guardSubsidiaryScope(gate, effectiveSubsidiaryId);
              if (denied) return denied;
            }
          }
        }
        const snapshot = {
          id: requestId,
          org_id: gate.user.orgId,
          number,
          name,
          type: body.type,
          description,
          parent_id: parentId,
          is_summary: isSummary,
          is_active: isActive,
          currency_restriction: currencyRestriction,
          eliminate: body.eliminate === true,
          subsidiary_id: effectiveSubsidiaryId,
          subsidiary_include_children: body.subsidiaryIncludeChildren !== false,
          reconcilable,
          monetary: typeof body.monetary === "boolean" ? body.monetary : null,
          required_dimensions: requiredDimensions,
          custom,
        };
        const claim = await claimIdempotentCreate(tx, {
          orgId: gate.user.orgId,
          table: "accounts",
          key: requestId,
        });
        if (claim === "exists") {
          const replay = await resolveIdempotentReplay(tx, {
            orgId: gate.user.orgId,
            table: "accounts",
            key: requestId,
            match: snapshot,
          });
          if (replay === "replay") return false;
          throw new SetupCreateConflict("changed-payload");
        }
        // Another transaction may claim this key after the preflight read;
        // the missing RETURNING row is re-read from the immutable audit image
        // below and becomes either an exact replay or a typed conflict.
        const inserted = await tx.execute<{ id: string }>(sql`
        insert into accounts
          (id, org_id, number, name, type, description, parent_id, is_summary, is_active,
           currency_restriction, eliminate, subsidiary_id, subsidiary_include_children,
           reconcilable, monetary, required_dimensions, custom, created_by, updated_by)
        values
          (${requestId}, ${gate.user.orgId}, ${number}, ${name}, ${body.type}, ${description},
           ${parentId}, ${isSummary}, ${isActive}, ${currencyRestriction}, ${body.eliminate === true},
           ${effectiveSubsidiaryId}, ${body.subsidiaryIncludeChildren !== false}, ${reconcilable},
           ${typeof body.monetary === "boolean" ? body.monetary : null},
           ${JSON.stringify(requiredDimensions)}::jsonb, ${JSON.stringify(custom)}::jsonb,
           ${gate.user.id}, ${gate.user.id})
        -- A retry is accepted only after the existing audited create payload is verified below.
        on conflict (id) do nothing
        returning id
      `);
        if (!inserted.rows[0]) {
          const replay = await resolveIdempotentReplay(tx, {
            orgId: gate.user.orgId,
            table: "accounts",
            key: requestId,
            match: snapshot,
          });
          if (replay === "replay") return false;
          throw new SetupCreateConflict("foreign-key");
        }
        await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values
          (${gate.user.orgId}, 'accounts', ${requestId}, 'insert',
           ${JSON.stringify({ before: null, after: snapshot })}::jsonb,
           ${gate.user.id}, ${requestId})
      `);
        return true;
      });
    } catch (error) {
      if (error instanceof SetupCreateConflict) {
        return conflict(error.code, {
          remedy:
            "Close and reopen the account drawer to retry with a fresh request key.",
        });
      }
      const message =
        error instanceof Error
          ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`
          : String(error);
      if (message.includes("accounts_org_number"))
        return bad("number_in_use", "number");
      if (message.includes("parent_not_found")) return notFound("record");
      if (message.includes("inactive_parent"))
        return bad("inactive_parent", "parentId");
      if (message.includes("parent_must_be_summary"))
        return bad("parent_must_be_summary", "parentId");
      if (message.includes("parent_type_mismatch"))
        return bad("parent_type_mismatch", "parentId");
      throw error;
    }
    if (created instanceof NextResponse) return created;

    const payload = await loadAccount(
      requestId,
      gate.user.orgId,
      gate.allowedSubsidiaryIds,
    );
    if (!payload) return bad("save_failed", undefined, 500);
    // A fresh account backs no statements yet: corroboration is the request's
    // own name and reconcilable flag. The warning rides alongside success —
    // the account is always created.
    const hygiene = assetBankHygieneWarning({
      type: String(body.type),
      name,
      reconcilable,
      isSummary,
    });
    return NextResponse.json(
      { ...payload, warnings: hygiene ? [hygiene] : [] },
      { status: created ? 201 : 200 },
    );
  },
});
