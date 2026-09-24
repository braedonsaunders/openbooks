import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Writable } from "node:stream";
import { runLocalBackup } from "./local-cli.ts";

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

test("a lax --org id is refused at arg-parse before any side effect", async () => {
  // C-49: /^[0-9a-f-]{36}$/ accepted 36 dashes and failed mid-run, after the
  // output directory already existed. The canonical assertUuid (the same one
  // restore uses) must refuse before streamBackup is even called.
  const root = await mkdtemp(join(tmpdir(), "openbooks-local-backup-"));
  const out = join(root, "organization.json.gz");
  let streamCalls = 0;
  const streamBackup = async (_orgId: string, sink: Writable) => {
    streamCalls += 1;
    sink.end("backup bytes");
    return { tables: [], totalRows: 0 };
  };
  try {
    await assert.rejects(
      runLocalBackup({ orgId: "-".repeat(36), out, streamBackup }),
      /--org must be a canonical uuid/,
    );
    assert.equal(streamCalls, 0, "no backup work may start for a lax id");
    assert.equal(existsSync(out), false);
    await assert.rejects(
      runLocalBackup({ orgId: "not-a-uuid", out, streamBackup }),
      /--org must be a canonical uuid/,
    );
    assert.equal(streamCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
