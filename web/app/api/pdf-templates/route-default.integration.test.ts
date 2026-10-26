import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// One default template per (org, record type): storage refuses a second
// default, and the POST/PATCH swaps serialize under an advisory lock so concurrent
// promotions order instead of both committing. PATCH also bumps the
// revision counter every issued PDF cites.

const stateKey = Symbol.for("openbooks.pdf-template-default-test");
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
  const state = globalThis[Symbol.for('openbooks.pdf-template-default-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      ((specifier === "../../../lib/authz" || specifier === "../../../../lib/authz") &&
        context.parentURL?.includes("pdf-templates")) ||
      (specifier === "@/lib/authz" && context.parentURL?.includes("/lib/api/route"))
    ) {
      return { url: "mock:authz-template-default", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz-template-default") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const postUrl = "./route.ts?pdf-template-default-post";
const idUrl = "./[id]/route.ts?pdf-template-default-id";
const { POST } = (await import(postUrl)) as typeof import("./route.ts");
const { PATCH } = (await import(idUrl)) as typeof import("./[id]/route.ts");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
test.after(() => hooks.deregister());

async function seed(): Promise<{ orgId: string; actorId: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() =>
    createScratchUser(org.orgId, "Template Admin", "admin"),
  );
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return { orgId: org.orgId, actorId };
}

async function defaults(orgId: string): Promise<{ id: string; name: string }[]> {
  return (
    await withBypassContext(() =>
      db.execute<{ id: string; name: string }>(sql`
    select id, name from pdf_templates
     where org_id = ${orgId} and record_type = 'customer_invoice' and is_default
     order by name`),
    )
  ).rows;
}

async function revisionOf(orgId: string, id: string): Promise<number> {
  const row = (
    await withBypassContext(() =>
      db.execute<{ revision: number }>(sql`
    select revision from pdf_templates where id = ${id} and org_id = ${orgId}`),
    )
  ).rows[0];
  return row!.revision;
}

test("storage refuses a second default directly", async () => {
  const f = await seed();
  try {
    await withBypassContext(async () => {
      const backstop = await db.execute(
        sql`
          select 1 from pg_indexes where indexname = 'pdf_templates_one_default_per_kind'`,
        "objects",
      );
      assert.equal(backstop.length, 1, "the one-default backstop index must exist for this test");
      await db.execute(sql`
          insert into pdf_templates (org_id, record_type, name, is_default, source_html, compiled_html, created_by, updated_by)
          values (${f.orgId}, 'customer_invoice', 'Lone Default', true, '<p/>', '<p/>', ${f.actorId}, ${f.actorId})`);
      // The unique violation surfaces in the
      // driver's cause, not in drizzle's "Failed query" message.
      await assert.rejects(
        db.execute(sql`
            insert into pdf_templates (org_id, record_type, name, is_default, source_html, compiled_html, created_by, updated_by)
            values (${f.orgId}, 'customer_invoice', 'Second Default', true, '<p/>', '<p/>', ${f.actorId}, ${f.actorId})`),
        (e: unknown) => {
          const cur = (e as { cause?: unknown }).cause;
          const text = cur instanceof Error ? cur.message : String(e);
          assert.match(
            text,
            /duplicate key value violates unique constraint "pdf_templates_one_default_per_kind"/,
          );
          return true;
        },
      );
      assert.deepEqual(
        (await defaults(f.orgId)).map((d) => d.name),
        ["Lone Default"],
      );
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(f.orgId));
  }
});

test("POST with isDefault swaps the default instead of adding a second", async () => {
  const f = await seed();
  try {
    const post = (name: string, isDefault: boolean) =>
      withOrgContext(f.orgId, () =>
        POST(
          new Request("http://localhost/api/pdf-templates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recordType: "customer_invoice", name, isDefault }),
          }),
        ),
      );
    const first = await post("First Default", true);
    assert.equal(first.status, 200, await first.clone().text());
    const second = await post("Second Default", true);
    assert.equal(second.status, 200, await second.clone().text());

    assert.deepEqual(
      (await defaults(f.orgId)).map((d) => d.name),
      ["Second Default"],
    );
    assert.equal(await revisionOf(f.orgId, ((await second.json()) as { id: string }).id), 1);
  } finally {
    await withBypassContext(() => dropScratchOrg(f.orgId));
  }
});

test("PATCH promotion swaps the default atomically and bumps revision", async () => {
  const f = await seed();
  try {
    const post = (name: string, isDefault: boolean) =>
      withOrgContext(f.orgId, () =>
        POST(
          new Request("http://localhost/api/pdf-templates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recordType: "customer_invoice", name, isDefault }),
          }),
        ).then(async (res) => {
          assert.equal(res.status, 200, await res.clone().text());
          return ((await res.json()) as { id: string }).id;
        }),
      );
    await post("Old Default", true);
    const challenger = await post("Challenger", false);

    const promoted = await withOrgContext(f.orgId, () =>
      PATCH(
        new Request(`http://localhost/api/pdf-templates/${challenger}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isDefault: true }),
        }),
        { params: Promise.resolve({ id: challenger }) },
      ),
    );
    assert.equal(promoted.status, 200, await promoted.clone().text());

    assert.deepEqual(
      (await defaults(f.orgId)).map((d) => d.name),
      ["Challenger"],
    );
    assert.equal(await revisionOf(f.orgId, challenger), 2, "one PATCH bumps revision 1 → 2");
  } finally {
    await withBypassContext(() => dropScratchOrg(f.orgId));
  }
});
