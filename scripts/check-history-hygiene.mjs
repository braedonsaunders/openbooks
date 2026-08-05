import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// Store fingerprints—not customer or tenant names—so this prevention gate
// cannot itself reintroduce prohibited identifiers into the repository.
const prohibitedIdentifierHashes = new Set([
  "3014637776d42a85266a46eecaa689d23eed6e49a3cea1f282afce1001b796c7",
  "b7d43aed608d1cbb1afefb42e2be6763530e5aee6994d25867246c8fa4703bd9",
  "fa32bdd07499522b9e099829d524820571854df53a467b14b08ebd3d2286d6ce",
  "cbd74271cc98249a368d5e1b7c6f0636ad4132fa123a6f90e6df50731ed375f3",
  "2a8883bc38f9bc430dbe4349245808633c55ed72db3e383832d905b2dfa44416",
  "a8cfc74482c018974f6b9e56c865ba1d718007bc295a305d4ead3964d5f09e5d",
  "9241579e6ad3afa278e55151a0c2751af9a9c655b2db25d35a4845f6267689c8",
  "6e5e825c558c5d993bb79cd4384690edb8bf2ed67d5c623baaf34dcbc78aeb77",
  "dae3be6c1355614ec0d577941b51fbbb961465f589b6cff36b3de0359280c72f",
  "2624169ff3689d21f7dda5f47e2abecca8fb714e94227a21f47948a41e5909d8",
  "3d0b6788d0209c7fde7a398c2a27f6c53aeb4dcada97cf98104320f9f367cbf2",
  "a9ed492dcb98579d9b98479b4c1374dab9ee234e529e7ebb54c5ef7d39a6914f",
  "674523586ff93cc6290f7d949b831d1c2599412995a0aafe962f06c3ce893578",
]);

const prohibitedPathPatterns = [
  /(?:^|\/)\.local\/tenant-migrations(?:\/|$)/i,
  /(?:^|\/)account-data(?:\/|$)/i,
  /(?:^|\/)extraction(?:\/|$)/i,
  /(?:^|\/)objects-list\.txt$/i,
];

function containsProhibitedIdentifier(value) {
  const lower = value.toLowerCase();
  const tokens = new Set([
    ...lower.split(/[^a-z0-9]+/).filter(Boolean),
    ...lower.split(/[^a-z0-9_]+/).filter(Boolean),
  ]);
  return [...tokens].some((token) =>
    prohibitedIdentifierHashes.has(
      createHash("sha256").update(token).digest("hex"),
    ),
  );
}

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const violations = [];
for (const line of git("rev-list", "--objects", "--all").split("\n")) {
  const separator = line.indexOf(" ");
  if (separator < 0) continue;
  const objectId = line.slice(0, separator);
  const path = line.slice(separator + 1);
  if (prohibitedPathPatterns.some((pattern) => pattern.test(path))) {
    violations.push(`${objectId}: prohibited private-data path class`);
  } else if (containsProhibitedIdentifier(path)) {
    violations.push(
      `${objectId}: prohibited customer/tenant identifier in path`,
    );
  }
}

for (const line of git("log", "--all", "--format=%H%x09%s").split("\n")) {
  if (!line) continue;
  const [commitId, ...subjectParts] = line.split("\t");
  if (containsProhibitedIdentifier(subjectParts.join("\t"))) {
    violations.push(
      `${commitId}: prohibited customer/tenant identifier in commit subject`,
    );
  }
}

if (violations.length > 0) {
  process.stderr.write(
    "Git history hygiene check failed. Rewrite the affected refs before publication:\n",
  );
  for (const violation of [...new Set(violations)].slice(0, 100)) {
    process.stderr.write(`- ${violation}\n`);
  }
  if (violations.length > 100)
    process.stderr.write(`- and ${violations.length - 100} more\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Git history contains no prohibited private-data paths or identifiers.\n",
  );
}
