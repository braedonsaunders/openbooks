import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sealJson } from "../platform/secrets.ts";
import { buildSource } from "./connection.ts";

process.env.OPENBOOKS_DATA_KEY ??=
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const source = readFileSync(new URL("./connection.ts", import.meta.url), "utf8");

test("buildSource does not construct empty expired Dynamics tokens", () => {
  assert.match(source, /secret\.refreshToken/);
  assert.match(source, /secret\.accessToken/);
  assert.doesNotMatch(source, /accessToken: ""/);
  assert.doesNotMatch(source, /1970-01-01T00:00:00\.000Z/);
});

test("buildSource refuses a Dynamics connection with no delegated tokens", () => {
  assert.throws(
    () =>
      buildSource({
        id: "conn-1",
        orgId: "org-1",
        source: "dynamics",
        displayName: "BC",
        authKind: "oauth2",
        status: "active",
        config: { aadTenantId: "aad-1", environment: "Production", companyId: "co-1" },
        secrets: sealJson({ clientId: "id", clientSecret: "secret" }),
        mirrorEnabled: false,
        mirrorSchedule: "",
        postedChangePolicy: "review_required",
        postedChangeAuthorizedBy: null,
        postedChangeAuthorizedAt: null,
        cursor: null,
        lastRunAt: null,
        lastError: null,
      }),
    /not authorized yet/,
  );
});
