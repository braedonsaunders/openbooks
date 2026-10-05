import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Customer billing relationships separate the service-to child from the
 * bill-to recipient and the AR payer. Overlapping windows for one child
 * are refused on the write path — never resolved arbitrarily — a group
 * naming another payer is refused before it can silently never apply, and
 * a relationship redirecting nowhere is refused as a misconfiguration.
 * Every refusal leaves the stored rows exactly as they were.
 *
 * The gate's identity half is stubbed (controllable permissions/scope);
 * every scope predicate below it is the real production code.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const fileRoot = root;
const state = {
  orgId: "",
  actorId: "",
  permissions: new Set<string>(["parties.read", "documents.manage"]),
  allowedSubsidiaryIds: null as ReadonlySet<string> | null,
};
Object.assign(globalThis, { __billingRelationshipState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation")
      return virtual("export function redirect() {}; export function notFound() {}");
    if (specifier === "next/headers")
      return virtual("export function cookies() { throw new Error('no cookies in route test') }");
    // The gate's identity half is stubbed (controllable permissions/scope);
    // every scope predicate below it — guardSubsidiaryScope, the feature
    // check, the snapshot — is the real production code. defineRoute reaches
    // the gate through @/lib/feature-gates, whose own './authz' import is
    // pinned to this same stub by parent URL so the stub cannot leak into
    // any other module's relative import.
    if (
      specifier.endsWith("/lib/authz") ||
      (specifier === "./authz" && String(context?.parentURL ?? "").endsWith("web/lib/feature-gates.ts"))
    )
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__billingRelationshipState;
          return {
            user: { orgId: s.orgId, id: s.actorId },
            permissions: new Set(s.permissions),
            allowedSubsidiaryIds: s.allowedSubsidiaryIds,
          };
        }
        export { can, guardSubsidiaryScope } from '${fileRoot}web/lib/authz.ts';
      `);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { GET, POST, PATCH, DELETE } = await import("./route.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() => db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,consolidatedBilling}', 'true'::jsonb, true)
     where id = ${org.orgId}`));
  const child = randomUUID();
  const payerA = randomUUID();
  const payerB = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${child}, ${org.orgId}, 'customer', 'Child Co', ${org.subsidiaryId}, true, '{}'::jsonb),
           (${payerA}, ${org.orgId}, 'customer', 'Parent A', ${org.subsidiaryId}, true, '{}'::jsonb),
           (${payerB}, ${org.orgId}, 'customer', 'Parent B', ${org.subsidiaryId}, true, '{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into customer_roles (org_id, party_id) values (${org.orgId}, ${child}), (${org.orgId}, ${payerA}), (${org.orgId}, ${payerB})`));
  const groupA = randomUUID();
  const groupB = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into consolidation_groups
      (id, org_id, code, name, payer_party_id, cadence, cutoff_day, grouping, is_active)
    values (${groupA}, ${org.orgId}, 'GRP-A', 'Parent A monthly', ${payerA}, 'monthly', 1, 'by_child', true),
           (${groupB}, ${org.orgId}, 'GRP-B', 'Parent B monthly', ${payerB}, 'monthly', 1, 'by_child', true)`));
  return { org, child, payerA, payerB, groupA, groupB };
}

const send = (method: (req: Request) => Promise<Response>, body: unknown, id?: string) => {
  const url = new URL("http://billing.test/api/billing-relationships");
  if (id) url.searchParams.set("id", id);
  return withOrgContext(
    state.orgId,
    () =>
      method(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        }),
      ),
  );
};

async function relationshipCount(orgId: string): Promise<number> {
  const rows = (
    await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from customer_billing_relationships where org_id = ${orgId}`),
    )
  ).rows;
  return rows[0]!.n;
}

function windowOf(orgId: string, id: string) {
  return withBypassContext(() => db.execute<{ from: string; to: string | null }>(sql`
    select effective_from::text as "from", effective_to::text as "to"
      from customer_billing_relationships where org_id = ${orgId} and id = ${id}`)).then((r) => r.rows[0]);
}

