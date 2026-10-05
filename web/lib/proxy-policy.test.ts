import assert from "node:assert/strict";
import test from "node:test";
import { isPublicPath } from "./proxy-policy";
import { employeeManifest } from "./pwa-manifest";
import { metadata as employeeMetadata } from "../app/(app)/me/layout";
import { GET as installationManifest } from "../app/employee-app/manifest.webmanifest/route";

test("public authentication and hosted-payment routes match complete segments", () => {
  for (const pathname of [
    "/login",
    "/api/login",
    "/api/auth/methods",
    "/api/auth/oidc/start",
    "/api/auth/oidc/callback",
    "/api/v1/health",
    "/api/v1/openapi",
    "/api/v1/schema",
    "/api/v1/records/accounts",
    "/api/v1/vendors",
    "/api/v1/future-unreviewed",
    "/api/documents/sign/opaque-token",
    "/api/surveys/respond/opaque-token",
    "/api/time/kiosk/opaque-token",
    "/survey/opaque-token",
    "/kiosk/opaque-token",
    "/pay/opaque-token",
    "/api/pay/opaque-token",
    "/api/payments/webhooks/stripe",
    "/api/channels/123e4567-e89b-12d3-a456-426614174000/webhooks",
    "/api/qbd/web-connector/123e4567-e89b-12d3-a456-426614174000",
    "/api/flows/email-action",
    "/mcp",
    "/socialmedia.png",
    "/employee-app/manifest.webmanifest",
    "/employee-app/icon-192.png",
    "/employee-app/icon-512.png",
    "/employee-app/apple-touch-icon.png",
    "/_next/static/chunk.js",
  ]) assert.equal(isPublicPath(pathname), true, pathname);
});

test("near-prefix private routes never bypass the session gate", () => {
  for (const pathname of [
    "/api/login-extra",
    "/login-help",
    "/payroll",
    "/api/channels",
    "/api/channels/123e4567-e89b-12d3-a456-426614174000",
    "/api/channels/123e4567-e89b-12d3-a456-426614174000/events",
    "/api/channels/123e4567-e89b-12d3-a456-426614174000/webhooks-extra",
    "/api/channels/123e4567-e89b-12d3-a456-426614174000/webhooks/retry",
    "/api/payments/private",
    "/api/payment-operations",
    "/api/v10/health",
    "/api/v1x/vendors",
    "/api/documents/signals",
    "/api/surveys/responders",
    "/api/time/kiosks",
    "/surveys/opaque-token",
    "/kiosks/opaque-token",
    "/api/auth/oidc-malicious",
    "/mcp-admin",
    "/mcp/extra",
    "/_nextish/private",
    "/me",
    "/me/profile",
    "/api/hrm/self/profile",
    "/employee-app/private",
    "/employee-app/icon-192.png/extra",
    "/employee-app/manifest.webmanifest/extra",
  ]) assert.equal(isPublicPath(pathname), false, pathname);
});

test("installation assets are public while the installed employee workspace still requires a session", async () => {
  const metadata = employeeManifest();
  const response = installationManifest();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/manifest+json");
  assert.deepEqual(await response.json(), metadata);
  assert.equal(employeeMetadata.manifest, "/employee-app/manifest.webmanifest");
  assert.equal(isPublicPath(String(employeeMetadata.manifest)), true);
  assert.equal(metadata.start_url, "/me");
  assert.equal(isPublicPath(metadata.start_url), false, "installing OpenBooks does not expose the employee start page");
  for (const icon of metadata.icons ?? []) {
    assert.equal(isPublicPath(icon.src), true, `${icon.src} must be available to the browser installation process`);
  }
});
