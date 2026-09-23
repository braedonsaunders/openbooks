import "server-only";
import { can, type Authz } from "../authz";

/**
 * Whole-company forensics gate — the single predicate every Sentinel
 * boundary shares (page loader, API drill routes, service reader and the
 * assistant tool).
 *
 * Forensics includes cross-entity baselines, identity matches and retained
 * administrative audit snapshots. Partial access cannot be represented by
 * silently dropping evidence or returning zero-risk counts, so anything less
 * than unrestricted `reports.read` + `admin.audit.read` is refused outright.
 *
 * Returns null when access may proceed, otherwise the missing requirement's
 * name. Each boundary maps the name to its own refusal shape (redirect,
 * 403 JSON, thrown ForbiddenError, tool error).
 */
export function sentinelAccessDenied(authz: Authz): string | null {
  if (!can(authz, "reports.read")) return "reports.read";
  if (!can(authz, "admin.audit.read")) return "admin.audit.read";
  if (authz.allowedSubsidiaryIds !== null) return "unrestricted subsidiary access";
  return null;
}
