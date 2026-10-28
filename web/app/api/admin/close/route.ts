import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { guardCloseScope } from "@/lib/close-scope";

import { NextResponse } from "next/server";
import {
  CLOSE_MODULES,
  CloseError,
  type CloseModule,
} from "@openbooks/engine/periods/period-policy";
import {
  submitPeriodReopen,
  extendReopenRequest,
  recloseApprovedReopen,
  requestPeriodReopen,
  withdrawPeriodReopen,
} from "@openbooks/engine/close/reopening";
import { can, getAuthz, guardSubsidiaryScope } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";
import { isFeatureEnabled } from "../../../../lib/features";
import {
  requestBodySchema,
  type Body,
  generateAccountingPeriods,
  saveAutomation,
  saveBlueprint,
  saveCalendar,
  savePackage,
  savePolicy,
  enqueueClosePackageDelivery,
} from "../../../../lib/close/admin-settings";
import {
  closeAdminPeriodModules,
  getAdminBankingCloseStatus,
  setAdminPeriodLockState,
} from "../../../../lib/close/admin-period-actions";

export const POST = defineRoute({
  // Close scope is capability-blind: a selected subsidiary must see 404 for
  // every organization-wide close action, including a malformed one, before
  // the typed body is validated. Per-action permission stays in the handler.
  authorize: async ({ request }) => {
    const session = await getAuthz();
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    let action = "";
    try {
      const payload: unknown = await request.clone().json();
      if (
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        typeof payload.action === "string"
      )
        action = payload.action;
    } catch {
      // The declared body schema answers malformed bodies once scope passes.
    }
    if (action !== "set-lock") {
      const denied = guardCloseScope(session);
      if (denied) return denied;
    }
    return session;
  },
  feature: {
    none: "Close has no route-wide feature gate; the handler enforces per-action permission, close scope, and the Advanced close feature.",
  },
  body: requestBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ body: parsedBody, authz: routeAuthz }) => {
    const body = parsedBody as Body;

    const action = typeof body.action === "string" ? body.action : "";
    const permission = [
      "request-reopen",
      "submit-reopen",
      "withdraw-reopen",
      "reclose-reopen",
      "extend-reopen",
    ].includes(action)
      ? "close.reopen"
      : "periods.manage";
    const gate = routeAuthz;
    if (!can(gate, permission)) {
      return NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 });
    }

    // Only a direct lock has entity-local effects. Reopen invalidates the
    // organization-wide close review and configuration/delivery is shared.
    if (action !== "set-lock") {
      const denied = guardCloseScope(gate);
      if (denied) return denied;
    }
    const { orgId, id: actorId } = gate.user;
    try {
      const advancedActions = new Set([
        "save-blueprint",
        "save-policy",
        "save-automation",
        "save-package",
        "send-package",
      ]);
      if (advancedActions.has(action) && !(await isFeatureEnabled(orgId, "advancedClose"))) {
        throw new CloseError(
          "enable Advanced close controls to manage blueprints, policies, automation, or reporting packages",
        );
      }
      if (action === "save-calendar")
        return NextResponse.json({
          ok: true,
          id: await saveCalendar(orgId, actorId, body),
        });
      if (action === "generate-periods") {
        const calendarId = text(body, "calendarId", true)!;
        if (!isUuid(calendarId)) throw new CloseError("invalid calendarId");
        return NextResponse.json({
          ok: true,
          ...(await generateAccountingPeriods(orgId, calendarId, Number(body.fiscalYear), actorId)),
        });
      }
      if (action === "save-blueprint")
        return NextResponse.json({
          ok: true,
          id: await saveBlueprint(orgId, actorId, body),
        });
      if (action === "save-policy")
        return NextResponse.json({
          ok: true,
          id: await savePolicy(orgId, actorId, body),
        });
      if (action === "save-automation")
        return NextResponse.json({
          ok: true,
          id: await saveAutomation(orgId, actorId, body),
        });
      if (action === "save-package")
        return NextResponse.json({
          ok: true,
          id: await savePackage(orgId, actorId, body),
        });
      if (action === "send-package") {
        const packageId = text(body, "packageId", true)!;
        const periodId = text(body, "periodId", true)!;
        const bookId = text(body, "bookId", true)!;
        // The send intent key comes from the request (one dialog instance,
        // rotated after success): a double-click reuses it and dedupes in
        // BullMQ and in the email worker, instead of sending both mails.
        const idempotencyKey = text(body, "idempotencyKey", true)!;
        if (!isUuid(packageId) || !isUuid(periodId) || !isUuid(bookId) || !isUuid(idempotencyKey))
          throw new CloseError("invalid send target");
        await enqueueClosePackageDelivery({
          orgId,
          packageId,
          periodId,
          bookId,
          actorId,
          idempotencyKey,
        });
        return NextResponse.json({ ok: true });
      }
      if (action === "set-lock") {
        const periodId = text(body, "periodId", true)!;
        const bookId = text(body, "bookId", true)!;
        const subsidiaryId = text(body, "subsidiaryId");
        const module = text(body, "module", true)! as CloseModule;
        const state = text(body, "state", true)! as "open" | "soft_closed" | "closed";
        if (
          !isUuid(periodId) ||
          !isUuid(bookId) ||
          (subsidiaryId && !isUuid(subsidiaryId)) ||
          !CLOSE_MODULES.includes(module) ||
          !["open", "soft_closed", "closed"].includes(state)
        )
          throw new CloseError("invalid lock scope or state");
        const denied = guardSubsidiaryScope(gate, subsidiaryId);
        if (denied) return denied;
        return NextResponse.json(await setAdminPeriodLockState(orgId, actorId, body));
      }
      if (action === "close-period") {
        const periodId = text(body, "periodId", true)!;
        const bookId = text(body, "bookId", true)!;
        const subsidiaryId = text(body, "subsidiaryId");
        if (!isUuid(periodId) || !isUuid(bookId) || (subsidiaryId && !isUuid(subsidiaryId)))
          throw new CloseError("invalid lock scope or state");
        const denied = guardSubsidiaryScope(gate, subsidiaryId);
        if (denied) return denied;
        return NextResponse.json(await closeAdminPeriodModules(orgId, actorId, body));
      }
      if (action === "banking-close-status") {
        const periodId = text(body, "periodId", true)!;
        const bookId = text(body, "bookId", true)!;
        const subsidiaryId = text(body, "subsidiaryId");
        if (!isUuid(periodId) || !isUuid(bookId) || (subsidiaryId && !isUuid(subsidiaryId)))
          throw new CloseError("invalid lock scope or state");
        const denied = guardSubsidiaryScope(gate, subsidiaryId);
        if (denied) return denied;
        return NextResponse.json(await getAdminBankingCloseStatus(orgId, actorId, body));
      }
      if (action === "request-reopen") {
        const periodId = text(body, "periodId", true)!;
        const bookId = text(body, "bookId", true)!;
        const subsidiaryId = text(body, "subsidiaryId");
        if (!isUuid(periodId) || !isUuid(bookId) || (subsidiaryId && !isUuid(subsidiaryId)))
          throw new CloseError("invalid reopen scope");
        const modules = Array.isArray(body.modules)
          ? body.modules.filter(
              (item): item is CloseModule =>
                typeof item === "string" && CLOSE_MODULES.includes(item as CloseModule),
            )
          : [];
        const requestId = await requestPeriodReopen({
          orgId,
          periodId,
          bookId,
          subsidiaryId: subsidiaryId ?? undefined,
          modules,
          reason: text(body, "reason", true)!,
          actorId,
          hours: body.hours == null ? undefined : Number(body.hours),
        });
        return NextResponse.json({ ok: true, requestId });
      }
      if (action === "submit-reopen") {
        const requestId = text(body, "requestId", true)!;
        if (!isUuid(requestId)) throw new CloseError("invalid reopen request");
        const result = await submitPeriodReopen({
          orgId,
          requestId,
          actorId,
          hours: body.hours == null ? undefined : Number(body.hours),
        });
        return NextResponse.json({ ok: true, ...result });
      }
      if (action === "withdraw-reopen") {
        const requestId = text(body, "requestId", true)!;
        if (!isUuid(requestId)) throw new CloseError("invalid reopen request");
        await withdrawPeriodReopen({
          orgId,
          requestId,
          actorId,
          reason: text(body, "reason", true)!,
        });
        return NextResponse.json({ ok: true });
      }
      if (action === "reclose-reopen") {
        const requestId = text(body, "requestId", true)!;
        if (!isUuid(requestId)) throw new CloseError("invalid reopen request");
        await recloseApprovedReopen({
          orgId,
          requestId,
          actorId,
          reason: text(body, "reason", true)!,
        });
        return NextResponse.json({ ok: true });
      }
      if (action === "extend-reopen") {
        const requestId = text(body, "requestId", true)!;
        if (!isUuid(requestId)) throw new CloseError("invalid reopen request");
        const addModules = Array.isArray(body.addModules)
          ? body.addModules.filter(
              (item): item is CloseModule =>
                typeof item === "string" && CLOSE_MODULES.includes(item as CloseModule),
            )
          : undefined;
        const extended = await extendReopenRequest({
          orgId,
          requestId,
          actorId,
          reason: text(body, "reason", true)!,
          additionalHours: body.additionalHours == null ? undefined : Number(body.additionalHours),
          addModules,
        });
        return NextResponse.json({ ok: true, ...extended });
      }
      return NextResponse.json({ error: "unknown close setup action" }, { status: 400 });
    } catch (error) {
      if (error instanceof CloseError) return apiErrorResponse(error, { safeStatus: 422 });
      throw error;
    }
  },
});
