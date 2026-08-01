import { readFileSync } from "node:fs";

const compose = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const example = readFileSync(new URL("../.env.compose.example", import.meta.url), "utf8");
const databaseRuntime = readFileSync(new URL("../engine/src/db.ts", import.meta.url), "utf8");

function requirePattern(source, pattern, message) {
  if (!pattern.test(source)) throw new Error(`container security check failed: ${message}`);
}

requirePattern(
  compose,
  /POSTGRES_USER:\s*openbooks_owner/,
  "PostgreSQL bootstrap owner is not explicit",
);
requirePattern(
  compose,
  /OPENBOOKS_DB_URL:\s*postgres:\/\/openbooks_app:/,
  "runtime containers are not pinned to openbooks_app",
);
requirePattern(
  compose,
  /bootstrap:[\s\S]*?OPENBOOKS_BOOTSTRAP:\s*"1"[\s\S]*?OPENBOOKS_MIGRATION_DB_URL:\s*postgres:\/\/openbooks_owner:/,
  "one-shot bootstrap does not use the isolated owner connection",
);
requirePattern(
  compose,
  /web:[\s\S]*?command:\s*\["node",\s*"web\/server\.js"\][\s\S]*?bootstrap:[\s\S]*?condition:\s*service_completed_successfully/,
  "web does not wait for the one-shot bootstrap",
);
requirePattern(
  dockerfile,
  /CMD\s*\["node",\s*"web\/server\.js"\]/,
  "the image still combines privileged bootstrap and web runtime",
);
requirePattern(
  dockerfile,
  /USER\s+node\s*[\r\n]+CMD\s*\["node",\s*"web\/server\.js"\]/,
  "the production image does not drop root before startup",
);
requirePattern(
  example,
  /^POSTGRES_OWNER_PASSWORD=/m,
  "Compose example omits the owner secret",
);
requirePattern(
  example,
  /^OPENBOOKS_DB_PASSWORD=/m,
  "Compose example omits the independent runtime secret",
);
requirePattern(
  databaseRuntime,
  /const bypass = ctx\?\.bypass === true;[\s\S]*?const org = bypass \? "" : ctx\?\.orgId \?\? "";/,
  "unscoped application database access does not fail closed",
);

console.log("container OS/database role separation and fail-closed RLS context verified");
