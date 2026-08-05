import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const compose = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const example = readFileSync(new URL("../.env.compose.example", import.meta.url), "utf8");
const databaseRuntime = readFileSync(new URL("../engine/src/db.ts", import.meta.url), "utf8");
const devDeploy = readFileSync(new URL("../.github/workflows/deploy-dev.yml", import.meta.url), "utf8");
const haBootstrap = readFileSync(new URL("../deploy/ha/base/bootstrap/bootstrap-job.yaml", import.meta.url), "utf8");
const haApplication = readFileSync(new URL("../deploy/ha/base/runtime/application.yaml", import.meta.url), "utf8");
const haNetworkPolicy = readFileSync(new URL("../deploy/ha/base/runtime/network-policy.yaml", import.meta.url), "utf8");
const haBootstrapOverlay = readFileSync(new URL("../deploy/ha/bootstrap/kustomization.yaml", import.meta.url), "utf8");
const haRuntimeOverlay = readFileSync(new URL("../deploy/ha/runtime/kustomization.yaml", import.meta.url), "utf8");
const haImage = readFileSync(new URL("../deploy/ha/image/kustomization.yaml", import.meta.url), "utf8");
const simCompose = readFileSync(new URL("../engine/src/sim/docker-compose.yml", import.meta.url), "utf8");
const workflowDir = join(repoRoot, ".github", "workflows");
const workflows = readdirSync(workflowDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => ({ name: `.github/workflows/${name}`, source: readFileSync(join(workflowDir, name), "utf8") }));

function requirePattern(source, pattern, message) {
  if (!pattern.test(source)) throw new Error(`container security check failed: ${message}`);
}

function rejectPattern(source, pattern, message) {
  if (pattern.test(source)) throw new Error(`container security check failed: ${message}`);
}

rejectPattern(
  compose,
  /^\s*image:\s*["']?[^\s"']+:latest(?:@sha256:[0-9a-f]{64})?["']?(?:\s+#.*)?$/m,
  "Compose contains a floating :latest image",
);
rejectPattern(
  compose,
  /\$\{[^}\r\n]+:-latest\}/,
  "Compose contains a floating latest variable default",
);

const deploymentYaml = [
  { name: "compose.yaml", source: compose },
  { name: "engine/src/sim/docker-compose.yml", source: simCompose },
  { name: "deploy/ha/base/bootstrap/bootstrap-job.yaml", source: haBootstrap },
  { name: "deploy/ha/base/runtime/application.yaml", source: haApplication },
  ...workflows,
];
for (const { name, source } of deploymentYaml) {
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = /^\s*image:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1].replace(/\s+#.*$/, "").replace(/^(?:"|')|(?:"|')$/g, "");
    const requiredApplicationImage = /^\$\{OPENBOOKS_IMAGE:\?[^}]+\}$/.test(value);
    if (!requiredApplicationImage && !/@sha256:[0-9a-f]{64}$/.test(value)) {
      throw new Error(
        `container security check failed: ${name}:${index + 1} image is not pinned to an immutable sha256 digest`,
      );
    }
    if (/:latest(?:@|$)/.test(value) || /\$\{[^}\r\n]+:-latest\}/.test(value)) {
      throw new Error(`container security check failed: ${name}:${index + 1} contains a floating latest image`);
    }
  }
}

// External Dockerfile bases are supply-chain inputs too. Named prior stages
// such as `FROM deps` are local and therefore do not carry a registry digest.
const localStages = new Set();
for (const [index, line] of dockerfile.split(/\r?\n/).entries()) {
  const match = /^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
  if (!match) continue;
  const [, base, stage] = match;
  if (!localStages.has(base) && !/@sha256:[0-9a-f]{64}$/.test(base)) {
    throw new Error(`container security check failed: Dockerfile:${index + 1} external base is not digest-pinned`);
  }
  if (stage) localStages.add(stage);
}

