import assert from "node:assert/strict";
import test from "node:test";
import { dbWriteErrorResponse } from "./db-errors";
import { isUuid } from '../list-params';

const CONFLICTS = { form_layouts_org_type_name: "A form with that name already exists" };

function pgError(code: string, constraint: string): Error {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code,
    constraint,
  });
}

function drizzleWrapped(code: string, constraint: string): Error {
  // Drizzle wraps driver failures: its own message embeds the SQL, the driver
  // error rides in `cause`.
  return Object.assign(new Error(`Failed query: insert into "form_layouts" ... params: ...`), {
    cause: pgError(code, constraint),
  });
}

test("a unique violation on a known constraint becomes a 409", async () => {
  for (const error of [pgError("23505", "form_layouts_org_type_name"), drizzleWrapped("23505", "form_layouts_org_type_name")]) {
    const res = dbWriteErrorResponse(error, { route: "customization:form-layouts", uniqueConflicts: CONFLICTS });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "A form with that name already exists" });
  }
});

test("any message mentioning 'unique' is not a name conflict", async () => {
  // The old code matched msg.includes("unique"): a wrapped query echoing the
  // index name, or any other message containing the word, became a 409.
  const res = dbWriteErrorResponse(new Error('relation "unique_things" does not exist'), {
    route: "customization:form-layouts",
    uniqueConflicts: CONFLICTS,
  });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "save failed");
});

test("a unique violation on an unknown constraint is a generic 500", async () => {
  const res = dbWriteErrorResponse(pgError("23505", "some_other_index"), {
    route: "customization:form-layouts",
    uniqueConflicts: CONFLICTS,
  });
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string; correlationId: string };
  assert.equal(body.error, "save failed");
  assert.ok(isUuid(body.correlationId), 'the correlation id is a UUID');
});

test("unexpected failures are generic, correlated, and logged", async () => {
  const logged: unknown[][] = [];
  const prior = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const boom = new Error("connect ECONNREFUSED 10.0.0.85:5432");
    const res = dbWriteErrorResponse(boom, { route: "customization:form-layouts", uniqueConflicts: CONFLICTS });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string; correlationId: string };
    assert.deepEqual(Object.keys(body).sort(), ["correlationId", "error"]);
    assert.ok(!JSON.stringify(body).includes("10.0.0.85"), "storage internals must not reach the client");
    assert.equal(logged.length, 1);
    assert.match(String(logged[0]![0]), /customization:form-layouts/);
    assert.ok(String(logged[0]![0]).includes(body.correlationId), "the log must carry the correlation id");
    assert.equal(logged[0]![1], boom);
  } finally {
    console.error = prior;
  }
});
