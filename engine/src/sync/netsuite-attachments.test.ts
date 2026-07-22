import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBridgeAttachment,
  detectContentType,
  expenseReportFileIds,
  normalizeAttachmentBytes,
  safeFilename,
} from "./netsuite-attachments.ts";

test("detectContentType recognizes source receipt signatures", () => {
  assert.equal(detectContentType(Buffer.from("%PDF-1.7"), "wrong.jpg"), "application/pdf");
  assert.equal(
    detectContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "receipt"),
    "image/png",
  );
  assert.equal(detectContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "receipt"), "image/jpeg");
  assert.equal(detectContentType(Buffer.from("GIF89a"), "receipt"), "image/gif");
});

test("detectContentType rejects unsupported content instead of mis-serving it", () => {
  assert.throws(() => detectContentType(Buffer.from("not an image"), "payload.exe"), /unsupported attachment/);
  assert.throws(() => detectContentType(Buffer.from("not an image"), "spoofed.pdf"), /unsupported attachment/);
});

test("normalizeAttachmentBytes removes the bounded CPOW envelope from legacy PDFs", () => {
  const wrapped = Buffer.from("%PDFfileName=R42565_IN.PDF\r\n%[EndCPOW]\r\n%PDF-1.3\nbody");
  const normalized = normalizeAttachmentBytes(wrapped);
  assert.equal(normalized.toString(), "%PDF-1.3\nbody");
  assert.equal(detectContentType(normalized, "invoice.pdf"), "application/pdf");
  const ordinary = Buffer.from("%PDF-1.7\nbody");
  assert.strictEqual(normalizeAttachmentBytes(ordinary), ordinary);
  assert.equal(normalizeAttachmentBytes(Buffer.from("%PDFfileName=missing-real-header")).toString(), "%PDFfileName=missing-real-header");
});

test("safeFilename strips paths and control characters", () => {
  assert.equal(safeFilename("../receipts/invoice\u0000.pdf", "42"), "invoice.pdf");
  assert.equal(safeFilename("..\\receipts\\invoice.pdf", "42"), "invoice.pdf");
  assert.equal(safeFilename("\u0000", "42"), "attachment-42");
});

test("expenseReportFileIds reads and deduplicates standard REST receipt references", () => {
  assert.deepEqual(expenseReportFileIds({
    expense: {
      items: [
        { expmediaitem: { id: "33057" } },
        { expmediaitem: { id: "33057" } },
        { expmediaitem: { id: 33058 } },
        { expmediaitem: null },
      ],
    },
  }), ["33057", "33058"]);
  assert.deepEqual(expenseReportFileIds({ expense: { items: [] } }), []);
});

test("decodeBridgeAttachment validates identity, encoding, and decoded size", () => {
  const bytes = Buffer.from("%PDF-1.7");
  const decoded = decodeBridgeAttachment({
    ok: true,
    file: {
      id: "406564",
      name: "invoice.pdf",
      size: bytes.length,
      encoding: "base64",
      contents: bytes.toString("base64"),
    },
  }, "406564");
  assert.equal(decoded.source.name, "invoice.pdf");
  assert.deepEqual(decoded.bytes, bytes);

  assert.throws(() => decodeBridgeAttachment({ ok: false, error: "denied" }, "406564"), /denied/);
  assert.throws(() => decodeBridgeAttachment({
    ok: true,
    file: { id: "999", name: "invoice.pdf", size: bytes.length, encoding: "base64", contents: bytes.toString("base64") },
  }, "406564"), /wrong file/);
  assert.throws(() => decodeBridgeAttachment({
    ok: true,
    file: { id: "406564", name: "invoice.pdf", size: bytes.length + 1, encoding: "base64", contents: bytes.toString("base64") },
  }, "406564"), /size mismatch/);
});
