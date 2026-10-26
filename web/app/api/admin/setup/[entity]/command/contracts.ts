import type { SetupCommandName } from "@/lib/setup/types";

/**
 * Operation names feed the idempotency ledger, which admits lowercase dotted
 * names only; command markers read as engine function names in camelCase. The
 * route bridges the two (setup.record_channel_ad_spend), so every declared
 * command writes instead of tripping the ledger guard.
 */
export function commandOperationName(name: SetupCommandName): string {
  return `setup.${String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()}`;
}

/**
 * POST /api/admin/setup/[entity]/command — the domain-command counterpart to
 * the generic CRUD route beside it. The entity comes from the URL through the
 * Setup registry, never the body: unknown entities, entities without a
 * command marker, and feature-off entities fail closed before the body is
 * read. The marker's literal name selects one of three strict schemas and
 * one direct engine call — no dynamic lookup, no table/SQL derivation, no
 * generic fallback. Identity (org, actor) comes from the session, never the
 * request. Domain refusals keep their typed status with message, code,
 * remedy, and field intact; anything else follows the standard error path.
 */
export function commandRefusalResponse(
  error: unknown,
): { status: number; body: Record<string, unknown> } | null {
  if (!(error instanceof Error)) return null;
  const source = error as Error & {
    status?: unknown;
    code?: unknown;
    remedy?: unknown;
    field?: unknown;
  };
  if (
    typeof source.status !== "number" ||
    !Number.isInteger(source.status) ||
    source.status < 400 ||
    source.status > 499
  ) {
    return null;
  }
  return {
    status: source.status,
    body: {
      error: error.message,
      ...(typeof source.code === "string" ? { code: source.code } : {}),
      ...(typeof source.remedy === "string" ? { remedy: source.remedy } : {}),
      ...(typeof source.field === "string" ? { field: source.field } : {}),
    },
  };
}

/**
 * The channel-location drawer leaves optional text empty as "" (notably
 * the keep-back buffer), while its descriptor treats those fields as
 * absent when empty (mirroring the CRUD coercion, and the engine reads
 * an absent buffer as zero). Other commands keep strict shape
 * validation: a blank value where content is required still fails, so
 * no other command's refusal is softened by this branch.
 */
export function normalizeChannelLocationBody(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      typeof value === "string" && value.trim() === "" ? undefined : value,
    ]),
  );
}
