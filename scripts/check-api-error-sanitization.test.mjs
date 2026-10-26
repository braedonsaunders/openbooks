import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scanText } from "./check-api-error-sanitization.mjs";

const scan = (text) => scanText("route.ts", text);

test("caught messages and stringified errors are refused with their response location", () => {
  for (const expression of [
    "error.message",
    "error?.message",
    'error["message"]',
    "String(error)",
    'error instanceof Error ? error.message : "Failed"',
  ]) {
    assert.deepEqual(
      scan(
        `try { work() } catch (error) {\n return NextResponse.json({ error: ${expression} })\n}`,
      ),
      [2],
      expression,
    );
  }
});

test("aliases of a caught object retain the same direct response check", () => {
  assert.deepEqual(
    scan(
      "try { work() } catch (error) { const alias = error; return Response.json({error: alias.message}) }",
    ),
    [1],
  );
});

test("validation messages, safe responses and shadowed callback bindings remain permitted", () => {
  assert.deepEqual(
    scan(
      'return NextResponse.json({error: query.error.issues.map(issue => issue.message).join("; ")})',
    ),
    [],
  );
  assert.deepEqual(scan("try { work() } catch (error) { return apiErrorResponse(error) }"), []);
  assert.deepEqual(
    scan(
      "try { work() } catch (error) { return Response.json({error: issues.map(error => error.message)}) }",
    ),
    [],
  );
  assert.deepEqual(
    scan(
      "try { work() } catch (error) { const message = publicMessage(error); return Response.json({error: message}) }",
    ),
    [],
  );
});

test("native inventory option validation is compatible with the guard", () => {
  const path = "web/app/api/inventory/movement-options/route.ts";
  assert.deepEqual(scanText(path, readFileSync(path, "utf8")), []);
});

test("error constructions embedding a caught message are refused at their line", () => {
  assert.deepEqual(
    scan(
      'try { work() } catch (error) { throw new SelfServiceError("REFUSED", `saved but refused: ${error.message}`) }',
    ),
    [1],
  );
  assert.deepEqual(
    scan(
      "try { work() } catch (e) { throw new ReleaseError(decision, e instanceof Error ? e.message : String(e)) }",
    ),
    [1],
  );
});

test("sanitizer-wrapped and domain-narrowed constructions remain permitted", () => {
  assert.deepEqual(
    scan("try { work() } catch (e) { throw new ReleaseError(decision, sanitizeDecisionCause(e)) }"),
    [],
  );
  assert.deepEqual(
    scan(
      'function refuse(error) { if (error instanceof HrmChangeRequestError) return new SelfServiceError("REFUSED", error.message) }',
    ),
    [],
  );
  assert.deepEqual(
    scan(
      'try { work() } catch (error) { const detail = sanitize(error); throw new SelfServiceError("REFUSED", detail) }',
    ),
    [],
  );
  assert.deepEqual(
    scan(
      'try { work() } catch (error) { if (error instanceof HrmPositionError) { throw new HrmChangeRequestError("REFUSED", error.message) } throw error }',
    ),
    [],
  );
  assert.deepEqual(
    scan(
      "try { work() } catch (error) { discardClient = error instanceof Error ? error : new Error(String(error)) }",
    ),
    [],
  );
});

test("base-Error narrowing and mixed guarded unguarded reads stay refused", () => {
  assert.deepEqual(
    scan(
      'try { work() } catch (error) { if (error instanceof Error) { throw new HrmChangeRequestError("REFUSED", error.message) } throw error }',
    ),
    [1],
  );
  assert.deepEqual(
    scan(
      'try { work() } catch (a) { try { work() } catch (b) { if (a instanceof HrmError) { throw new HrmChangeRequestError("REFUSED", a.message + b.message) } } }',
    ),
    [1],
  );
});

test("domain-narrowed response reads remain permitted; base-Error narrowed ones stay refused", () => {
  assert.deepEqual(
    scan(
      'try { work() } catch (error) { if (error instanceof WarehouseRefusal) { return NextResponse.json({ error: error.message, code: error.code }) } return unexpectedServerError("x", error) }',
    ),
    [],
  );
  assert.deepEqual(
    scan(
      "try { work() } catch (error) { if (error instanceof InventoryError) return NextResponse.json({ error: error.message }, { status: 422 }) }",
    ),
    [],
  );
  assert.deepEqual(
    scan(
      "try { work() } catch (error) { if (error instanceof Error) { return NextResponse.json({ error: error.message }) } throw error }",
    ),
    [1],
  );
  assert.deepEqual(
    scan(
      "try { work() } catch (error) { if (error instanceof InventoryError) { return NextResponse.json({ error: error.message }) } return NextResponse.json({ error: error.message }) }",
    ),
    [1],
  );
});
