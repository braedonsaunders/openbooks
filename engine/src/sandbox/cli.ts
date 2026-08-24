/**
 * Sandbox CLI. Examples:
 *   npx tsx engine/src/sandbox/cli.ts list
 *   npx tsx engine/src/sandbox/cli.ts create "QA sandbox" --tier=masked
 *   npx tsx engine/src/sandbox/cli.ts refresh <sandboxId> [--reset]
 *   npx tsx engine/src/sandbox/cli.ts delete <sandboxId>
 *   npx tsx engine/src/sandbox/cli.ts promote <sandboxId> "My change set"
 *   npx tsx engine/src/sandbox/cli.ts apply <changeSetId>
 *
 * The production org defaults to the first org row; pass --org=<uuid> to target
 * a specific production org.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../db.ts";
import { applyChangeSet, buildChangeSet } from "./promote.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";
import { listSandboxes } from "./index.ts";
import type { SandboxTier } from "./clone.ts";

function flag(args: string[], name: string): string | undefined {
  const p = args.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}

async function firstOrg(): Promise<string> {
  const r = await db.execute<{ id: string }>(sql`select id from orgs where env_kind = 'production' order by created_at limit 1`);
  if (!r.rows[0]) throw new Error("no production org found");
  return r.rows[0].id;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const positional = rest.filter((a) => !a.startsWith("--"));
  const orgId = flag(rest, "org") ?? (await firstOrg());

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
      const tier = (flag(rest, "tier") as SandboxTier) ?? "masked";
      const masked = flag(rest, "masked") !== "false" && tier === "masked";
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
      if (!id) throw new Error("usage: promote <sandboxId> [name]");
      const { changeSetId, itemCount } = await buildChangeSet(id, name ?? "Change set");
      console.log(`✓ change set ${changeSetId} with ${itemCount} item(s). Apply with: apply ${changeSetId}`);
      break;
    }
    case "apply": {
      const id = positional[0];
      if (!id) throw new Error("usage: apply <changeSetId>");
      await applyChangeSet(id);
      console.log(`✓ applied change set ${id} to production`);
      break;
    }
    default:
      console.log("commands: list | create | refresh | delete | promote | apply");
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
