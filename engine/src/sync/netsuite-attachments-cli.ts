import { importNetSuiteAttachments, type ImportOptions } from "./netsuite-attachments.ts";

function parseArgs(argv: string[]): ImportOptions {
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const org = read("--org")?.trim();
  if (!org) throw new Error("--org <tenant UUID or exact tenant name> is required");
  const concurrency = Number(read("--concurrency") ?? 6);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) {
    throw new Error("--concurrency must be an integer from 1 to 12");
  }
  const limitValue = read("--limit");
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  return {
    org,
    connectionId: read("--connection"),
    execute: argv.includes("--execute"),
    concurrency,
    limit,
  };
}

importNetSuiteAttachments(parseArgs(process.argv.slice(2)))
  .then((summary) => console.log(JSON.stringify(summary, null, 2)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
