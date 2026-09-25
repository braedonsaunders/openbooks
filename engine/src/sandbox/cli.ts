/**
 * Sandbox CLI. Examples:
 *   npx tsx engine/src/sandbox/cli.ts list
 *   npx tsx engine/src/sandbox/cli.ts create "QA sandbox" --tier=masked
 *   npx tsx engine/src/sandbox/cli.ts refresh <sandboxId> [--reset]
 *   npx tsx engine/src/sandbox/cli.ts delete <sandboxId>
 *   npx tsx engine/src/sandbox/cli.ts promote <sandboxId> "My change set" --actor=<userId>
 *   npx tsx engine/src/sandbox/cli.ts apply <changeSetId> --actor=<userId>
 *
 * The production org defaults to the first org row; pass --org=<uuid> to target
 * a specific production org.
 */
import { sql } from "drizzle-orm";
import { db, pool, withBypassContext, withOrgContext } from "../platform/db.ts";
import { applyChangeSet, buildChangeSet } from "./promote.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";
import { listSandboxes } from "./index.ts";
import { validateSandboxTier } from "./clone.ts";
import { resolveCliActor } from "./cli-actor.ts";
import { resolveCreateMasking } from "./cli-masking.ts";

function flag(args: string[], name: string): string | undefined {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}

async function firstOrg(): Promise<string> {
  const r = await withBypassContext(() => db.execute<{ id: string }>(sql`select id from orgs where env_kind = 'production' order by created_at limit 1`));
  if (!r.rows[0]) throw new Error("no production org found");
  return r.rows[0].id;
}

/** Resolve only the tenant identity here; all command work runs in that tenant. */
async function commandOrg(cmd: string | undefined, positional: string[], rest: string[]): Promise<string> {
  const suppliedOrg = flag(rest, "org");
  if (cmd === "list" || cmd === "create" || !cmd) {
    if (!suppliedOrg) return firstOrg();
    const org = await withBypassContext(() => db.execute<{ id: string }>(sql`
      select id from orgs where id = ${suppliedOrg} and env_kind = 'production'`));
    if (!org.rows[0]) throw new Error(`production org not found: ${suppliedOrg}`);
    return org.rows[0].id;
  }

  const targetId = positional[0];
  if (!targetId) {
    if (suppliedOrg) return suppliedOrg;
    return firstOrg();
  }
  const ownerId = await withBypassContext(async () => {
    if (cmd === "apply") {
      return (await db.execute<{ org_id: string }>(sql`select org_id from change_sets where id = ${targetId}`)).rows[0]?.org_id;
    }
    return (await db.execute<{ production_org_id: string }>(sql`select production_org_id from sandboxes where id = ${targetId}`)).rows[0]?.production_org_id;
  });
  if (!ownerId) throw new Error(`${cmd === "apply" ? "change set" : "sandbox"} not found: ${targetId}`);
  if (suppliedOrg && suppliedOrg !== ownerId) {
    throw new Error(`${cmd} target ${targetId} does not belong to production org ${suppliedOrg}`);
  }
  return ownerId;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const positional = rest.filter((a) => !a.startsWith("--"));
  const orgId = await commandOrg(cmd, positional, rest);

  await withOrgContext(orgId, async () => {
    switch (cmd) {
    case "list": {
      const rows = await listSandboxes(orgId);
      console.table(
        rows.map((s) => ({
          id: s.id,
          name: s.name,
          tier: s.tier,
          masked: s.masked,
          status: s.status,
          rows: s.storageRows,
          lastRefresh: s.lastRefreshAt,
        })),
      );
      break;
    }
    case "create": {
      const name = positional[0] ?? "Sandbox";
      const tier = validateSandboxTier(flag(rest, "tier") ?? "masked");
      const masked = resolveCreateMasking(tier, flag(rest, "masked"));
      console.log(`Creating ${tier} sandbox "${name}" from org ${orgId}…`);
      const t0 = Date.now();
      const { sandboxId, sandboxOrgId } = await createSandbox({
        productionOrgId: orgId,
        name,
        tier,
        masked,
        asOfPeriodId: flag(rest, "period") ?? null,
      });
      console.log(`✓ sandbox ${sandboxId} (org ${sandboxOrgId}) ready in ${Date.now() - t0}ms`);
      break;
    }
    case "refresh": {
      const id = positional[0];
      if (!id) throw new Error("usage: refresh <sandboxId> [--reset]");
      const keep = !rest.includes("--reset");
      console.log(`Refreshing ${id} (keepCustomizations=${keep})…`);
      const t0 = Date.now();
      await refreshSandbox(id, { keepCustomizations: keep });
      console.log(`✓ refreshed in ${Date.now() - t0}ms`);
      break;
    }
    case "delete": {
      const id = positional[0];
      if (!id) throw new Error("usage: delete <sandboxId>");
      await deleteSandbox(id);
      console.log(`✓ deleted ${id}`);
      break;
    }
    case "promote": {
      const [id, name] = positional;
      if (!id) throw new Error("usage: promote <sandboxId> [name] --actor=<userId>");
      const actorId = await resolveCliActor(rest);
      const { changeSetId, itemCount } = await buildChangeSet(id, name ?? "Change set", actorId);
      console.log(`✓ change set ${changeSetId} with ${itemCount} item(s). Apply with: apply ${changeSetId}`);
      break;
    }
    case "apply": {
      const id = positional[0];
      if (!id) throw new Error("usage: apply <changeSetId> --actor=<userId>");
      const actorId = await resolveCliActor(rest);
      await applyChangeSet(id, actorId);
      console.log(`✓ applied change set ${id} to production`);
      break;
    }
    default:
      console.log("commands: list | create | refresh | delete | promote | apply");
    }
  });
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
