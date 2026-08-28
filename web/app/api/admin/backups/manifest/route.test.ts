import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("../[id]/manifest/route.ts", import.meta.url), "utf8");

// export.ts is server-only; shim that marker so the real filename helper can
// be exercised by the plain Node test runner.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});
const { contentDisposition } = await import("../../../../../lib/export.ts?backup-manifest-filename-test");
hooks.deregister();

test("manifest downloads use a distinct JSON sidecar filename", () => {
  // Regression: passing `${base}.json.gz` as the helper stem relabeled the
  // manifest with the archive name instead of using the stripped archive base.
  assert.match(
    route,
    /"Content-Disposition": contentDisposition\("attachment", base, "manifest\.json"\)/,
  );

  const archive = "acme-backup.json.gz";
  const archiveBase = archive.replace(/\.json\.gz$/, "");
  const archiveName = /filename="([^"]+)"/.exec(contentDisposition("attachment", archiveBase, "json.gz"))?.[1];
  const manifestName = /filename="([^"]+)"/.exec(
    contentDisposition("attachment", archiveBase, "manifest.json"),
  )?.[1];

  assert.equal(archiveName, archive);
  assert.equal(manifestName, "acme-backup.manifest.json");
  assert.notEqual(manifestName, archiveName);
  assert.match(route, /"Content-Type": "application\/json; charset=utf-8"/);
});
