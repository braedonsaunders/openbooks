import assert from "node:assert/strict";
import test from "node:test";

const { fileContentDisposition, pdfResponse } = await import("./export");

test("a stored filename cannot break out of the Content-Disposition header", () => {
  const header = fileContentDisposition("attachment", 'pay"run\r\nSet-Cookie: x=1\\..\\ach.txt');
  assert.doesNotMatch(header, /[\r\n]/);
  assert.equal(header.match(/"/g)?.length, 2, "only the quotes delimiting the ASCII fallback");
  assert.match(
    header,
    /^attachment; filename="payrunSet-Cookie: x=1-..-ach\.txt"; filename\*=UTF-8''/,
  );
});

test("a non-ASCII filename keeps an ASCII fallback and its exact UTF-8 name", () => {
  const header = fileContentDisposition("attachment", "Relevé d'emploi (T4).pdf");
  assert.equal(
    header,
    `attachment; filename="Releve d'emploi (T4).pdf"; filename*=UTF-8''Relev%C3%A9%20d%27emploi%20%28T4%29.pdf`,
  );
});

test("an empty filename falls back to a generic download name", () => {
  assert.equal(
    fileContentDisposition("attachment", " \u0000 "),
    `attachment; filename="download"; filename*=UTF-8''download`,
  );
});

test("generated PDFs are served inline under nosniff", () => {
  const response = pdfResponse(Buffer.from("%PDF-1.7"), "Offer letter");
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^inline; filename="Offer letter\.pdf"/,
  );
});
