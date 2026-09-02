import { execFileSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const BINARY_ASSET_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".avi",
  ".avif",
  ".bin",
  ".bmp",
  ".bz2",
  ".class",
  ".dmg",
  ".dll",
  ".doc",
  ".docx",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".heic",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lib",
  ".lz4",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".psd",
  ".rar",
  ".so",
  ".tar",
  ".tgz",
  ".tif",
  ".tiff",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xz",
  ".zip",
  ".zst",
]);

function readTrackedBlobs(objectIds) {
  const uniqueObjectIds = [...new Set(objectIds)];
  if (uniqueObjectIds.length === 0) return new Map();

  const output = execFileSync("git", ["cat-file", "--batch"], {
    input: `${uniqueObjectIds.join("\n")}\n`,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const blobs = new Map();
  let offset = 0;

  for (const objectId of uniqueObjectIds) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`git cat-file returned an incomplete header for ${objectId}`);

    const [reportedObjectId, type, sizeText] = output
      .subarray(offset, headerEnd)
      .toString("ascii")
      .split(" ");
    const size = Number(sizeText);
    if (
      reportedObjectId !== objectId ||
      type === "missing" ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new Error(`git cat-file returned an unexpected object for ${objectId}`);
    }

    const dataStart = headerEnd + 1;
    const dataEnd = dataStart + size;
    if (dataEnd >= output.length || output[dataEnd] !== 0x0a) {
      throw new Error(`git cat-file returned truncated data for ${objectId}`);
    }
    if (type === "blob") blobs.set(objectId, output.subarray(dataStart, dataEnd));
    offset = dataEnd + 1;
  }

  return blobs;
}

function isBinaryAsset(path) {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const extensionStart = fileName.lastIndexOf(".");
  const extension = extensionStart > 0 ? fileName.slice(extensionStart).toLowerCase() : "";
  return BINARY_ASSET_EXTENSIONS.has(extension);
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
const blobs = readTrackedBlobs(
  entries
    .map((entry) => {
      const separator = entry.indexOf("\t");
      return separator < 0 ? null : entry.slice(0, separator).split(" ")[1];
    })
    .filter(Boolean),
);

for (const entry of entries) {
  const separator = entry.indexOf("\t");
  if (separator < 0) continue;

  const [mode, objectId] = entry.slice(0, separator).split(" ");
  const path = entry.slice(separator + 1);

  if (/(?:^|\/)node_modules(?:\/|$)/.test(path)) {
    violations.push(`${path}: dependency artifacts must not be tracked`);
  }

  const blob = blobs.get(objectId);
  if (!blob) continue;

  if (mode === "120000") {
    const target = blob.toString("utf8").trim();
    if (isAbsoluteTarget(target) || /(?:^|\/)\.bb\/worktrees(?:\/|$)/.test(target)) {
      violations.push(`${path}: machine-specific symlink target ${JSON.stringify(target)}`);
    }
    continue;
  }

  if (mode.startsWith("100") && blob.includes(0) && !isBinaryAsset(path)) {
    violations.push(`${path}: tracked text/source blob contains NUL bytes (Git classifies it as binary)`);
  }
}

if (violations.length > 0) {
  process.stderr.write(
    "Repository artifact check failed. Remove tracked dependencies, machine-specific symlinks, and NUL bytes from text/source blobs:\n",
  );
  for (const violation of violations) process.stderr.write(`- ${violation}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Repository index contains no tracked dependencies, machine-specific symlinks, or NUL-containing source blobs.\n",
  );
}
