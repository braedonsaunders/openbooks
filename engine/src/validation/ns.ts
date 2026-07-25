import { readFileSync, writeFileSync } from "node:fs";
import { NetSuiteBridgeClient } from "../netsuite-bridge.ts";
import type { NetSuiteCreds } from "../netsuite.ts";
export function nsCreds(): NetSuiteCreds {
  const raw = readFileSync(new URL("../../../.env.netsuite", import.meta.url), "utf8");
  const m: Record<string, string> = {};
  for (const line of raw.split("\n")) { const i = line.indexOf("="); if (i > 0) m[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { account: m.NETSUITE_ACCOUNT, host: m.NETSUITE_HOST, consumerKey: m.NETSUITE_CONSUMER_KEY, consumerSecret: m.NETSUITE_CONSUMER_SECRET, tokenKey: m.NETSUITE_TOKEN_KEY, tokenSecret: m.NETSUITE_TOKEN_SECRET };
}
export const nsClient = () => new NetSuiteBridgeClient(nsCreds());
if (import.meta.url === `file://${process.argv[1]}`) {
  const [sqlText, outFile] = process.argv.slice(2);
  nsClient().query(sqlText).then((rows) => {
    writeFileSync(outFile, JSON.stringify(rows));
    console.log(`${rows.length} rows -> ${outFile}`);
    process.exit(0);
  }).catch((e) => { console.error("ERR:", e.message?.slice(0, 200)); process.exit(1); });
}