for (const { name, source } of workflows) {
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = /^\s*-?\s*uses:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1].replace(/\s+#.*$/, "").replace(/^(?:"|')|(?:"|')$/g, "");
    if (value.startsWith("./")) continue;
    if (!/@[0-9a-f]{40}$/.test(value)) {
      throw new Error(
        `container security check failed: ${name}:${index + 1} external action is not pinned to a 40-hex commit`,
      );
    }
  }
}
requirePattern(
  compose,
  /^\s*image:\s*\$\{OPENBOOKS_IMAGE:\?[^}]+\}\s*$/m,
  "OpenBooks application image is not an explicitly required full reference",
);
if (existsSync(join(repoRoot, "deploy", "ha", "kustomization.yaml"))) {
  throw new Error("container security check failed: deploy/ha must not be directly applyable; use ordered overlays");
}
requirePattern(
  haBootstrapOverlay,
  /resources:[\s\S]*?\.\.\/base\/configuration[\s\S]*?\.\.\/base\/bootstrap/,
  "HA bootstrap overlay is not isolated from runtime workloads",
);
requirePattern(
  haRuntimeOverlay,
  /resources:[\s\S]*?\.\.\/base\/configuration[\s\S]*?\.\.\/base\/runtime/,
  "HA runtime overlay is missing its isolated runtime base",
);
rejectPattern(
  haBootstrap,
  /openbooks-runtime|SESSION_SECRET|OPENBOOKS_DATA_KEY|S3_SECRET_ACCESS_KEY|OPENBOOKS_INTERNAL_TOKEN/,
  "HA bootstrap receives the broad runtime secret",
);
requirePattern(
  haNetworkPolicy,
  /name:\s*openbooks-default-deny-ingress[\s\S]*?policyTypes:\s*[\s\S]*?- Ingress/,
  "HA runtime has no default-deny ingress policy",
);
requirePattern(
  haNetworkPolicy,
  /openbooks\.network\/trusted-proxy:\s*"true"/,
  "HA trusted-proxy ingress policy does not fail closed on explicit labels",
);
rejectPattern(
  `${compose}\n${haBootstrap}\n${haApplication}\n${haImage}`,
  /ghcr\.io\/braedonsaunders\/openbooks/i,
  "a historical public OpenBooks package reference remains in deployment configuration",
);
for (const [label, manifest] of [["bootstrap", haBootstrap], ["application", haApplication]]) {
  requirePattern(
    manifest,
    /image:\s*example\.invalid\/openbooks@sha256:0{64}/,
    `HA ${label} manifest is not fail-closed on an intentionally non-runnable image`,
  );
}
requirePattern(
  haImage,
  /newName:\s*example\.invalid\/openbooks[\s\S]*?digest:\s*sha256:0{64}/,
  "the single HA image override is not fail-closed on an intentionally non-runnable digest",
);

requirePattern(
  compose,
  /POSTGRES_USER:\s*openbooks_owner/,
  "PostgreSQL bootstrap owner is not explicit",
);
requirePattern(
  compose,
  /OPENBOOKS_DB_URL:\s*postgres:\/\/openbooks_app:/,
  "runtime containers are not pinned to openbooks_app",
);
requirePattern(
  compose,
  /bootstrap:[\s\S]*?OPENBOOKS_BOOTSTRAP:\s*"1"[\s\S]*?OPENBOOKS_MIGRATION_DB_URL:\s*postgres:\/\/openbooks_owner:/,
  "one-shot bootstrap does not use the isolated owner connection",
);
requirePattern(
  compose,
  /web:[\s\S]*?command:\s*\["node",\s*"web\/server\.js"\][\s\S]*?bootstrap:[\s\S]*?condition:\s*service_completed_successfully/,
  "web does not wait for the one-shot bootstrap",
);
requirePattern(
  dockerfile,
  /CMD\s*\["node",\s*"web\/server\.js"\]/,
  "the image still combines privileged bootstrap and web runtime",
);
requirePattern(
  dockerfile,
  /USER\s+node\s*[\r\n]+CMD\s*\["node",\s*"web\/server\.js"\]/,
  "the production image does not drop root before startup",
);
requirePattern(
  example,
  /^POSTGRES_OWNER_PASSWORD=/m,
  "Compose example omits the owner secret",
);
requirePattern(
  example,
  /^OPENBOOKS_DB_PASSWORD=/m,
  "Compose example omits the independent runtime secret",
);
requirePattern(
  databaseRuntime,
  /const bypass = ctx\?\.bypass === true;[\s\S]*?const org = bypass \? "" : ctx\?\.orgId \?\? "";/,
  "unscoped application database access does not fail closed",
);
requirePattern(
  devDeploy,
  /name: Run deployment bootstrap[\s\S]*?OPENBOOKS_MIGRATION_DB_URL[\s\S]*?OPENBOOKS_RUNTIME_DB_URL[\s\S]*?docker run --rm --env-file[\s\S]*?name: Select image and deploy/,
  "dev deployment does not complete the isolated migration bootstrap before rolling out web and worker",
);

console.log("container OS/database role separation and fail-closed RLS context verified");
