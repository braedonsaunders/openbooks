import "server-only";
import { consumeReopenRequestsForClosedModules } from "@openbooks/engine/close/reopening";
import {
  auditBankingModuleClose,
  bankingCloseStatus,
  bankingUnmatchedStatementLines,
  evaluateBankingModuleClose,
} from "@openbooks/engine/close/banking-close";
import {
  CLOSE_MODULES,
  CloseError,
  type CloseModule,
} from "@openbooks/engine/periods/period-policy";
import { closePeriodAllModules, setPeriodLockState } from "@openbooks/engine/periods/period-locks";
import { isUuid } from "../list-params";

type AdminPeriodActionBody = Record<string, unknown>;

function requiredText(body: AdminPeriodActionBody, key: string): string {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (!value) throw new CloseError(`${key} is required`);
  return value;
}

function optionalText(body: AdminPeriodActionBody, key: string): string | null {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  return value || null;
}

function validatedScope(body: AdminPeriodActionBody) {
  const periodId = requiredText(body, "periodId");
  const bookId = requiredText(body, "bookId");
  const subsidiaryId = optionalText(body, "subsidiaryId");
  if (!isUuid(periodId) || !isUuid(bookId) || (subsidiaryId && !isUuid(subsidiaryId))) {
    throw new CloseError("invalid lock scope or state");
  }
  return { periodId, bookId, subsidiaryId: subsidiaryId ?? undefined };
}

/** Shared orchestration for administrative period lock transitions. */
export async function setAdminPeriodLockState(
  orgId: string,
  actorId: string,
  body: AdminPeriodActionBody,
) {
  const scope = validatedScope(body);
  const module = requiredText(body, "module") as CloseModule;
  const state = requiredText(body, "state") as "open" | "soft_closed" | "closed";
  if (!CLOSE_MODULES.includes(module) || !["open", "soft_closed", "closed"].includes(state)) {
    throw new CloseError("invalid lock scope or state");
  }
  const reason = requiredText(body, "reason");
  const acknowledgement =
    typeof body.bankingAcknowledgement === "string" ? body.bankingAcknowledgement : null;
  const bankingEvaluation =
    module === "banking" && state !== "open"
      ? await evaluateBankingModuleClose(orgId, {
          periodId: scope.periodId,
          bookId: scope.bookId,
          subsidiaryId: scope.subsidiaryId,
          actorId,
          acknowledgement,
        })
      : null;
  await setPeriodLockState({
    orgId,
    periodId: scope.periodId,
    bookId: scope.bookId,
    subsidiaryId: scope.subsidiaryId,
    module,
    state,
    actorId,
    reason,
  });
  if (bankingEvaluation && bankingEvaluation.issues.length > 0) {
    await auditBankingModuleClose(orgId, {
      periodId: scope.periodId,
      bookId: scope.bookId,
      subsidiaryId: scope.subsidiaryId,
      actorId,
      reason,
      acknowledgement: acknowledgement!.trim(),
      evaluation: bankingEvaluation,
    });
  }
  const reopenConsumed =
    state !== "open"
      ? (
          await consumeReopenRequestsForClosedModules({
            orgId,
            periodId: scope.periodId,
            bookId: scope.bookId,
            subsidiaryId: scope.subsidiaryId,
            actorId,
            reason,
          })
        ).consumed
      : [];
  return {
    ok: true,
    banking: bankingEvaluation
      ? { accounts: bankingEvaluation.accounts, strict: bankingEvaluation.strict }
      : undefined,
    reopenConsumed,
  };
}

/** Shared orchestration for the period-wide close action. */
export async function closeAdminPeriodModules(
  orgId: string,
  actorId: string,
  body: AdminPeriodActionBody,
) {
  const scope = validatedScope(body);
  const scoped = body as {
    modules?: CloseModule[];
    moduleReasons?: Partial<Record<CloseModule, string>>;
    state?: "soft_closed" | "closed";
  };
  const reason = requiredText(body, "reason");
  const closesBanking = (scoped.modules ?? [...CLOSE_MODULES]).includes("banking");
  const banking = closesBanking
    ? await evaluateBankingModuleClose(orgId, {
        periodId: scope.periodId,
        bookId: scope.bookId,
        subsidiaryId: scope.subsidiaryId,
        actorId,
        acknowledgement:
          typeof body.bankingAcknowledgement === "string" ? body.bankingAcknowledgement : null,
      })
    : null;
  const { results } = await closePeriodAllModules({
    orgId,
    periodId: scope.periodId,
    bookId: scope.bookId,
    subsidiaryId: scope.subsidiaryId,
    actorId,
    state: scoped.state ?? "closed",
    modules: scoped.modules,
    moduleReasons: scoped.moduleReasons,
    reason,
  });
  if (banking && banking.issues.length > 0) {
    await auditBankingModuleClose(orgId, {
      periodId: scope.periodId,
      bookId: scope.bookId,
      subsidiaryId: scope.subsidiaryId,
      actorId,
      reason,
      acknowledgement: (typeof body.bankingAcknowledgement === "string"
        ? body.bankingAcknowledgement
        : ""
      ).trim(),
      evaluation: banking,
    });
  }
  const reopenConsumed = results.some((result) => result.ok)
    ? (
        await consumeReopenRequestsForClosedModules({
          orgId,
          periodId: scope.periodId,
          bookId: scope.bookId,
          subsidiaryId: scope.subsidiaryId,
          actorId,
          reason,
        })
      ).consumed
    : [];
  return {
    ok: results.every((result) => result.ok),
    results,
    banking: banking ? { accounts: banking.accounts, strict: banking.strict } : undefined,
    reopenConsumed,
  };
}

/** Shared native read for banking close readiness. */
export async function getAdminBankingCloseStatus(
  orgId: string,
  actorId: string,
  body: AdminPeriodActionBody,
) {
  const scope = validatedScope(body);
  const accounts = await bankingCloseStatus(orgId, {
    periodId: scope.periodId,
    bookId: scope.bookId,
    subsidiaryId: scope.subsidiaryId,
    actorId,
  });
  const unmatchedStatementLines = await bankingUnmatchedStatementLines(orgId, {
    periodId: scope.periodId,
    bookId: scope.bookId,
    subsidiaryId: scope.subsidiaryId,
  });
  return {
    ok: true,
    accounts,
    issues: accounts.filter((account) => account.status !== "signed_off" || account.stale),
    unmatchedStatementLines,
  };
}
