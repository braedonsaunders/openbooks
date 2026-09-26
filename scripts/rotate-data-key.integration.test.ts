import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../engine/src/platform/db.ts";
import { describeSealedBlob, sealSecret } from "../engine/src/platform/secrets.ts";
import { createScratchOrg, dropScratchOrg } from "../engine/src/testing/fixtures.ts";
import { planReseal, rotateDataKey, rotateOrgSettings } from "./rotate-data-key.ts";

const K1_HEX = "01".repeat(32);
const K2_HEX = "02".repeat(32);
const K1_B64 = Buffer.from(K1_HEX, "hex").toString("base64");
const K2_B64 = Buffer.from(K2_HEX, "hex").toString("base64");

const DB = !!process.env.OPENBOOKS_DB_URL;
const savedEnv = {
  OPENBOOKS_DATA_KEY: process.env.OPENBOOKS_DATA_KEY,
  OPENBOOKS_DATA_KEYS: process.env.OPENBOOKS_DATA_KEYS,
  OPENBOOKS_DATA_KEY_ACTIVE: process.env.OPENBOOKS_DATA_KEY_ACTIVE,
};

function useSingleKey(hex: string): void {
  delete process.env.OPENBOOKS_DATA_KEYS;
  delete process.env.OPENBOOKS_DATA_KEY_ACTIVE;
  process.env.OPENBOOKS_DATA_KEY = hex;
}

function useRing(active: string): void {
  delete process.env.OPENBOOKS_DATA_KEY;
  process.env.OPENBOOKS_DATA_KEYS = `k1=${K1_B64},k2=${K2_B64}`;
  process.env.OPENBOOKS_DATA_KEY_ACTIVE = active;
}

before(() => {
  useSingleKey(K1_HEX);
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("planReseal skips empty, keeps current, rotates stale, refuses garbage", () => {
  const scope = { orgId: "org-1", purpose: "connection.secrets" };
  assert.equal(planReseal(null, scope, "k1", "here"), null);
  useRing("k2");
  const rotated = planReseal(sealSecret("v", scope), scope, "k1", "here");
  assert.ok(rotated?.changed, "a k1 blob is stale once k2 is active");
  const current = planReseal(rotated!.sealed, scope, "k2", "here");
  assert.equal(current?.changed, false, "a k2 blob verifies untouched");
  assert.throws(() => planReseal("not-a-blob", scope, "k2", "here"), /not-a-blob|cannot unseal/);
  useSingleKey(K1_HEX);
});

test("rotateOrgSettings re-seals AI keys under the active key", () => {
  const scope = { orgId: "org-1", purpose: "assistant.ai.key" };
  useSingleKey(K1_HEX);
  const stale = sealSecret("ai-key", scope);
  useRing("k2");
  const { settings, changed } = rotateOrgSettings("org-1", { ai: { keyEncrypted: stale } }, "k2");
  assert.equal(changed, true);
  assert.deepEqual(describeSealedBlob((settings.ai as { keyEncrypted: string }).keyEncrypted), { version: "v2", keyId: "k2" });
  useSingleKey(K1_HEX);
});

test("dry run probes every row and --apply re-seals under the active key", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    useSingleKey(K1_HEX);
    const stale = sealSecret("conn-secret", { orgId: org.orgId, purpose: "connection.secrets" });
    await db.execute(sql`
      insert into connections (org_id, source, display_name, status, auth_kind, secrets)
      values (${org.orgId}, 'qbd', 'rotation probe', 'active', 'token', ${stale})`);
    useRing("k2");
    const probe = await rotateDataKey({ apply: false, org: org.orgId });
    const connections = probe.find((r) => r.table === "connections")!;
    assert.equal(connections.resealed, 1, "dry run must report the stale blob");
    const stillStale = await db.execute<{ secrets: string }>(sql`
      select secrets from connections where org_id = ${org.orgId}`);
    assert.equal(stillStale.rows[0]!.secrets, stale, "dry run writes nothing");
    const applied = await rotateDataKey({ apply: true, org: org.orgId });
    assert.equal(applied.find((r) => r.table === "connections")!.resealed, 1);
    const after = await db.execute<{ secrets: string }>(sql`
      select secrets from connections where org_id = ${org.orgId}`);
    assert.deepEqual(describeSealedBlob(after.rows[0]!.secrets), { version: "v2", keyId: "k2" });
  } finally {
    useSingleKey(K1_HEX);
    await dropScratchOrg(org.orgId);
  }
});
