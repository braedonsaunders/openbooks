import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../testing/fixtures.ts";
import {
  createJobFamily,
  createJobLevel,
} from "./architecture.ts";
import {
  createPayBand,
  listPayBands,
} from "./bands.ts";

/**
 * H-PAYBANDS regression: pay-band reads and writes ignored the actor's
 * subsidiary lens. listPayBands demanded hrm.compensation.read only, so an
 * A-scoped reader received every band's min/target/max org-wide — B's pay
 * architecture through a read grant alone. createPayBand demanded
 * hrm.compensation.manage only, so the same actor inserted an
 * effective-dated salary band for B (or org-wide) at will.
 *
 * Reads now fence on the persisted employer_subsidiary_id (org-wide null
 * bands stay readable as shared architecture — only their writes need
 * unrestricted scope); writes validate the declared anchor inside the
 * write transaction (B-anchored refuses uniformly not-visible, org-wide
 * refuses by name with the org-wide remedy). Proofs are read back
 * through the service, never from its internals.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function scopeRole(orgId: string, roleKey: string, permissions: string[], subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function refusalOf(promise: Promise<unknown>): Promise<{ name: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    return { name: (e as Error).name, message: (e as Error).message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

test("H-PAYBANDS: band reads fence B-anchored figures to the actor's lens", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const hrId = await createScratchUser(org.orgId, "Band HR", "paybands_hr");
    await grantPermissions(org.orgId, hrId, ["hrm.compensation.read", "hrm.compensation.manage"]);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const family = await createJobFamily({ orgId: org.orgId, actorId: hrId, code: "ENG", name: "Engineering" });
    const level = await createJobLevel({
      orgId: org.orgId, actorId: hrId, familyId: family.id, code: "IC3", name: "Engineer III", rank: 3,
      equalValueCriteria: [{ criterion: "skills", weight: "3" }],
    });
    const bandFor = (employerSubsidiaryId: string | null, min: string) =>
      createPayBand({
        orgId: org.orgId, actorId: hrId,
        scope: { familyId: family.id, levelId: level.id, employerSubsidiaryId, locationId: null },
        currency: "CAD", basis: "annual", min, target: "100000", max: "120000",
        effectiveFrom: "2020-01-01", reason: "H-PAYBANDS seed",
      });
    const bandA = await bandFor(org.subsidiaryId, "80000");
    const bandB = await bandFor(subB, "81000");
    const bandOrg = await bandFor(null, "82000");

    const managerA = await createScratchUser(org.orgId, "Band Manager A", "paybands_mgr_a");
    await scopeRole(org.orgId, "paybands_mgr_a", ["hrm.compensation.read", "hrm.compensation.manage"], [org.subsidiaryId]);

    // The unrestricted reader sees every band with its figures.
    const full = await listPayBands({ orgId: org.orgId, actorId: hrId, asOf: "2024-06-01" });
    assert.ok(full.some((b) => b.id === bandA.id));
    assert.ok(full.some((b) => b.id === bandB.id));
    assert.ok(full.some((b) => b.id === bandOrg.id));

    // The A-scoped reader sees A's band and the shared org-wide band —
    // B's min/target/max are not observable through a read grant alone.
    const scoped = await listPayBands({ orgId: org.orgId, actorId: managerA, asOf: "2024-06-01" });
    assert.ok(scoped.some((b) => b.id === bandA.id), "A-anchored band stays visible");
    assert.ok(scoped.some((b) => b.id === bandOrg.id), "org-wide band stays readable");
    assert.ok(!scoped.some((b) => b.id === bandB.id), "B-anchored band is hidden");
    assert.ok(!scoped.some((b) => b.min === "81000"), "B's figures leak through no row");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("H-PAYBANDS: band writes validate the declared employer anchor", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const hrId = await createScratchUser(org.orgId, "Band HR", "paybandsw_hr");
    await grantPermissions(org.orgId, hrId, ["hrm.compensation.read", "hrm.compensation.manage"]);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const family = await createJobFamily({ orgId: org.orgId, actorId: hrId, code: "ENG", name: "Engineering" });
    const level = await createJobLevel({
      orgId: org.orgId, actorId: hrId, familyId: family.id, code: "IC3", name: "Engineer III", rank: 3,
      equalValueCriteria: [{ criterion: "skills", weight: "3" }],
    });
    const managerA = await createScratchUser(org.orgId, "Band Manager A", "paybandsw_mgr_a");
    await scopeRole(org.orgId, "paybandsw_mgr_a", ["hrm.compensation.manage"], [org.subsidiaryId]);
    const attempt = (employerSubsidiaryId: string | null) =>
      createPayBand({
        orgId: org.orgId, actorId: managerA,
        scope: { familyId: family.id, levelId: level.id, employerSubsidiaryId, locationId: null },
        currency: "CAD", basis: "annual", min: "80000", target: "100000", max: "120000",
        effectiveFrom: "2020-01-01", reason: "H-PAYBANDS probe",
      });

    // A B-anchored band refuses exactly like a fabricated subsidiary id:
    // the refusal can never confirm B exists.
    const foreign = await refusalOf(attempt(subB));
    const fabricated = await refusalOf(attempt(randomUUID()));
    assert.deepEqual(foreign, fabricated);
    assert.match(foreign.message, /not visible in this organization and legal-entity scope/);

    // An org-wide band prices every entity at once: the refusal names the
    // remedy (an administrator with organization-wide scope), and the
    // remedy exists.
    const orgWide = await refusalOf(attempt(null));
    assert.match(orgWide.message, /across legal entities/);
    assert.match(orgWide.message, /organization-wide scope/);

    // The in-scope anchor still stores.
    const stored = await attempt(org.subsidiaryId);
    assert.ok(stored.id);
    assert.equal(stored.employerSubsidiaryId, org.subsidiaryId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
