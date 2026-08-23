/**
 * Privileged posting-effects operations.
 *
 *   npm -w engine run posting-effects:ops -- list --org=<uuid> [--limit=100]
 *   npm -w engine run posting-effects:ops -- replay --org=<uuid> --id=<uuid> \
 *     --actor=<uuid> --reason="Controller-approved remediation reason"
 *
 * Every command is tenant-scoped. Replay is restricted to terminal work and
 * writes immutable audit evidence with the authorizing user and reason.
 */
import { pool } from "./db.ts";
import {
  listFailedPostingEffects,
  replayTerminalPostingEffect,
} from "./posting-effects.ts";

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(3).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function required(name: string): string {
  const value = option(name)?.trim();
  if (!value) throw new Error(`--${name}=... is required`);
  return value;
}

function usage(): never {
  throw new Error(
    "usage: posting-effects:ops -- list --org=<uuid> [--limit=100] | " +
      "replay --org=<uuid> --id=<uuid> --actor=<uuid> --reason=<reason>",
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "list") {
    const limitRaw = option("limit");
    const limit = limitRaw === undefined ? 100 : Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("--limit must be an integer between 1 and 500");
    }
    console.log(JSON.stringify(await listFailedPostingEffects(required("org"), limit), null, 2));
    return;
  }
  if (command === "replay") {
    await replayTerminalPostingEffect({
      orgId: required("org"),
      id: required("id"),
      actorId: required("actor"),
      reason: required("reason"),
    });
    console.log(JSON.stringify({ status: "queued_for_replay", id: required("id") }));
    return;
  }
  usage();
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