test("an overlapping create is refused with the remedy and writes nothing", { skip: !DB }, async () => {
  const { org, child, payerA, payerB } = await fixture();
  try {
    const first = await send(POST, {
      childPartyId: child, billToPartyId: payerA, payerPartyId: payerA,
      effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", consolidationGroupId: null,
    });
    assert.equal(first.status, 200, JSON.stringify(await first.json().catch(() => null)));
    const clash = await send(POST, {
      childPartyId: child, billToPartyId: payerB, payerPartyId: payerB,
      effectiveFrom: "2026-06-01", effectiveTo: null, consolidationGroupId: null,
    });
    assert.equal(clash.status, 400);
    const payload = (await clash.json()) as { errorCode?: string; error?: string };
    assert.equal(payload.errorCode, "overlap");
    assert.match(String(payload.error), /close the existing window/i);
    assert.equal(await relationshipCount(org.orgId), 1, "the refused create leaves no second window behind");
    const adjacent = await send(POST, {
      childPartyId: child, billToPartyId: payerB, payerPartyId: payerB,
      effectiveFrom: "2026-07-01", effectiveTo: null, consolidationGroupId: null,
    });
    assert.equal(adjacent.status, 200, `an adjacent window is accepted: ${JSON.stringify(await adjacent.json().catch(() => null))}`);
    assert.equal(await relationshipCount(org.orgId), 2);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("stretching a window into its neighbour is refused and moves nothing", { skip: !DB }, async () => {
  const { org, child, payerA, payerB } = await fixture();
  try {
    const first = (await (await send(POST, {
      childPartyId: child, billToPartyId: payerA, payerPartyId: payerA,
      effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30", consolidationGroupId: null,
    })).json()) as { id: string };
    const second = (await (await send(POST, {
      childPartyId: child, billToPartyId: payerB, payerPartyId: payerB,
      effectiveFrom: "2026-07-01", effectiveTo: null, consolidationGroupId: null,
    })).json()) as { id: string };
    const stretched = await send(PATCH, { id: first.id, effectiveTo: "2026-07-15" });
    assert.equal(stretched.status, 400);
    assert.equal(((await stretched.json()) as { errorCode?: string }).errorCode, "overlap");
    assert.deepEqual(await windowOf(org.orgId, first.id), { from: "2026-01-01", to: "2026-06-30" });
    assert.deepEqual(await windowOf(org.orgId, second.id), { from: "2026-07-01", to: null });
    const removed = await send(DELETE, undefined, second.id);
    assert.equal(removed.status, 200, JSON.stringify(await removed.json().catch(() => null)));
    assert.equal(await relationshipCount(org.orgId), 1, "deleting a window removes exactly that window");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a group naming another payer is refused before it can silently never apply", { skip: !DB }, async () => {
  const { org, child, payerA, groupB } = await fixture();
  try {
    // groupB bills to payerB; naming it on a payerA relationship would store
    // a group the resolver drops on every read.
    const res = await send(POST, {
      childPartyId: child, billToPartyId: payerA, payerPartyId: payerA,
      effectiveFrom: "2026-01-01", effectiveTo: null, consolidationGroupId: groupB,
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { errorCode?: string }).errorCode, "group");
    assert.equal(await relationshipCount(org.orgId), 0, "the refused create stores no inapplicable group");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a relationship redirecting nowhere is refused as a misconfiguration", { skip: !DB }, async () => {
  const { org, child } = await fixture();
  try {
    const res = await send(POST, {
      childPartyId: child, billToPartyId: child, payerPartyId: child,
      effectiveFrom: "2026-01-01", effectiveTo: null, consolidationGroupId: null,
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { errorCode?: string }).errorCode, "noRedirect");
    assert.equal(await relationshipCount(org.orgId), 0);
    const summary = await withOrgContext(state.orgId, () =>
      GET(new Request(`http://billing.test/api/billing-relationships?childPartyId=${child}`)));
    assert.equal(summary.status, 200);
    const payload = (await summary.json()) as {
      summary: { payerName: string };
      relationships: unknown[];
      canManage: boolean;
    };
    assert.equal(payload.relationships.length, 0);
    assert.equal(payload.summary.payerName, "Child Co", "with no relationship the customer bills itself");
    assert.equal(payload.canManage, true);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
