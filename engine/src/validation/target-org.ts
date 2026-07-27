/**
 * Which org a remediation harness is allowed to write to.
 *
 * These harnesses default to a sandbox because a mistake there costs nothing.
 * Running one against a live tenant is sometimes exactly right — a defect proven
 * in the sandbox has changed nothing for the people actually using the product
 * until it is carried across — but it must be a decision someone made on purpose,
 * not something that happens because an environment variable was already set.
 *
 * So production requires BOTH an explicit --production flag and the org id, and
 * the harness announces what it is about to touch before it touches it.
 */
import { sql } from "drizzle-orm";
import { db } from "../db.ts";

export interface TargetOrg {
  id: string;
  name: string;
  envKind: string;
  isProduction: boolean;
}

async function retry<T>(fn: () => Promise<T>, n = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: any = e; c; c = c.cause) chain.push(String(c?.message ?? ""));
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(chain.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

/**
 * Resolve and authorise the target. Throws unless the org is a sandbox or the
 * caller passed --production, so the default stays safe and the exception is
 * visible in the command that was actually run.
 */
export async function resolveTargetOrg(orgId: string, argv: string[] = process.argv): Promise<TargetOrg> {
  const row = ((await retry(() => db.execute(sql`
    select id, name, env_kind from orgs where id = ${orgId}`))) as any).rows[0];
  if (!row) throw new Error(`no such org: ${orgId}`);

  const target: TargetOrg = {
    id: String(row.id),
    name: String(row.name),
    envKind: String(row.env_kind),
    isProduction: String(row.env_kind) !== "sandbox",
  };
  if (target.isProduction && !argv.includes("--production")) {
    throw new Error(
      `refusing: ${target.name} is ${target.envKind}, not a sandbox. ` +
      `Pass --production to write to a live tenant on purpose.`,
    );
  }
  console.log(
    target.isProduction
      ? `TARGET: ${target.name} — LIVE ${target.envKind.toUpperCase()} TENANT`
      : `target: ${target.name} (${target.envKind})`,
  );
  return target;
}
