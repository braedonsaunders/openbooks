import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Writable } from "node:stream";
import { runLocalBackup } from "./backup-local-cli.ts";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

test("removes every artifact after a manifest failure so the backup can be retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbooks-local-backup-"));
  const out = join(root, "organization.json.gz");
  const streamBackup = async (_orgId: string, sink: Writable) => {
    sink.end("backup bytes");
    return { tables: [{ name: "orgs", rows: 1 }], totalRows: 1 };
  };

  try {
    await assert.rejects(
      runLocalBackup({
        orgId: ORG_ID,
        out,
        streamBackup,
        writeManifest: async (manifestPath, contents) => {
          await writeFile(manifestPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
          throw new Error("injected manifest persistence failure");
        },
      }),
      /injected manifest persistence failure/,
    );
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(`${out}.partial`), false);
    assert.equal(existsSync(`${out}.manifest.json`), false);

    const manifest = await runLocalBackup({ orgId: ORG_ID, out, streamBackup });
    assert.equal(manifest.file, out);
    assert.equal(existsSync(out), true);
    assert.equal(existsSync(`${out}.manifest.json`), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
