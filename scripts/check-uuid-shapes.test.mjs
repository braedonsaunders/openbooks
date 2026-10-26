import assert from "node:assert/strict";
import test from "node:test";
import { findRfcUuidValidators, findWeakUuidShapes, stripComments } from "./check-uuid-shapes.mjs";

const scan = (source) => findRfcUuidValidators(stripComments(source));

test("uuid shape check refuses zod RFC UUID format calls wherever they are chained", () => {
  const hits = scan(`
    import { z } from "zod";
    export const body = z.object({
      periodId: z.string().uuid(),
      bookId: z.uuid({ error: "bookId must be a valid id" }),
      legacy: z.guid(),
      ids: z.array(z.string().trim()
        .uuid("ids must contain valid ids")).optional(),
      key: z.string().uuidv4(),
    });
  `);
  assert.deepEqual(
    hits.map((hit) => [hit.line, hit.kind, hit.text]),
    [
      [4, "zod", ".uuid("],
      [5, "zod", "z.uuid("],
      [6, "zod", "z.guid("],
      [8, "zod", ".uuid("],
      [9, "zod", ".uuidv4("],
    ],
  );
});

test("uuid shape check refuses hand-written RFC variant/version patterns", () => {
  const hits = scan(`
    const A = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const B = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89AB][0-9a-f]{3}-[0-9a-f]{12}$/;
    const C = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[8-9a-b][0-9a-f]{3}-[0-9a-f]{12}$";
  `);
  assert.deepEqual(
    hits.map((hit) => [hit.line, hit.kind]),
    [
      [2, "rfc"],
      [3, "rfc"],
      [4, "rfc"],
    ],
  );
});

test("uuid shape check accepts the house validators, prose, and unrelated methods", () => {
  const source = `
    import { UUID_RE, isUuid, uuidString } from "@openbooks/engine/platform/identifiers";
    // zod's .uuid() and z.uuid() refuse sandbox-derived ids; prose is exempt.
    /* -[1-8]xxx-[89ab]xxx- */
    export const body = z.object({ periodId: uuidString(), ids: z.array(uuidString("ids must contain valid ids")) });
    export const ok = isUuid(value) && UUID_RE.test(value) && record.uuidLabel && fluid(1) && guidance();
    export const house = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  `;
  assert.deepEqual(scan(source), []);
  assert.deepEqual(findWeakUuidShapes(stripComments(source)), []);
});

test("uuid shape check still refuses the weak 36-character shape", () => {
  const hits = findWeakUuidShapes(stripComments("const WEAK = /^[0-9a-f-]{36}$/i;"));
  assert.equal(hits.length, 1);
});
