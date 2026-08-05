import assert from "node:assert/strict";
import test from "node:test";
import { isPublicPath } from "./proxy-policy";

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
    "/pay/opaque-token",
    "/api/pay/opaque-token",
    "/api/payments/webhooks/stripe",
    "/api/flows/email-action",
    "/_next/static/chunk.js",
  ]) assert.equal(isPublicPath(pathname), true, pathname);
});

test("near-prefix private routes never bypass the session gate", () => {
  for (const pathname of [
    "/api/login-extra",
    "/login-help",
    "/payroll",
    "/api/payments/private",
    "/api/payment-operations",
    "/api/v10/health",
    "/api/v1/future-unreviewed",
    "/api/auth/oidc-malicious",
    "/_nextish/private",
  ]) assert.equal(isPublicPath(pathname), false, pathname);
});
