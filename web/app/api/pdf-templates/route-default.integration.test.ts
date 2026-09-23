import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";

// One default template per (org, record type): migration 0277 refuses
// pre-existing duplicates BY NAME, storage refuses a second default, and
// the POST/PATCH swaps serialize under an advisory lock so concurrent
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
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { resolvePdfTemplate } = await import("../../../lib/pdf-templates/store");

const MIGRATION_PATH = join(process.cwd(), "schema/migrations/generated/0277_pdf_template_default_and_revision.sql");

async function runMigrationBody(): Promise<void> {
  // The shipped bytes verbatim, minus the runner-owned SET header (those
  // session GUCs would leak onto this pooled test connection).
  const body = readFileSync(MIGRATION_PATH, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("SET "))
    .join("\n");
  assert.match(body, /0277_pdf_template_default_and_revision/, "migration file must be the shipped artifact");
  await db.execute(sql.raw(body));
}

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

async function defaults(orgId: string): Promise<{ id: string; name: string }[]> {
  return (await withBypassContext(() => db.execute<{ id: string; name: string }>(sql`
    select id, name from pdf_templates
     where org_id = ${orgId} and record_type = 'customer_invoice' and is_default
     order by name`))).rows;
}

async function revisionOf(orgId: string, id: string): Promise<number> {
  const row = (await withBypassContext(() => db.execute<{ revision: number }>(sql`
    select revision from pdf_templates where id = ${id} and org_id = ${orgId}`))).rows[0];
  return row!.revision;
}

test(
  "0277 resolves duplicate defaults to the template the resolver already returns, with audit",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    try {
      await withBypassContext(async () => {
        // Simulate the pre-0277 world: the backstop index away, two ACTIVE
        // defaults in. The print resolver returns the lowest-named one.
        await db.execute(sql`DROP INDEX IF EXISTS pdf_templates_one_default_per_kind`);
        const ids = await db.execute<{ id: string }>(sql`
          insert into pdf_templates (org_id, record_type, name, is_default, is_active, source_html, compiled_html, created_by, updated_by)
          values (${f.orgId}, 'customer_invoice', 'Alpha Default', true, true, '<p>Alpha</p>', '<p>Alpha</p>', ${f.actorId}, ${f.actorId}),
                 (${f.orgId}, 'customer_invoice', 'Beta Default', true, true, '<p>Beta</p>', '<p>Beta</p>', ${f.actorId}, ${f.actorId})
          returning id`);
        const betaId = ids.rows[1]!.id;
        const before = await resolvePdfTemplate(f.orgId, "customer_invoice", null);
        assert.equal(before?.compiledHtml, "<p>Alpha</p>", "the resolver returns the lowest-named default today");

        await runMigrationBody();
        await runMigrationBody();

        // The kept default is the one the resolver returned pre-migration…
        assert.deepEqual((await defaults(f.orgId)).map((d) => d.name), ["Alpha Default"]);
        const after = await resolvePdfTemplate(f.orgId, "customer_invoice", null);
        assert.deepEqual(after?.compiledHtml, before?.compiledHtml, "the upgrade changes no printed design");
        // …and the demotion leaves one immutable audit row naming 0277.
        const audits = (await db.execute<{ action: string; changes: unknown; actor_id: string | null }>(sql`
          select action, changes, actor_id from audit_log
           where org_id = ${f.orgId} and table_name = 'pdf_templates' and row_id = ${betaId}`)).rows;
        assert.equal(audits.length, 1, "one demotion event per demoted template");
        assert.equal(audits[0]!.action, "update");
        assert.equal(audits[0]!.actor_id, null);
        const changes = audits[0]!.changes as { before: { is_default: boolean }; after: { is_default: boolean }; reason: string };
        assert.equal(changes.before.is_default, true);
        assert.equal(changes.after.is_default, false);
        assert.match(changes.reason, /0277/);
        assert.match(changes.reason, /Alpha Default/);
        const index = (await db.execute(sql`
          select 1 from pg_indexes where indexname = 'pdf_templates_one_default_per_kind'`)).rows;
        assert.equal(index.length, 1, "the backstop index exists after the upgrade");
      });
    } finally {
      await withBypassContext(() => dropScratchOrg(f.orgId));
    }
  },
);

test(
  "0277 keeps the lowest-named default when no default is active",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    try {
      await withBypassContext(async () => {
        // Inactive duplicates: the resolver returns null today, but storage
        // still needs exactly one default for the backstop index.
        await db.execute(sql`DROP INDEX IF EXISTS pdf_templates_one_default_per_kind`);
        await db.execute(sql`
          insert into pdf_templates (org_id, record_type, name, is_default, is_active, source_html, compiled_html, created_by, updated_by)
          values (${f.orgId}, 'customer_invoice', 'Gamma Default', true, false, '<p/>', '<p/>', ${f.actorId}, ${f.actorId}),
                 (${f.orgId}, 'customer_invoice', 'Delta Default', true, false, '<p/>', '<p/>', ${f.actorId}, ${f.actorId})`);

        await runMigrationBody();

        assert.deepEqual((await defaults(f.orgId)).map((d) => d.name), ["Delta Default"]);
      });
    } finally {
      await withBypassContext(() => dropScratchOrg(f.orgId));
    }
  },
);

test(
  "storage refuses a second default directly",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    try {
      await withBypassContext(async () => {
        const backstop = (await db.execute(sql`
          select 1 from pg_indexes where indexname = 'pdf_templates_one_default_per_kind'`)).rows;
        assert.equal(backstop.length, 1, "the 0277 backstop index must exist for this test");
        await db.execute(sql`
          insert into pdf_templates (org_id, record_type, name, is_default, source_html, compiled_html, created_by, updated_by)
          values (${f.orgId}, 'customer_invoice', 'Lone Default', true, '<p/>', '<p/>', ${f.actorId}, ${f.actorId})`);
        // Same wrapper caveat as above: the unique violation surfaces in the
        // driver's cause, not in drizzle's "Failed query" message.
        await assert.rejects(
          db.execute(sql`
            insert into pdf_templates (org_id, record_type, name, is_default, source_html, compiled_html, created_by, updated_by)
            values (${f.orgId}, 'customer_invoice', 'Second Default', true, '<p/>', '<p/>', ${f.actorId}, ${f.actorId})`),
          (e: unknown) => {
            const cur = (e as { cause?: unknown }).cause;
            const text = cur instanceof Error ? cur.message : String(e);
            assert.match(text, /duplicate key value violates unique constraint "pdf_templates_one_default_per_kind"/);
            return true;
          },
        );
        assert.deepEqual((await defaults(f.orgId)).map((d) => d.name), ["Lone Default"]);
      });
    } finally {
      await withBypassContext(() => dropScratchOrg(f.orgId));
    }
  },
);

test(
  "POST with isDefault swaps the default instead of adding a second",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
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

      assert.deepEqual((await defaults(f.orgId)).map((d) => d.name), ["Second Default"]);
      assert.equal(await revisionOf(f.orgId, ((await second.json()) as { id: string }).id), 1);
    } finally {
      await withBypassContext(() => dropScratchOrg(f.orgId));
    }
  },
);

test(
  "PATCH promotion swaps the default atomically and bumps revision",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
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

      assert.deepEqual((await defaults(f.orgId)).map((d) => d.name), ["Challenger"]);
      assert.equal(await revisionOf(f.orgId, challenger), 2, "one PATCH bumps revision 1 → 2");
    } finally {
      await withBypassContext(() => dropScratchOrg(f.orgId));
    }
  },
);
