import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const deployWorkflow = readFileSync(
  new URL("../.github/workflows/deploy-edge.yml", import.meta.url),
  "utf8",
);
const publishWorkflow = readFileSync(
  new URL("../.github/workflows/publish-container.yml", import.meta.url),
  "utf8",
);

function occurrenceCount(source, value) {
  return source.split(value).length - 1;
}

function namedStep(source, name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `workflow must contain the ${name} step`);
  const next = source.indexOf("\n      - ", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function assertMainDispatchRefAndExactCommit(source) {
  const dispatchStep = namedStep(source, "Dispatch edge container publish");
  assert.equal(
    occurrenceCount(dispatchStep, "--arg ref "),
    1,
    "the publish dispatch must declare exactly one ref argument",
  );
  assert.match(
    dispatchStep,
    /--arg ref "main"/,
    "the publish dispatch ref must resolve to the main branch",
  );
  assert.equal(
    occurrenceCount(dispatchStep, "--arg commitSha "),
    1,
    "the publish dispatch must declare exactly one commitSha argument",
  );
  assert.match(
    dispatchStep,
    /--arg commitSha "\$TRIGGER_SHA"/,
    "the publish dispatch commitSha must be the tested commit",
  );
  assert.equal(
    occurrenceCount(dispatchStep, "commit_sha: $commitSha"),
    1,
    "the workflow dispatch inputs must include only the tested commit sha",
  );
  const validationPattern = 'if [[ ! "$TRIGGER_SHA" =~ ^[0-9a-f]{40}$ ]]; then';
  const validationIndex = dispatchStep.indexOf(validationPattern);
  assert.notEqual(
    validationIndex,
    -1,
    "the tested commit must be validated before dispatching publish",
  );
  const payloadIndex = dispatchStep.indexOf('dispatch_payload="$(');
  assert.notEqual(payloadIndex, -1, "the publish dispatch must build its payload inline");
  assert.ok(
    validationIndex < payloadIndex,
    "the tested commit must be validated before building the dispatch payload",
  );
  const dispatchIndex = dispatchStep.indexOf("gh api \\");
  assert.notEqual(dispatchIndex, -1, "the publish dispatch must call gh api inline");
  assert.ok(
    validationIndex < dispatchIndex,
    "the tested commit must be validated before dispatching publish",
  );
}

function assertExactPublishRunDataflow(source) {
  const dispatchStep = namedStep(source, "Dispatch edge container publish");
  const waitStep = namedStep(source, "Wait for edge container publish");

  assert.equal(
    occurrenceCount(dispatchStep, 'dispatch_response="$('),
    1,
    "the dispatch receipt must have exactly one assignment",
  );
  const responseIndex = dispatchStep.indexOf('dispatch_response="$(');
  assert.notEqual(
    responseIndex,
    -1,
    "the dispatch receipt must be captured in the dispatch step",
  );
  assert.match(
    dispatchStep,
    /dispatch_response="\$\(\n\s+gh api \\\n\s+--method POST \\\n/,
    "the dispatch receipt must be captured from the inline dispatch call",
  );
  assert.match(
    dispatchStep,
    /workflows\/publish-container\.yml\/dispatches" \\\n\s+--input - <<< "\$dispatch_payload"\n\s+\)"/,
    "the dispatch receipt body must be the tested-commit dispatch response",
  );
  assert.ok(
    responseIndex < dispatchStep.indexOf('publish_run_id="$('),
    "the dispatch receipt must be captured before its run id is extracted",
  );

  assert.equal(
    (dispatchStep.match(/\bpublish_run_id\s*=/g) ?? []).length,
    1,
    "publish_run_id must have exactly one assignment",
  );
  assert.match(
    dispatchStep,
    /publish_run_id="\$\(\n\s+jq --exit-status --raw-output \\\n\s+'\.workflow_run_id \| select\(type == "number" and \. > 0\)' \\\n\s+<<< "\$dispatch_response"\n\s+\)"/,
    "the dispatch receipt's workflow_run_id must bind publish_run_id",
  );
  assert.equal(
    occurrenceCount(
      dispatchStep,
      'echo "run_id=${publish_run_id}" >> "$GITHUB_OUTPUT"',
    ),
    1,
    "publish_run_id must become the publish step's run_id output",
  );
  assert.equal(
    (dispatchStep.match(/\brun_id\s*=/g) ?? []).length,
    1,
    "run_id must have exactly one output write",
  );
  assert.equal(
    occurrenceCount(
      waitStep,
      "PUBLISH_RUN_ID: ${{ steps.publish.outputs.run_id }}",
    ),
    1,
    "the wait step must consume only the dispatch receipt output",
  );
  assert.equal(
    (waitStep.match(/\bPUBLISH_RUN_ID\s*[:=]/g) ?? []).length,
    1,
    "PUBLISH_RUN_ID must have exactly one binding",
  );
  assert.match(
    waitStep,
    /gh run watch "\$PUBLISH_RUN_ID" \\\n\s+--repo "\$GITHUB_REPOSITORY" \\\n\s+--exit-status/,
    "the repository-scoped watch must consume the receipt-derived run ID",
  );
}

test("edge deployment dispatches and watches the publish run for the tested commit", () => {
  assertMainDispatchRefAndExactCommit(deployWorkflow);
  assert.match(
    deployWorkflow,
    /TRIGGER_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
    "the successful test run's commit must be the edge publish source",
  );
  assert.match(
    deployWorkflow,
    /--arg ref "main"/,
    "the workflow dispatch ref must resolve to the main branch",
  );
  assert.match(
    deployWorkflow,
    /--arg commitSha "\$TRIGGER_SHA"/,
    "the publish workflow input must receive the tested commit",
  );
  assert.match(
    deployWorkflow,
    /commit_sha: \$commitSha/,
    "the tested commit must be present in the dispatch inputs",
  );
  assert.match(
    deployWorkflow,
    /return_run_details: true/,
    "dispatch must request an authoritative workflow-run receipt",
  );
  assertExactPublishRunDataflow(deployWorkflow);
  assert.match(
    deployWorkflow,
    /gh run watch "\$PUBLISH_RUN_ID" \\\n\s+--repo "\$GITHUB_REPOSITORY" \\\n\s+--exit-status/,
    "deployment must watch the receipt's run in the event repository",
  );
  assert.doesNotMatch(
    deployWorkflow,
    /gh run list/,
    "run-list polling can select another concurrent publish",
  );
});

test("the exact publish receipt cannot be rebound before the watch", () => {
  const mutations = [
    [
      ".workflow_run_id | select(type == \"number\" and . > 0)",
      ".id | select(type == \"number\" and . > 0)",
    ],
    [
      'echo "run_id=${publish_run_id}" >> "$GITHUB_OUTPUT"',
      'echo "run_id=${GITHUB_RUN_ID}" >> "$GITHUB_OUTPUT"',
    ],
    [
      'echo "Dispatched exact publish run ${publish_run_id}: ${publish_run_url}"',
      'echo "Dispatched exact publish run ${publish_run_id}: ${publish_run_url}"\n' +
        '          publish_run_id="$GITHUB_RUN_ID"',
    ],
    [
      'echo "run_id=${publish_run_id}" >> "$GITHUB_OUTPUT"',
      'echo "run_id=${publish_run_id}" >> "$GITHUB_OUTPUT"\n' +
        '          echo "run_id=${GITHUB_RUN_ID}" >> "$GITHUB_OUTPUT"',
    ],
    [
      "PUBLISH_RUN_ID: ${{ steps.publish.outputs.run_id }}",
      "PUBLISH_RUN_ID: ${{ github.run_id }}",
    ],
    [
      'echo "Watching exact publish run ${PUBLISH_RUN_ID} for ${VERSION}."',
      'echo "Watching exact publish run ${PUBLISH_RUN_ID} for ${VERSION}."\n' +
        '          PUBLISH_RUN_ID="$GITHUB_RUN_ID"',
    ],
    ['gh run watch "$PUBLISH_RUN_ID"', 'gh run watch "$GITHUB_RUN_ID"'],
    [
      'publish_run_id="$(',
      "dispatch_response=\"$(gh run list --workflow publish-container.yml --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId // 0')\"\n" +
        '          publish_run_id="$(',
    ],
    [
      'actions/workflows/publish-container.yml/dispatches" \\',
      'actions/workflows/publish-container.yml/runs?per_page=1" \\',
    ],
  ];

  for (const [contract, mutation] of mutations) {
    assert.equal(
      occurrenceCount(deployWorkflow, contract),
      1,
      `mutation fixture must uniquely identify ${contract}`,
    );
    assert.throws(
      () => assertExactPublishRunDataflow(deployWorkflow.replace(contract, mutation)),
      /must/,
      `dataflow guard must reject ${mutation}`,
    );
  }
});

function assertPublishVerificationProvisionsQpdf(source) {
  const jobStart = source.indexOf("  verify:");
  const jobEnd = source.indexOf("\n  container-security:");
  assert.notEqual(jobStart, -1, "the publish workflow must keep its verify job");
  assert.notEqual(jobEnd, -1, "the publish workflow must keep its security job");
  const verifyJob = source.slice(jobStart, jobEnd);

  const qpdfStepMarker = "      - name: Install qpdf\n";
  assert.equal(
    occurrenceCount(verifyJob, qpdfStepMarker),
    1,
    "the verify job must declare exactly one qpdf provisioning step",
  );
  const qpdfStep = namedStep(verifyJob, "Install qpdf");
  assert.match(
    qpdfStep,
    /run: sudo apt-get update && sudo apt-get install -y qpdf/,
    "the qpdf step must install the real binary before verification",
  );

  const releaseGateIndex = verifyJob.indexOf("        run: npm run verify:release");
  assert.notEqual(
    releaseGateIndex,
    -1,
    "the verify job must still run the full release verification",
  );
  assert.ok(
    verifyJob.indexOf(qpdfStepMarker) < releaseGateIndex,
    "qpdf must be provisioned before the release verification runs",
  );
}

test("container verification provisions qpdf before the release gate", () => {
  assertPublishVerificationProvisionsQpdf(publishWorkflow);
});

test("the publish qpdf provisioning contract cannot drift", () => {
  const mutations = [
    [
      "      - name: Install qpdf\n",
      "",
    ],
    [
      "      - name: Install qpdf\n",
      "      - name: Prepare PDF toolchain\n",
    ],
    [
      "run: sudo apt-get update && sudo apt-get install -y qpdf",
      'run: echo "assuming qpdf is preinstalled"',
    ],
    [
      "        run: npm run verify:release\n",
      "        run: npm run check:product-neutrality\n",
    ],
  ];

  for (const [contract, mutation] of mutations) {
    assert.equal(
      occurrenceCount(publishWorkflow, contract),
      1,
      `mutation fixture must uniquely identify ${JSON.stringify(contract)}`,
    );
    assert.throws(
      () =>
        assertPublishVerificationProvisionsQpdf(
          publishWorkflow.replace(contract, mutation),
        ),
      /must|before/,
      `qpdf provisioning guard must reject ${mutation || "<removed>"}`,
    );
  }
});

test("manual container publishes validate and check out one pinned source commit", () => {
  assert.match(
    publishWorkflow,
    /commit_sha:\n\s+description: Full commit SHA to verify and publish\n\s+required: true/,
    "manual publishes must require an immutable source commit",
  );
  assert.match(
    publishWorkflow,
    /SOURCE_COMMIT: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.commit_sha \|\| \(github\.event_name == 'push' && github\.sha\) \}\}/,
    "manual and tag publishes must derive one explicit source commit",
  );
  assert.match(
    publishWorkflow,
    /if \[\[ ! "\$SOURCE_COMMIT" =~ \^\[0-9a-f\]\{40\}\$ \]\]; then/,
    "the pinned source must be validated before any checkout",
  );

  const checkoutCount = occurrenceCount(
    publishWorkflow,
    "uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  );
  const pinnedCheckoutCount = occurrenceCount(
    publishWorkflow,
    "ref: ${{ env.SOURCE_COMMIT }}",
  );

  assert.equal(checkoutCount, 3, "all three publish jobs should check out source");
  assert.equal(
    pinnedCheckoutCount,
    checkoutCount,
    "every publish-workflow checkout must use the pinned source commit",
  );
  assert.equal(
    occurrenceCount(
      publishWorkflow,
      "org.opencontainers.image.revision=${{ env.SOURCE_COMMIT }}",
    ),
    2,
    "candidate and release metadata must identify the pinned source commit",
  );
});

test("container verification runs the deployment workflow contract test", () => {
  assert.equal(
    occurrenceCount(
      publishWorkflow,
      "run: node --test scripts/deploy-edge-workflow.test.mjs",
    ),
    1,
    "the publish verification gate must execute this regression suite",
  );
});
