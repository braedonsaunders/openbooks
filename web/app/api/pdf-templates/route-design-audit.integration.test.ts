import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";

// Template design changes must leave before/after evidence: POST writes the
// created row as {after}, PATCH writes {before, after} of the design it
// mutates, DELETE writes the removed design as {before}. A bare {name} (the
// old shape) cannot show what a save changed.

const stateKey = Symbol.for("openbooks.pdf-template-design-audit-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.pdf-template-design-audit-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      const base = join(process.cwd(), "web", specifier.slice(2));
      const hit = [".ts", ".tsx", "/index.ts"]
        .map((suffix) => base + suffix)
        .find((candidate) => existsSync(candidate));
      if (hit) return { shortCircuit: true, url: pathToFileURL(hit).href };
    }
    if (
      (specifier === "../../../lib/authz" || specifier === "../../../../lib/authz") &&
      context.parentURL?.includes("pdf-templates")
    ) {
      return { url: "mock:authz-design-audit", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz-design-audit") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { POST } = (await import("./route.ts?pdf-template-design-audit-post")) as typeof import("./route.ts");
const { PATCH, DELETE } = (await import("./[id]/route.ts?pdf-template-design-audit-id")) as typeof import("./[id]/route.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

async function seed(): Promise<{ orgId: string; actorId: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Template Admin", "admin"));
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return { orgId: org.orgId, actorId };
}

async function auditEvents(orgId: string, rowId: string) {
  return (await withBypassContext(() => db.execute<{ action: string; changes: unknown; actor_id: string }>(sql`
    select action, changes, actor_id from audit_log
     where org_id = ${orgId} and table_name = 'pdf_templates' and row_id = ${rowId}
     order by at, id
  `))).rows;
}

test(
  "POST writes the created design as insert {after} evidence",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    try {
      const res = await withOrgContext(f.orgId, () =>
        POST(
          new Request("http://localhost/api/pdf-templates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recordType: "customer_invoice", name: "Audited Create" }),
          }),
        ),
      );
      assert.equal(res.status, 200, await res.clone().text());
      const created = (await res.json()) as { id: string };

      const events = await auditEvents(f.orgId, created.id);
      assert.equal(events.length, 1, "one insert event per created template");
      assert.equal(events[0]!.action, "insert");
      assert.equal(events[0]!.actor_id, f.actorId);
      const changes = events[0]!.changes as { after: { name: string; record_type: string; source_html: string } };
      assert.equal(changes.after.name, "Audited Create");
      assert.equal(changes.after.record_type, "customer_invoice");
      assert.ok(changes.after.source_html.length > 0, "the after-image carries the design, not just its name");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.orgId));
    }
  },
);

test(
  "PATCH writes {before, after} showing what the save changed",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    try {
      const created = await withOrgContext(f.orgId, () =>
        POST(
          new Request("http://localhost/api/pdf-templates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recordType: "customer_invoice", name: "Before Name" }),
          }),
        ).then(async (res) => {
          assert.equal(res.status, 200, await res.clone().text());
          return ((await res.json()) as { id: string }).id;
        }),
      );
      const patched = await withOrgContext(f.orgId, () =>
        PATCH(
          new Request(`http://localhost/api/pdf-templates/${created}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "After Name" }),
          }),
          { params: Promise.resolve({ id: created }) },
        ),
      );
      assert.equal(patched.status, 200, await patched.clone().text());

      const events = await auditEvents(f.orgId, created);
      assert.equal(events.length, 2, "insert plus one update event");
      const update = events[1]!;
      assert.equal(update.action, "update");
      assert.equal(update.actor_id, f.actorId);
      const changes = update.changes as { before: { name: string }; after: { name: string } };
      assert.equal(changes.before.name, "Before Name");
      assert.equal(changes.after.name, "After Name");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.orgId));
    }
  },
);

test(
  "DELETE writes the removed design as delete {before} evidence",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    try {
      const created = await withOrgContext(f.orgId, () =>
        POST(
          new Request("http://localhost/api/pdf-templates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recordType: "customer_invoice", name: "Doomed Design" }),
          }),
        ).then(async (res) => {
          assert.equal(res.status, 200, await res.clone().text());
          return ((await res.json()) as { id: string }).id;
        }),
      );
      const deleted = await withOrgContext(f.orgId, () =>
        DELETE(
          new Request(`http://localhost/api/pdf-templates/${created}`, { method: "DELETE" }),
          { params: Promise.resolve({ id: created }) },
        ),
      );
      assert.equal(deleted.status, 200, await deleted.clone().text());

      const events = await auditEvents(f.orgId, created);
      assert.equal(events.length, 2, "insert plus one delete event");
      const removal = events[1]!;
      assert.equal(removal.action, "delete");
      assert.equal(removal.actor_id, f.actorId);
      const changes = removal.changes as { before: { name: string; record_type: string } };
      assert.equal(changes.before.name, "Doomed Design");
      assert.equal(changes.before.record_type, "customer_invoice");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.orgId));
    }
  },
);
