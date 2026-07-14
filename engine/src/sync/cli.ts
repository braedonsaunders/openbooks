import { NetSuiteSource } from "./netsuite-source.ts";
import { runSync } from "./sync.ts";

const r = await runSync(new NetSuiteSource(), "cli");
console.log(
  JSON.stringify(
    { ...r, skipped: r.skipped.slice(0, 5), tb: { ...r.tb, mismatches: r.tb.mismatches.slice(0, 5) } },
    null,
    1,
  ),
);
process.exit(0);
