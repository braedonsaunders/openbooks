import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Platform ZIP oracle with cleanup even when extraction or assertions refuse. */
export async function withZipFixture<T>(bytes: Uint8Array, inspect: (path: string, directory: string) => T | Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "openbooks-zip-"));
  try {
    const path = join(directory, "export.zip");
    writeFileSync(path, bytes);
    return await inspect(path, directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function readZipJson<T>(path: string, entry = "export.json"): T {
  return JSON.parse(execFileSync("unzip", ["-p", path, entry], { encoding: "utf8" })) as T;
}
