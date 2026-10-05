import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// POST /api/v1/customers/upsert — match by id, external reference, email,
// or unambiguous name; anything ambiguous is refused naming the remedy.
const { db, withBypassContext, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { generateApiKey } = await import("../../../../lib/api-auth.ts");
const { POST } = await import("./upsert/route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

interface Setup {
  orgId: string;
  key: string;
}

async function setup(): Promise<Setup> {
  const org = await withBypassContext(() => createScratchOrg());
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"apiAccess":true}'::jsonb)
    where id = ${org.orgId}`));
  const actor = await withBypassContext(() => createScratchUser(org.orgId, "Api", "api_owner"));
  await withBypassContext(() => db.execute(sql`
    update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'api_owner'`));
  const generated = generateApiKey();
  await withBypassContext(() => db.execute(sql`
    insert into api_keys (org_id, user_id, name, key_prefix, key_hash, key_preview, scopes, is_active)
    values (${org.orgId}, ${actor}, 'upsert test', ${generated.keyPrefix}, ${generated.keyHash},
            ${generated.keyPreview}, '["parties.manage","parties.read"]'::jsonb, true)`));
  return { orgId: org.orgId, key: generated.plaintext };
}

async function callUpsert(
  setup: Setup,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await withOrgContext(
    setup.orgId,
    () =>
      POST(
        new Request("http://openbooks.test/api/v1/customers/upsert", {
          method: "POST",
          headers: {
            authorization: `Bearer ${setup.key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      ),
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function partyRow(orgId: string, id: string) {
  return (await withBypassContext(() => db.execute<Record<string, unknown>>(sql`
    select id, display_name, email, custom from parties where id = ${id} and org_id = ${orgId}`))).rows[0];
}

async function seedParty(orgId: string, name: string, email: string | null): Promise<string> {
  const id = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into parties (id, org_id, kind, display_name, email, is_active)
    values (${id}, ${orgId}, 'company', ${name}, ${email}, true)`));
  return id;
}

test("upsert creates by email with an address, then matches", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const email = `store-${randomUUID().slice(0, 8)}@example.com`;
    const created = await callUpsert(fixture, {
      email,
      name: "Storefront Customer",
      phone: "555-0100",
      address: { line1: "1 Market St", city: "Springfield", region: "IL", postalCode: "62701", country: "US" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.created, true);
    const id = String(created.json.id);
    const stored = await partyRow(fixture.orgId, id);
    assert.equal(stored?.email, email);
    const role = (await withBypassContext(() => db.execute<{ n: string }>(sql`
      select count(*)::text as n from customer_roles where org_id = ${fixture.orgId} and party_id = ${id}`))).rows[0]!.n;
    assert.equal(role, "1");
    const address = (await withBypassContext(() => db.execute<{ line1: string | null; country: string | null }>(sql`
      select line1, country from addresses
       where org_id = ${fixture.orgId} and party_id = ${id} and is_default_billing`))).rows[0];
    assert.equal(address?.line1, "1 Market St");
    assert.equal(address?.country, "US");

    // Repeating the same email revises instead of duplicating.
    const matched = await callUpsert(fixture, { email, name: "Storefront Customer Inc." });
    assert.equal(matched.status, 200, JSON.stringify(matched.json));
    assert.equal(matched.json.created, false);
    assert.equal(matched.json.id, id);
    assert.equal((await partyRow(fixture.orgId, id))?.display_name, "Storefront Customer Inc.");
    const addressCount = (await withBypassContext(() => db.execute<{ n: string }>(sql`
      select count(*)::text as n from addresses where org_id = ${fixture.orgId} and party_id = ${id}`))).rows[0]!.n;
    assert.equal(addressCount, "1");
  } finally {
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});

test("upsert round-trips an external reference", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const ref = `CUST-${randomUUID().slice(0, 8)}`;
    const created = await callUpsert(fixture, {
      externalRef: ref,
      externalSource: "shopify",
      email: `shop-${randomUUID().slice(0, 8)}@example.com`,
      name: "Shopify Buyer",
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = String(created.json.id);
    const stored = (await partyRow(fixture.orgId, id)) as {
      custom: { source?: { system?: string; externalId?: string } };
    };
    assert.equal(stored.custom.source?.system, "shopify");
    assert.equal(stored.custom.source?.externalId, ref);

    // The reference wins over a changed email.
    const matched = await callUpsert(fixture, {
      externalRef: ref,
      externalSource: "shopify",
      email: `changed-${randomUUID().slice(0, 8)}@example.com`,
    });
    assert.equal(matched.status, 200, JSON.stringify(matched.json));
    assert.equal(matched.json.id, id);
  } finally {
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});

test("upsert refuses ambiguous matches by name and email", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const name = `Dup ${randomUUID().slice(0, 8)}`;
    await seedParty(fixture.orgId, name, null);
    await seedParty(fixture.orgId, name, null);
    const byName = await callUpsert(fixture, { name });
    assert.equal(byName.status, 409, JSON.stringify(byName.json));
    assert.match(String(byName.json.message), /match by email or externalRef instead/);

    const email = `dup-${randomUUID().slice(0, 8)}@example.com`;
    await seedParty(fixture.orgId, `First ${email}`, email);
    await seedParty(fixture.orgId, `Second ${email}`, email);
    const byEmail = await callUpsert(fixture, { email });
    assert.equal(byEmail.status, 409, JSON.stringify(byEmail.json));
    assert.match(String(byEmail.json.message), /match by externalRef instead/);
  } finally {
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});

test("upsert refuses a half external pair and an unknown id", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const half = await callUpsert(fixture, { externalRef: "LONE", name: "Lone Ref" });
    assert.equal(half.status, 422, JSON.stringify(half.json));
    assert.match(String(half.json.message), /travel together/);

    const missing = await callUpsert(fixture, { id: randomUUID() });
    assert.equal(missing.status, 422, JSON.stringify(missing.json));
    assert.match(String(missing.json.message), /not found in this organization/);
  } finally {
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});
