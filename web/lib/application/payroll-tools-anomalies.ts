import "server-only";
import { z } from "zod";
import {
  runAnomalyScan,
  computeAnomalyBaselines,
  resolveFlag,
} from "@openbooks/engine/hrm/ai/anomalies";
import { AiRailsError } from "@openbooks/engine/hrm/ai/errors";
import { isCivilDate } from "@openbooks/engine/hrm/temporal";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { IDEMPOTENCY_KEY, payrollActor, UUID } from "./payroll-tools-common";

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCivilDate)
  .describe("Real calendar date in YYYY-MM-DD form.");
const ANY_ANOMALY_REVIEWER = (authz: Parameters<typeof can>[0]) =>
  ["payroll.manage", "time.approve", "hrm.employment.read"].some((permission) =>
    can(authz, permission),
  );

function settleAiRails(error: unknown): never {
  if (!(error instanceof AiRailsError)) throw error;
  const status =
    error.code === "ai_invalid_input" || error.code === "ai_reason_required"
      ? 400
      : error.code === "ai_forbidden" || error.code === "ai_autonomy_raise_refused"
        ? 403
        : [
              "ai_subject_missing",
              "ai_flag_missing",
              "ai_capability_missing",
              "ai_decision_missing",
              "ai_feature_off",
              "ai_unknown_capability",
              "ai_unknown_draft_kind",
            ].includes(error.code)
          ? 404
          : error.code === "ai_finalize_blocked" || error.code === "ai_flag_closed"
            ? 409
            : 422;
  throw new ApplicationError(
    status === 403
      ? "forbidden"
      : status === 404
        ? "not_found"
        : status === 409
          ? "conflict"
          : "invalid_input",
    error.message,
    status,
  );
}

async function authorizeAnomalyFeature(context: ApplicationContext, feature: string) {
  if (!(await isFeatureEnabled(context.authz.user.orgId, feature))) throw notFound("record");
}

export const PAYROLL_ANOMALY_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "scan_payroll_anomalies",
    title: "Scan Payroll Anomalies",
    description:
      "Scan a payroll period for payroll compliance and calculation exceptions; blocking flags must be resolved or acknowledged before the run can commit. Read existing flags with payroll_anomalies and verify the scan there.",
    inputSchema: z
      .object({
        periodFrom: DATE.describe("First date included in the payroll scan."),
        periodTo: DATE.describe("Last date included in the payroll scan."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine((input) => input.periodTo >= input.periodFrom, {
        message: "periodTo must be on or after periodFrom.",
        path: ["periodTo"],
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      assertApplicationPermission(context, "payroll.manage");
      await authorizeAnomalyFeature(context, "payroll");
      try {
        const summary = await runAnomalyScan({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          periodFrom: input.periodFrom,
          periodTo: input.periodTo,
        });
        return { ok: true, summary, href: "/payroll/anomalies" };
      } catch (error) {
        settleAiRails(error);
      }
    },
  }),
  definition({
    name: "scan_time_anomalies",
    title: "Scan Time Anomalies",
    description:
      "Scan a date range for timekeeping anomalies using the shared workforce anomaly engine. Read the resulting flags with payroll_anomalies; payroll-only flags are not included in this time-tracking scan.",
    inputSchema: z
      .object({
        periodFrom: DATE.describe("First date included in the time scan."),
        periodTo: DATE.describe("Last date included in the time scan."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine((input) => input.periodTo >= input.periodFrom, {
        message: "periodTo must be on or after periodFrom.",
        path: ["periodTo"],
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.approve") || can(authz, "payroll.manage"),
    featureKey: "timeTracking",
    execute: async (context, input) => {
      if (!can(context.authz, "time.approve") && !can(context.authz, "payroll.manage"))
        throw new ApplicationError(
          "forbidden",
          "missing permission: time.approve or payroll.manage",
          403,
        );
      await authorizeAnomalyFeature(context, "timeTracking");
      try {
        const summary = await runAnomalyScan({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          periodFrom: input.periodFrom,
          periodTo: input.periodTo,
          options: { timeOnly: true },
        });
        return { ok: true, summary, href: "/payroll/anomalies" };
      } catch (error) {
        settleAiRails(error);
      }
    },
  }),
  definition({
    name: "compute_payroll_anomaly_baselines",
    title: "Compute Payroll Anomaly Baselines",
    description:
      "Recompute the historical payroll anomaly baselines before reviewing a payroll scan. Read the resulting flags with payroll_anomalies; the baseline calculation does not change payroll runs.",
    inputSchema: z.object({
      windowPeriods: z
        .number()
        .int()
        .min(2)
        .max(24)
        .optional()
        .describe(
          "Number of historical pay periods used for baseline windows; defaults to the service policy.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      assertApplicationPermission(context, "payroll.manage");
      await authorizeAnomalyFeature(context, "payroll");
      try {
        const baselines = await computeAnomalyBaselines({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          windowPeriods: input.windowPeriods,
        });
        return { ok: true, baselines, href: "/payroll/anomalies" };
      } catch (error) {
        settleAiRails(error);
      }
    },
  }),
  definition({
    name: "resolve_payroll_anomaly",
    title: "Resolve Payroll Anomaly",
    description:
      "Acknowledge, resolve or mark a payroll anomaly as a false positive with an audited reason. Find the flag id with payroll_anomalies and verify its resulting state with that read tool.",
    inputSchema: z.object({
      flagId: UUID("Anomaly flag id from payroll_anomalies."),
      to: z
        .enum(["acknowledged", "resolved", "false_positive"])
        .describe("Target lifecycle state for this flag."),
      reason: z.string().min(1).max(500).describe("Reason retained in the anomaly audit."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: ANY_ANOMALY_REVIEWER,
    execute: async (context, input) => {
      if (!ANY_ANOMALY_REVIEWER(context.authz))
        throw new ApplicationError(
          "forbidden",
          "missing permission: one of payroll.manage, time.approve, hrm.employment.read",
          403,
        );
      if (
        !(await isFeatureEnabled(context.authz.user.orgId, "payroll")) &&
        !(await isFeatureEnabled(context.authz.user.orgId, "timeTracking"))
      )
        throw notFound("record");
      try {
        const flag = await resolveFlag({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          flagId: input.flagId,
          to: input.to,
          reason: input.reason,
        });
        return { ok: true, flag, href: "/payroll/anomalies" };
      } catch (error) {
        settleAiRails(error);
      }
    },
  }),
];
