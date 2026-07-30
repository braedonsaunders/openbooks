import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool } from "../engine/src/db.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsRoot = join(repoRoot, "schema", "migrations");

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function git(args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

async function main(): Promise<void> {
  const tracked = (await db.execute(sql`
    select filename, sha256, applied_at::text
      from _applied_migrations
     order by filename
  `)) as unknown as {
    rows: { filename: string; sha256: string; applied_at: string }[];
  };
  const drift: Array<{
    filename: string;
    appliedAt: string;
    storedDigest: string;
    currentDigest: string;
    historicalCommit: string | null;
    historicalCommitDate: string | null;
    changedLines: { added: number; removed: number } | null;
  }> = [];
  for (const row of tracked.rows) {
    const absolutePath = join(migrationsRoot, row.filename);
    if (!existsSync(absolutePath)) continue;
    const current = readFileSync(absolutePath);
    const currentDigest = sha256(current);
    if (currentDigest === row.sha256) continue;
    const gitPath = `schema/migrations/${row.filename}`;
    const commits = git(["rev-list", "--all", "--", gitPath])
      .split(/\r?\n/)
      .filter(Boolean);
    let historicalCommit: string | null = null;
    let historicalContent: string | null = null;
    for (const commit of commits) {
      const shown = spawnSync("git", ["show", `${commit}:${gitPath}`], {
        cwd: repoRoot,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (shown.status === 0 && sha256(shown.stdout) === row.sha256) {
        historicalCommit = commit;
        historicalContent = shown.stdout.toString("utf8");
        break;
      }
    }
    let changedLines: { added: number; removed: number } | null = null;
    if (historicalContent !== null) {
      const scratch = mkdtempSync(join(tmpdir(), "openbooks-migration-drift-"));
      try {
        const historicalPath = join(scratch, "historical.sql");
        writeFileSync(historicalPath, historicalContent);
        const diff = spawnSync(
          "git",
          ["diff", "--no-index", "--numstat", "--", historicalPath, absolutePath],
          { cwd: repoRoot, encoding: "utf8" },
        );
        const match = diff.stdout.match(/^(\d+)\s+(\d+)\s+/m);
        if (match) {
          changedLines = {
            added: Number(match[1]),
            removed: Number(match[2]),
          };
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    const historicalCommitDate = historicalCommit
      ? git(["show", "-s", "--format=%cI", historicalCommit]).trim()
      : null;
    drift.push({
      filename: row.filename,
      appliedAt: row.applied_at,
      storedDigest: row.sha256,
      currentDigest,
      historicalCommit,
      historicalCommitDate,
      changedLines,
    });
  }
  console.log(JSON.stringify({ driftCount: drift.length, drift }, null, 2));
}

void (async () => {
  try {
    await main();
  } finally {
    await pool.end();
  }
})();
