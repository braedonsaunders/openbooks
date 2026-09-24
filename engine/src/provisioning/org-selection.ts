/**
 * Shared org-resolution guards for provisioning scripts: no script may
 * silently operate on whatever org happens to sort first.
 */

/** An org row as listed for refusal messages. */
export type ListedOrg = { id: string; name: string };

/**
 * Resolve the script's target from an explicit argument, refusing (with the
 * available orgs listed) when the argument is missing or malformed. This is
 * the strict form: scripts that write tenant financial configuration take no
 * default, not even a single org.
 */
export function requireExplicitOrgId(
  arg: string | undefined,
  orgs: readonly ListedOrg[],
  scriptName: string,
): string {
  if (arg && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg)) {
    return arg;
  }
  throw new Error(
    `unknown organization ${JSON.stringify(arg ?? null)}: pass the org id (uuid) as the first argument to ${scriptName} — ` +
      (orgs.length === 0 ? "no orgs exist yet" : `available orgs: ${orgs.map((org) => `${org.name} (${org.id})`).join(", ")}`),
  );
}

/**
 * Resolve the target when the script is only ever meaningful against one
 * org (demo and rehearsal databases): exactly one org selects itself, any
 * other population refuses with the orgs listed instead of picking whatever
 * sorts first.
 */
export function selectOnlyOrg(
  orgs: readonly ListedOrg[],
  scriptName: string,
): ListedOrg {
  if (orgs.length === 1) return orgs[0]!;
  throw new Error(
    `${scriptName} runs against exactly one org but found ${orgs.length} — ` +
      (orgs.length === 0
        ? "seed an org first"
        : `pass which one explicitly; available orgs: ${orgs.map((org) => `${org.name} (${org.id})`).join(", ")}`),
  );
}
