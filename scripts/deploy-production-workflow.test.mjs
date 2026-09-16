import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Production deploy contract. The swarm release must run on the LAN runner,
 * only for attested release tags, migrate-first through the audited release
 * script, and prove the new version serves before the job goes green. Each
 * assertion pins a property whose loss would deploy silently wrong.
 */
const deployWorkflow = readFileSync(
  new URL("../.github/workflows/deploy-production.yml", import.meta.url),
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

test("a release tag deploys its own attested digest and nothing else deploys", () => {
  const deployJob = publishWorkflow.slice(publishWorkflow.indexOf("\n  deploy:\n"));
  assert.notEqual(deployJob.length, 0, "publish-container must define the deploy job");
  assert.match(deployJob, /needs: publish/, "deploy must wait for the attested publish");
  assert.match(
    deployJob,
    /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/,
    "only pushed release tags deploy; manual edge publishes must not",
  );
  assert.match(
    deployJob,
    /uses: \.\/\.github\/workflows\/deploy-production\.yml/,
    "the tag path and the manual path must share one deploy implementation",
  );
  assert.match(
    deployJob,
    /digest: \$\{\{ needs\.publish\.outputs\.digest \}\}/,
    "the deployed digest must be the merged, scanned, attested one",
  );
  assert.match(
    deployJob,
    /expected_version: \$\{\{ github\.ref_name \}\}/,
    "the health check must expect the tag being released",
  );
  assert.match(deployJob, /secrets: inherit/);
});

test("the deploy runs on the LAN runner under the production environment, one at a time", () => {
  assert.match(deployWorkflow, /runs-on: \[self-hosted, dokploy\]/, "GitHub-hosted runners cannot reach the swarm manager");
  assert.match(deployWorkflow, /environment:\n\s+name: production/, "secrets and the tag policy live on the production environment");
  assert.match(deployWorkflow, /concurrency:\n\s+group: production-deploy\n\s+cancel-in-progress: false/, "releases serialize; a later tag must never cancel a pin swap mid-flight");
  assert.match(deployWorkflow, /permissions:\n\s+contents: read\n/, "the deploy job needs no write token");
  assert.doesNotMatch(deployWorkflow, /pull_request/, "fork-triggered events must never reach the self-hosted runner");
});

test("inputs are validated before anything touches the manager", () => {
  const validate = namedStep(deployWorkflow, "Validate release inputs");
  assert.match(validate, /\^sha256:\[0-9a-f\]\{64\}\$/, "only an immutable digest may be released");
  assert.match(validate, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+/, "the expected version must be a release version");
  const validateAt = deployWorkflow.indexOf("- name: Validate release inputs");
  const releaseAt = deployWorkflow.indexOf("- name: Release the digest");
  assert.ok(validateAt > -1 && releaseAt > -1 && validateAt < releaseAt, "validation precedes the release");
});

test("the release goes through the audited migrate-first script over a pinned host key", () => {
  const release = namedStep(deployWorkflow, "Release the digest (migrate first, then swap both pins)");
  assert.match(release, /< deploy\/swarm-release\.sh/, "the runner must execute the repository's release script, not an inline copy");
  assert.match(release, /"bash -s -- '\$DIGEST'"/, "the digest is the script's only argument");
  assert.match(release, /StrictHostKeyChecking=yes/, "an unknown host key must abort, never be accepted");
  assert.match(release, /UserKnownHostsFile="\$RUNNER_TEMP\/deploy-ssh\/known_hosts"/, "the host key comes from the pinned environment value");
  assert.match(release, /BatchMode=yes/, "the job must never wait on an interactive prompt");
  assert.doesNotMatch(deployWorkflow, /StrictHostKeyChecking=no|accept-new/);
  const install = namedStep(deployWorkflow, "Install the deploy key");
  assert.match(install, /umask 077/, "the private key file must never be group/world readable");
  assert.match(install, /secrets\.PRODUCTION_DEPLOY_SSH_KEY/);
  assert.match(install, /vars\.PRODUCTION_SSH_KNOWN_HOSTS/);
  const cleanup = namedStep(deployWorkflow, "Remove the deploy key");
  assert.match(cleanup, /if: always\(\)/, "the key is removed even when the release fails");
});

test("the job only goes green once production serves the expected version", () => {
  const wait = namedStep(deployWorkflow, "Wait for the new version to serve");
  assert.match(wait, /\.version \/\/ empty/, "the health payload's version is the proof");
  assert.match(wait, /\[ "\$version" = "\$EXPECTED_VERSION" \]/, "a stale version must not pass");
  assert.match(wait, /\[ "\$status" = "ok" \]/, "an unhealthy service must not pass");
  assert.match(wait, /exit 1/, "a timeout fails the job instead of reporting success");
  assert.match(wait, /openbooks-deploy-backup-/, "a failed swap must point the operator at the rollback backup");
  const releaseAt = deployWorkflow.indexOf("- name: Release the digest");
  const waitAt = deployWorkflow.indexOf("- name: Wait for the new version to serve");
  assert.ok(releaseAt < waitAt, "verification follows the release");
});

test("the manual entry point carries the same contract as the tag path", () => {
  assert.match(deployWorkflow, /workflow_call:\n\s+inputs:\n\s+digest:/, "publish-container calls this workflow");
  assert.match(deployWorkflow, /workflow_dispatch:\n\s+inputs:\n\s+digest:/, "operators can re-deploy or roll back to an attested digest");
  assert.equal(occurrenceCount(deployWorkflow, "description: Attested image digest to release (sha256:<64 hex>)"), 2);
  assert.equal(occurrenceCount(deployWorkflow, "expected_version:"), 2, "both entry points require the version the health check must see");
});
