import assert from "node:assert/strict";
import test from "node:test";
import { sealJson } from "../platform/secrets.ts";
import { buildSource, type ConnectionRow } from "./connection.ts";

process.env.OPENBOOKS_DATA_KEY ??=
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

function dynamicsRow(secrets: Record<string, unknown>): ConnectionRow {
  return {
    id: "conn-1",
    orgId: "org-1",
    source: "dynamics",
    displayName: "BC",
    authKind: "oauth2",
    status: "active",
    config: { aadTenantId: "aad-1", environment: "Production", companyId: "co-1" },
    secrets: sealJson(secrets),
    mirrorEnabled: false,
    mirrorSchedule: "",
    postedChangePolicy: "review_required",
    postedChangeAuthorizedBy: null,
    postedChangeAuthorizedAt: null,
    cursor: null,
    lastRunAt: null,
    lastError: null,
  };
}

test("buildSource refuses Dynamics connections missing delegated token material", () => {
  for (const tokens of [
    { refreshToken: "refresh", accessToken: "", expiresAt: "2020-01-01T00:00:00.000Z" },
    { refreshToken: "", accessToken: "access", expiresAt: "2020-01-01T00:00:00.000Z" },
    { refreshToken: "refresh", accessToken: "access" },
  ]) {
    assert.throws(
      () => buildSource(dynamicsRow({ clientId: "id", clientSecret: "secret", ...tokens })),
      /Dynamics connection is not authorized yet — click Connect to grant access/,
    );
  }
});
