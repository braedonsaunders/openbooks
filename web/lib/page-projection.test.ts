import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { Authz } from "./authz";
import { resolveAppModule } from "./test-module-hooks";

const root = pathToFileURL(process.cwd() + "/").href;
const state = { authz: null as Authz | null, builds: 0 };
Object.assign(globalThis, { __pageProjection: state });
delete process.env.OPENBOOKS_REDIS_URL;
const stub = (source: string) => ({
  shortCircuit: true,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(s, c, next) {
    if (s === "next-intl/server")
      return stub(
        'export async function getLocale(){return "en"}export async function getTranslations(){return (key)=>key}',
      );
    if (!c.parentURL?.endsWith("/page-projection.ts"))
      return resolveAppModule(s, c, next, root) ?? next(s, c);
    if (s === "@openbooks/engine/platform/business-date/module")
      return stub('export async function businessToday(){return "2026-10-26"}');
    if (s === "./authz")
      return stub("export async function getAuthz(){return globalThis.__pageProjection.authz}");
    if (s === "../app/(app)/ar/view")
      return stub(
        "export async function loadArCockpit(){const s=globalThis.__pageProjection;s.builds+=1;return {builds:s.builds}}",
      );
    return resolveAppModule(s, c, next, root) ?? next(s, c);
  },
});

const { projectedPage, rebuildProjectedPage } = await import("./page-projection.ts");

function viewer(id: string, scope: string[] | null): Authz {
  return {
    user: {
      id,
      orgId: "org-1",
      name: "Viewer",
      email: `${id}@example.com`,
      roles: [],
      envKind: "production",
    },
    permissions: new Set(["ar.read"]),
    allowedSubsidiaryIds: scope === null ? null : new Set(scope),
  } as unknown as Authz;
}

test("a cockpit projection is kept per viewer and per subsidiary scope", async () => {
  state.authz = viewer("user-a", null);
  const first = await projectedPage("ar", {});
  const again = await projectedPage("ar", { tab: "ignored" });
  assert.deepEqual(first.data, { builds: 1 });
  assert.deepEqual(again.data, { builds: 1 }, "the repeat visit answers from the kept projection");
  state.authz = viewer("user-a", ["sub-1"]);
  assert.deepEqual(
    (await projectedPage("ar", {})).data,
    { builds: 2 },
    "a narrower scope never reads the wider projection",
  );
  state.authz = viewer("user-b", null);
  assert.deepEqual(
    (await projectedPage("ar", {})).data,
    { builds: 3 },
    "another viewer builds their own",
  );
  await rebuildProjectedPage("ar", {});
  assert.deepEqual(
    (await projectedPage("ar", {})).data,
    { builds: 4 },
    "a rebuild replaces the kept projection",
  );
});

test("without a session the cockpit loader answers directly", async () => {
  state.authz = null;
  const before = state.builds;
  const page = await projectedPage("ar", {});
  assert.equal(page.refreshing, false);
  assert.equal(state.builds, before + 1);
});
