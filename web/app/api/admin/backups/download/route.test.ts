import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    if (specifier === "../../../../../lib/authz") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function guardPermission(){return {user:{id:'user',orgId:'org'}}}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const directDownloadRouteUrl: string = "./route.ts?direct-backup-download-test";
const { GET } = await import(directDownloadRouteUrl) as typeof import("./route.ts");
hooks.deregister();

test("direct browser export refuses with the restore-grade recovery path", async () => {
  const response = await GET();

  assert.equal(response.status, 410);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "direct browser export is disabled because it cannot include restore-grade hash evidence",
    recovery: "create a stored backup and download both Archive and Manifest, or use backup-local-cli.ts",
  });
});
