import { execFileSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isAbsoluteTarget(target) {
  return (
    target.startsWith("/") ||
    target.startsWith("\\\\") ||
    /^[a-z]:[\\/]/i.test(target) ||
    /^file:\/\//i.test(target)
  );
}

const violations = [];
const entries = git("ls-files", "--stage", "-z").split("\0").filter(Boolean);

for (const entry of entries) {
  const separator = entry.indexOf("\t");
  if (separator < 0) continue;

  const [mode, objectId] = entry.slice(0, separator).split(" ");
  const path = entry.slice(separator + 1);

  if (/(?:^|\/)node_modules(?:\/|$)/.test(path)) {
    violations.push(`${path}: dependency artifacts must not be tracked`);
  }

  if (mode !== "120000") continue;
  const target = git("cat-file", "blob", objectId).trim();
  if (isAbsoluteTarget(target) || /(?:^|\/)\.bb\/worktrees(?:\/|$)/.test(target)) {
    violations.push(`${path}: machine-specific symlink target ${JSON.stringify(target)}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(
    "Repository artifact check failed. Remove tracked dependencies and machine-specific symlinks:\n",
  );
  for (const violation of violations) process.stderr.write(`- ${violation}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Repository index contains no tracked dependencies or machine-specific symlinks.\n",
  );
}
