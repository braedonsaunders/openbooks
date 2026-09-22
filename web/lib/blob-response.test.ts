import assert from "node:assert/strict";
import { test } from "node:test";
import { blobResponse, isActiveContentType, type ServableBlob } from "./blob-response.ts";

const XHTML =
  `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">` +
  `<body><script>alert(document.cookie)</script></body></html>`;

function blobFor(contentType: string, text = "bytes"): ServableBlob {
  return {
    filename: "statement",
    contentType,
    bytes: Buffer.from(text),
    versionId: "11111111-1111-4111-8111-111111111111",
  };
}

function dispositionOf(contentType: string): string {
  const res = blobResponse(new Request("https://app.example/f"), blobFor(contentType, XHTML));
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  return res.headers.get("content-disposition") ?? "";
}

test("xml is served as attachment, never inline on the app origin", () => {
  for (const type of ["application/xml", "text/xml", "Application/XML", "text/xml; charset=utf-8"]) {
    const disposition = dispositionOf(type);
    assert.ok(
      disposition.startsWith("attachment"),
      `${type} must download, got: ${disposition}`,
    );
  }
  assert.equal(isActiveContentType("application/xml"), true);
  assert.equal(isActiveContentType("text/xml"), true);
});

test("svg, html and xhtml download even though the cabinet never stores them", () => {
  for (const type of ["image/svg+xml", "text/html", "application/xhtml+xml", "application/atom+xml"]) {
    assert.ok(
      dispositionOf(type).startsWith("attachment"),
      `${type} must download`,
    );
  }
});

test("inert preview types stay inline", () => {
  for (const type of [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/gif",
    "text/plain",
    "text/csv",
    "application/json",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ]) {
    assert.ok(
      dispositionOf(type).startsWith("inline"),
      `${type} must preview inline`,
    );
  }
});

test("the served content type is preserved and the filename survives", () => {
  const res = blobResponse(new Request("https://app.example/f"), blobFor("application/xml", XHTML));
  assert.equal(res.headers.get("content-type"), "application/xml");
  assert.match(res.headers.get("content-disposition") ?? "", /filename="statement"/);
});
