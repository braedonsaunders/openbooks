import assert from "node:assert/strict";
import test from "node:test";
import { portalMagicLinkEmail } from "./portal-magic-link";

test("portalMagicLinkEmail carries the one-time link and expiry in both bodies", () => {
  const mail = portalMagicLinkEmail({
    orgName: "Acme Corp",
    portalName: "Acme portal",
    linkUrl: "https://books.example.com/portal/abc123",
    expiresMinutes: 15,
  });
  assert.ok(mail.subject.includes("Acme portal"));
  assert.ok(mail.text.includes("https://books.example.com/portal/abc123"));
  assert.ok(mail.text.includes("15 minutes"));
  assert.ok(mail.html.includes("https://books.example.com/portal/abc123"));
});

test("portalMagicLinkEmail escapes org-controlled names", () => {
  const mail = portalMagicLinkEmail({
    orgName: "<b>Acme</b>",
    portalName: "Portal",
    linkUrl: "https://books.example.com/portal/x",
    expiresMinutes: 15,
  });
  assert.ok(!mail.html.includes("<b>Acme</b>"));
  assert.ok(mail.html.includes("&lt;b&gt;Acme&lt;/b&gt;"));
});
