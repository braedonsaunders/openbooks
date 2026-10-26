import { withBypassContext } from "../platform/db.ts";
import { assertDedicatedFixtureDatabase, assertFixtureDatabase } from "./fixture-database.ts";
import {
  fixtureOwnerPort,
  fixtureOwnerRequest,
  outstandingFixtureOwnerLeases,
  completedFixtureOwnerLeases,
  outstandingFixturePoolLeases,
} from "./scratch-org-owner.ts";
import {
  fixturePoolingEnabled,
  scratchOrgPoolSize,
  ScratchOrgPool,
  type ScratchOrgLifecycleMetrics,
} from "./scratch-org-pool.ts";
import { bootstrapScratchOrg, type ScratchOrg } from "./scratch-org-bootstrap.ts";
import { dropScratchOrgEscaped, listOrgIdTables } from "./tenant-teardown.ts";
import {
  dropScratchOrgAndSnapshot,
  loadOrgTableColumns,
  type OrgTableColumns,
  resetScratchOrgEscaped,
  snapshotScratchOrg,
} from "./scratch-org-snapshot.ts";

export async function releaseOutstandingScratchOrgLeases(): Promise<void> {
  const leases = fixtureOwnerPort() ? outstandingFixtureOwnerLeases : outstandingFixturePoolLeases;
  if (leases.size === 0) return;
  const failures: unknown[] = [];
  for (const orgId of [...leases]) {
    try {
      await dropScratchOrg(orgId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `scratch fixture worker could not release ${failures.length} lease(s): ${failures
        .map((error) => String(error))
        .join("; ")}`,
    );
  }
}

export function getOutstandingScratchOrgLeaseCount(): number {
  return fixtureOwnerPort()
    ? outstandingFixtureOwnerLeases.size
    : outstandingFixturePoolLeases.size;
}

/** Report teardown failures without replacing a test's existing error. */
export async function dropScratchOrgReporting(orgId: string): Promise<void> {
  try {
    await dropScratchOrg(orgId);
  } catch (error) {
    console.error(
      `scratch-org teardown failed for ${orgId} (rows may be leaked on the shared dev DB):`,
      error,
    );
    if (fixtureOwnerPort() || fixturePoolingEnabled()) throw error;
  }
}

let scratchPoolPromise: Promise<ScratchOrgPool<ScratchOrg>> | undefined;

let scratchPoolInstance: ScratchOrgPool<ScratchOrg> | undefined;

let scratchPoolTables: string[] | undefined;

let scratchPoolColumns: OrgTableColumns | undefined;

async function productionScratchPool(): Promise<ScratchOrgPool<ScratchOrg>> {
  if (!fixturePoolingEnabled()) throw new Error("scratch fixture pooling is disabled");
  await assertDedicatedFixtureDatabase();
  if (!scratchPoolPromise) {
    scratchPoolPromise = (async () => {
      scratchPoolTables = await withBypassContext(async () => [
        ...new Set([...(await listOrgIdTables()), "orgs"]),
      ]);
      scratchPoolColumns = await withBypassContext(() =>
        loadOrgTableColumns(scratchPoolTables ?? []),
      );
      const pool = new ScratchOrgPool<ScratchOrg>({
        size: scratchOrgPoolSize(),
        isolatedDatabase: true,
        store: {
          bootstrap: () =>
            withBypassContext(async () =>
              snapshotScratchOrg(await bootstrapScratchOrg(), scratchPoolTables ?? []),
            ),
          reset: (org) =>
            withBypassContext(() =>
              resetScratchOrgEscaped(org, scratchPoolTables ?? [], scratchPoolColumns ?? new Map()),
            ),
          teardown: (org) => withBypassContext(() => dropScratchOrgAndSnapshot(org)),
        },
      });
      scratchPoolInstance = pool;
      return pool;
    })();
  }
  const pool = await scratchPoolPromise;
  await pool.start();
  return pool;
}

/**
 * Postings in a fixture organization resolve the domain posting hooks, so
 * every fixture installs them. Loaded on first use, inside the test, so a
 * test's module mocks are registered before the domain modules load.
 */
async function installFixturePostingContributors(): Promise<void> {
  const { installPostingContributors } = await import("../composition/posting-contributors.ts");
  installPostingContributors();
}

/** A company consumed by native retirement cannot be a reusable pool slot. */
export async function createRetirementFixtureOrg(): Promise<ScratchOrg> {
  await assertFixtureDatabase();
  const org = await bootstrapScratchOrg();
  await installFixturePostingContributors();
  return org;
}

/** Create a pooled lease in CI, or a standalone fixture when pooling is disabled. */
export async function createScratchOrg(): Promise<ScratchOrg> {
  const org = await leaseScratchOrg();
  await installFixturePostingContributors();
  return org;
}

async function leaseScratchOrg(): Promise<ScratchOrg> {
  if (fixtureOwnerPort()) {
    const response = await fixtureOwnerRequest<{ org: ScratchOrg }>({ op: "lease" });
    outstandingFixtureOwnerLeases.add(response.org.orgId);
    completedFixtureOwnerLeases.delete(response.org.orgId);
    return response.org;
  }
  if (!fixturePoolingEnabled()) {
    await assertFixtureDatabase();
    return bootstrapScratchOrg();
  }
  const org = await (await productionScratchPool()).lease();
  outstandingFixturePoolLeases.add(org.orgId);
  return org;
}

/** Release a pooled lease; manually seeded scratch orgs still use full teardown. */
export async function dropScratchOrg(orgId: string): Promise<void> {
  if (fixtureOwnerPort()) {
    // Releasing a known completed lease is idempotent; unknown ids still reach the owner.
    if (!outstandingFixtureOwnerLeases.has(orgId) && completedFixtureOwnerLeases.has(orgId)) return;
    await fixtureOwnerRequest<{ ok: true }>({ op: "release", orgId });
    outstandingFixtureOwnerLeases.delete(orgId);
    completedFixtureOwnerLeases.add(orgId);
    return;
  }
  await assertFixtureDatabase();
  if (!fixturePoolingEnabled()) return withBypassContext(() => dropScratchOrgEscaped(orgId));
  const pool = await productionScratchPool();
  if (pool.has(orgId)) {
    await pool.release(orgId);
    outstandingFixturePoolLeases.delete(orgId);
    return;
  }
  return withBypassContext(() => dropScratchOrgEscaped(orgId));
}

export function getScratchOrgLifecycleMetrics(): ScratchOrgLifecycleMetrics {
  return (
    scratchPoolInstance?.metrics ?? {
      poolSize: scratchOrgPoolSize(),
      fullBootstrap: 0,
      leases: 0,
      releases: 0,
      resets: 0,
      fullTeardown: 0,
      schemaWideVerification: 0,
      activeLeases: 0,
      leakDetections: 0,
    }
  );
}

export async function closeScratchOrgPool(): Promise<void> {
  if (fixtureOwnerPort()) return;
  if (!scratchPoolPromise) return;
  const pool = await scratchPoolPromise;
  await pool.close();
}
