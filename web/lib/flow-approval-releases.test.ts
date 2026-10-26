import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// Scheduling and service approvals are optional Flows: shift requests,
// governed schedule publications and service visit completion reviews are
// released only through their registered handlers, so every process that
// decides gates must have them installed.
test("shift requests, governed schedule publications and service visit completions release through boot-registered handlers", async () => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "server-only")
        return { shortCircuit: true, url: "data:text/javascript,export%20{}" };
      return next(specifier, context);
    },
  });
  const { hasFlowApprovalReleaseHandler, handlerReleasedSubjectKinds, listFlowSubjectProfiles } =
    await import("@openbooks/engine/flows/module");
  const releaseModule: string = "./flow-approval-releases?scheduling-release-test";
  const { registerFlowApprovalReleaseHandlers } = (await import(
    releaseModule
  )) as typeof import("./flow-approval-releases");
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  hooks.deregister();
  installEngineSeams();
  await registerFlowApprovalReleaseHandlers();
  const kinds = handlerReleasedSubjectKinds();
  for (const kind of [
    "schedule_entry_request",
    "schedule_publication",
    "service_visit_completion",
  ]) {
    assert.ok(
      kinds.includes(kind),
      `${kind} is released by its handler, never by a flow status action`,
    );
    assert.equal(
      hasFlowApprovalReleaseHandler(kind),
      true,
      `${kind} has a registered release handler`,
    );
    const profile = listFlowSubjectProfiles().find((candidate) => candidate.subjectKind === kind);
    assert.deepEqual(profile?.triggers, ["on_submit"], `${kind} is submitted to Flows on submit`);
  }
});

// Equity approvals are optional Flows too: a governed equity action an Equity
// action Flow holds applies only through the equity module's release handler,
// and the requester can never decide its own request.
test("governed equity actions release through the boot-registered equity handler with self-approval forbidden", async () => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "server-only")
        return { shortCircuit: true, url: "data:text/javascript,export%20{}" };
      return next(specifier, context);
    },
  });
  const {
    getFlowAdapter,
    hasFlowApprovalReleaseHandler,
    handlerReleasedSubjectKinds,
    listFlowSubjectProfiles,
  } = await import("@openbooks/engine/flows/module");
  const releaseModule: string = "./flow-approval-releases?equity-release-test";
  const { registerFlowApprovalReleaseHandlers } = (await import(
    releaseModule
  )) as typeof import("./flow-approval-releases");
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  hooks.deregister();
  installEngineSeams();
  await registerFlowApprovalReleaseHandlers();
  assert.ok(
    handlerReleasedSubjectKinds().includes("equity_action"),
    "equity actions are released by their handler, never by a flow status action",
  );
  assert.equal(
    hasFlowApprovalReleaseHandler("equity_action"),
    true,
    "equity_action has a registered release handler",
  );
  const profile = listFlowSubjectProfiles().find(
    (candidate) => candidate.subjectKind === "equity_action",
  );
  assert.deepEqual(
    profile?.triggers,
    ["on_submit"],
    "equity actions are submitted to Flows on submit",
  );
  const adapter = getFlowAdapter("equity_action");
  assert.deepEqual(adapter?.permissions, {
    read: "equity.read",
    edit: "equity.manage",
    approve: "equity.approve",
  });
});
