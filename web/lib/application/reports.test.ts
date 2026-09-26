import assert from "node:assert/strict";
import test from "node:test";

const { runApplicationReport } = await import("./reports");
const { ApplicationError } = await import("./errors");
type ApplicationContext = import("./context").ApplicationContext;

test("report runs refuse restricted subsidiary scope before resolving report data", async () => {
  const context = {
    authz: {
      user: { orgId: "reports-scope-test", id: "actor" },
      permissions: new Set(["reports.read"]),
      allowedSubsidiaryIds: new Set(["one-subsidiary"]),
    },
    source: "api",
    requestId: "reports-scope-request",
    apiKeyId: null,
  } as unknown as ApplicationContext;

  await assert.rejects(
    runApplicationReport(context, { definitionId: "00000000-0000-4000-8000-000000000001" }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "forbidden"
      && error.status === 403
      && error.details?.permission === "reports.unrestricted_scope",
  );
});
