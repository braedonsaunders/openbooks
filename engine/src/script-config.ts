import { computeScheduledScriptNextRunAt, InvalidScheduledScriptCronError, INVALID_SCHEDULED_SCRIPT_CRON_CODE } from "./scripting.ts";

export type ScriptValidationError = { message: string; code?: string; field?: string };
const TRIGGERS = ["before_submit", "before_post", "after_post", "before_void", "scheduled", "endpoint", "bulk", "client"];
const SLUG = /^[a-z][a-z0-9-]*$/;

/** Shared configuration boundary for API edits and reviewed promotions. */
export function validateScriptConfiguration(body: Record<string, unknown>): ScriptValidationError | null {
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 200) return { message: "name required (max 200 chars)", field: "name" };
  if (typeof body.triggerPoint !== "string" || !TRIGGERS.includes(body.triggerPoint)) return { message: "invalid trigger point", field: "triggerPoint" };
  if (typeof body.source !== "string" || !body.source || body.source.length > 100_000) return { message: "source required (max 100k chars)", field: "source" };
  if (!/function\s+main\s*\(/.test(body.source)) return { message: "script must define function main(ctx)", field: "source" };
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") return { message: "isActive must be a boolean", field: "isActive" };
  if (body.documentKind !== undefined && body.documentKind !== null && (typeof body.documentKind !== "string" || !body.documentKind.trim())) return { message: "documentKind must be a nonempty string or null", field: "documentKind" };
  if (body.timeoutMs !== undefined && (typeof body.timeoutMs !== "number" || !Number.isInteger(body.timeoutMs) || body.timeoutMs < 1 || body.timeoutMs > 10_000)) return { message: "timeoutMs must be an integer from 1 to 10000", field: "timeoutMs" };
  if (body.sortOrder !== undefined && (typeof body.sortOrder !== "number" || !Number.isInteger(body.sortOrder) || body.sortOrder < -2_147_483_648 || body.sortOrder > 2_147_483_647)) return { message: "sortOrder must be a 32-bit integer", field: "sortOrder" };
  if (body.cron !== undefined && body.cron !== null && typeof body.cron !== "string") return { message: "cron must be a string or null", code: INVALID_SCHEDULED_SCRIPT_CRON_CODE, field: "cron" };
  if (body.endpointSlug !== undefined && body.endpointSlug !== null && typeof body.endpointSlug !== "string") return { message: "endpointSlug must be a string or null", field: "endpointSlug" };
  if (body.triggerPoint === "scheduled") {
    const cron = typeof body.cron === "string" ? body.cron.trim() : "";
    if (cron.length > 200) return { message: "cron expression too long", code: INVALID_SCHEDULED_SCRIPT_CRON_CODE, field: "cron" };
    try { computeScheduledScriptNextRunAt(cron); }
    catch (error) {
      if (!(error instanceof InvalidScheduledScriptCronError)) throw error;
      return { message: error.message, code: INVALID_SCHEDULED_SCRIPT_CRON_CODE, field: "cron" };
    }
  }
  if (body.triggerPoint === "endpoint") {
    const slug = typeof body.endpointSlug === "string" ? body.endpointSlug.trim() : "";
    if (!slug || slug.length > 80 || !SLUG.test(slug)) return { message: "endpoint slug must use lowercase letters, digits and hyphens (max 80 chars)", field: "endpointSlug" };
  }
  return null;
}
