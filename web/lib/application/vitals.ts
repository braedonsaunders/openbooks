import "server-only";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { can } from "../authz";
import { analyticsConfig } from "../analytics/config";
import { cashPosition } from "../cash/cash-position";
import { normalizeMoneyValue } from "../cash/core";
import { agingByParty } from "../reports";
import { listApprovalWorklist } from "./approvals";
import { listCloseRuns } from "./close";
import type { ApplicationContext } from "./context";

/**
 * One snapshot, one set of numbers. Every figure here comes from the SAME
 * resolver the corresponding screen renders from (the Banking cash cockpit,
 * the aging report, the approvals worklist, the close workspace), so this
 * surface can never quote a number the app would disagree with.
 *
 * A section the actor may not read is returned as
 * { available: false, reason } — an absent value must say why it is absent,
 * never masquerade as zero.
 */

type Unavailable = { available: false; reason: string };

function unavailable(permission: string): Unavailable {
  return { available: false, reason: `requires ${permission}` };
}

const CASH_HORIZON_WEEKS = 4;

async function cashSection(context: ApplicationContext) {
  if (!can(context.authz, "banking.read")) return unavailable("banking.read");
  const cfg = await analyticsConfig(context.authz.user.orgId, "cashflow");
  const position = await cashPosition(context.authz.user.orgId, CASH_HORIZON_WEEKS, {
    weeklyCap: normalizeMoneyValue(String(cfg.weeklyApCap ?? 0)),
    restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1,
  }, undefined, undefined, context.authz.allowedSubsidiaryIds);
  return {
    available: true as const,
    asOf: position.asOf,
    bankCash: position.startingCash,
    bankAccounts: position.bankAccounts.length,
    horizonWeeks: position.horizonWeeks,
    projectedEnd: position.projectedEnd,
    lowestCash: position.lowestCash,
    lowestWeek: position.lowestWeek,
    runwayStatus: position.runwayStatus,
    runwayWeeks: position.runwayWeeks,
    arOutstanding: position.arOutstanding,
    apOutstanding: position.apOutstanding,
    arCoverage: position.arCoverage,
    dso: position.dso,
    dpo: position.dpo,
  };
}

async function agingSection(context: ApplicationContext, side: "ar" | "ap", asOf: string) {
  const permission = side === "ar" ? "ar.read" : "ap.read";
  if (!can(context.authz, permission)) return unavailable(permission);
  const dims = context.authz.allowedSubsidiaryIds === null ? undefined
    : { subsidiaryIds: [...context.authz.allowedSubsidiaryIds] };
  const result = await agingByParty(side, asOf, dims, context.authz.user.orgId);
  return {
    available: true as const,
    asOf: result.asOf,
    totals: result.totals,
    parties: result.rows.length,
  };
}

async function approvalsSection(context: ApplicationContext) {
  if (!can(context.authz, "flows.approve")) return unavailable("flows.approve");
  const approvals = await listApprovalWorklist(context);
  return { available: true as const, pending: approvals.length };
}

async function closeSection(context: ApplicationContext) {
  if (!can(context.authz, "close.run")) return unavailable("close.run");
  const runs = await listCloseRuns(context, { limit: 5 });
  const latest = runs[0];
  return {
    available: true as const,
    recentRuns: runs.length,
    latest: latest
      ? {
        runId: latest.id,
        period: latest.periodName,
        book: latest.bookCode,
        status: latest.status,
        currentStage: latest.currentStage,
        targetCloseDate: latest.targetCloseDate,
      }
      : null,
  };
}

export async function orgVitals(context: ApplicationContext) {
  const asOf = await businessToday(context.authz.user.orgId);
  const [cash, arAging, apAging, approvals, close] = await Promise.all([
    cashSection(context),
    agingSection(context, "ar", asOf),
    agingSection(context, "ap", asOf),
    approvalsSection(context),
    closeSection(context),
  ]);
  return { asOf, cash, arAging, apAging, approvals, close };
}
