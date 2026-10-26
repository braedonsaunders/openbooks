import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_HOST_API, backendSourceErrors } from "./backend-check";
import { APP_HOST_API_REFERENCE } from "./host-api-reference";

test("a backend must parse, define handler, and call only the host API", () => {
  assert.deepEqual(
    backendSourceErrors(
      "backend/ok.js",
      `function handler(request) {
    // ob.journal.post is mentioned in prose only
    var note = "ob.nothing.here";
    var r = ob.platform.query({ from: { type: 'projects', as: 'p' }, select: [{ source: 'p', field: 'code' }] });
    ob.log(ob.settings.get('min_score'), r.records.length, note);
    return { message: 'ok' };
  }`,
    ),
    [],
  );
  const [syntax] = backendSourceErrors(
    "backend/broken.js",
    "function handler(request) { var = ; }",
  );
  assert.match(syntax!, /^backend\/broken\.js: syntax error/);
  assert.deepEqual(backendSourceErrors("backend/none.js", "var x = 1;"), [
    "backend/none.js: must define function handler(request)",
  ]);
  assert.deepEqual(
    backendSourceErrors(
      "backend/guess.js",
      "function handler() { ob.journal.post({}); ob.journal.post({}); ob.nonexistent.foo(); return 1 }",
    ),
    [
      "backend/guess.js: ob.journal.post is not part of the app host API; ob.journal provides create()",
      "backend/guess.js: ob.nonexistent is not part of the app host API; available: ob.log, ob.request, ob.settings, ob.storage, ob.records, ob.journal, ob.platform",
    ],
  );
});

test("the documented host API and the draft check list the same calls", () => {
  const documented = Object.values(APP_HOST_API_REFERENCE.calls).flatMap((calls) =>
    calls.map((doc) => doc.call.slice("ob.".length, doc.call.indexOf("("))),
  );
  const checked = Object.entries(APP_HOST_API).flatMap(([area, members]) =>
    area === "request" ? [] : members ? members.map((member) => `${area}.${member}`) : [area],
  );
  assert.deepEqual(documented.sort(), checked.sort());
});
