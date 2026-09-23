import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// server-only guards page loaders against client bundling; stub it so the
// pure helper loads under plain node (the ref-options vendors test stubs
// it the same way).
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "server-only"
      ? { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" }
      : next(specifier, context);
  },
});

const { FieldTimeError } = await import("@openbooks/engine/src/hrm/field-time/errors.ts");
const { SelfServiceError } = await import("@openbooks/engine/src/hrm/self-service/actor.ts");
const { HrmDocumentsError, HrmSurveysError } = await import(
  "@openbooks/engine/src/hrm/documents/errors.ts"
);
const { loadOrRefuse } = await import("./load-or-refuse.ts");

/**
 * loadOrRefuse converts only the listed domain refusals to page state.
 *
 * A correct refusal that never reaches anyone is the defect: the clock and
 * /me loaders resolve their actor through a person link, and an unlinked
 * login must read the refusal with its remedy instead of the error
 * boundary. Anything else — another code of the same class, another error
 * entirely — still throws, so a real defect can never hide behind a
 * refusal state.
 */

const NO_EMPLOYEE = { error: FieldTimeError, code: "no_employee_link" } as const;
const NO_LINK = { error: SelfServiceError, code: "NO_LINK" } as const;

test("a listed refusal becomes page state carrying the remedy", async () => {
  const outcome = await loadOrRefuse(
    async () => {
      throw new FieldTimeError(
        "no_employee_link",
        "No employee record is linked to this login — ask HR to link the user to an employee party before clocking in",
      );
    },
    { refusals: [NO_EMPLOYEE], title: "Field clock" },
  );
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.ok ? null : outcome.refusal, {
    title: "Field clock",
    message:
      "No employee record is linked to this login — ask HR to link the user to an employee party before clocking in",
  });
});

test("a successful load passes through untouched", async () => {
  const outcome = await loadOrRefuse(async () => ({ rows: [1] }), {
    refusals: [NO_EMPLOYEE, NO_LINK],
    title: "Field clock",
  });
  assert.deepEqual(outcome, { ok: true, data: { rows: [1] } });
});

test("another code of the same error class still throws", async () => {
  await assert.rejects(
    loadOrRefuse(
      async () => {
        throw new FieldTimeError(
          "field_time_off",
          "Field time is turned off — turn on fieldTime in Company Settings → Features",
        );
      },
      { refusals: [NO_EMPLOYEE], title: "Field clock" },
    ),
    /Field time is turned off/,
  );
  await assert.rejects(
    loadOrRefuse(
      async () => {
        throw new SelfServiceError("FORBIDDEN", "not yours");
      },
      { refusals: [NO_LINK], title: "Me" },
    ),
    /not yours/,
  );
});

test("an unrelated error still throws", async () => {
  await assert.rejects(
    loadOrRefuse(
      async () => {
        throw new Error("boom");
      },
      { refusals: [NO_EMPLOYEE, NO_LINK], title: "Field clock" },
    ),
    /boom/,
  );
});

test("a shared REFUSED code converts only its no-link text", async () => {
  const refusals = [
    {
      error: HrmDocumentsError,
      code: "REFUSED",
      messageIncludes: "not linked to a person record",
    },
  ] as const;
  const linked = await loadOrRefuse(
    async () => {
      throw new HrmDocumentsError(
        "REFUSED",
        "your login is not linked to a person record — ask HR to link it before opening your documents",
      );
    },
    { refusals, title: "My documents" },
  );
  assert.equal(linked.ok, false);
  // The grant refusal shares the code but not the condition: it must throw.
  await assert.rejects(
    loadOrRefuse(
      async () => {
        throw new HrmSurveysError(
          "REFUSED",
          "survey invitations need the employee self-service grant — ask an administrator for access in /admin/roles",
        );
      },
      {
        refusals: [
          {
            error: HrmSurveysError,
            code: "REFUSED",
            messageIncludes: "not linked to a person record",
          },
        ],
        title: "Open surveys",
      },
    ),
    /self-service grant/,
  );
});

test("a refusal's remedy link rides into page state only when declared", async () => {
  const notConfigured = () =>
    loadOrRefuse(
      async () => {
        throw new FieldTimeError("field_time_not_configured", "Field time is not configured — declare the rules in Timesheets setup");
      },
      {
        refusals: [{ error: FieldTimeError, code: "field_time_not_configured", action: { href: "/time/setup", label: "Open setup" } }],
        title: "Field clock",
      },
    );
  const withLink = await notConfigured();
  assert.deepEqual(withLink.ok ? null : withLink.refusal.action, { href: "/time/setup", label: "Open setup" });
  const plain = await loadOrRefuse(
    async () => {
      throw new FieldTimeError("no_employee_link", "No employee record is linked to this login");
    },
    { refusals: [NO_EMPLOYEE], title: "Field clock" },
  );
  assert.equal(plain.ok ? "loaded" : "action" in plain.refusal, false, "no action key when none is declared");
});
