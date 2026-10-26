import { readFileSync } from "node:fs";
import { freemem } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MiB = 1024 ** 2;
let available = freemem();
if (process.platform === "linux") {
  const memory = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB$/m);
  if (!memory) throw new Error("Available compiler memory could not be measured.");
  available = Number(memory[1]) * 1024;
  try {
    const maximum = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (maximum !== "max") {
      const current = Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim());
      available = Math.min(available, Number(maximum) - current);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
// Leave room for native compiler allocations and the host. Never increase a
// container limit or stop another process to make the compiler fit.
const heapMiB = Math.min(10240, Math.floor((available - 3 * 1024 ** 3) / MiB));
if (!Number.isFinite(heapMiB) || heapMiB < 8192) {
  throw new Error(
    "Full web typechecking requires at least 11 GiB of available memory; use the coordinated verification host.",
  );
}
console.log(JSON.stringify({ availableBytes: available, heapMiB, reservedBytes: 3 * 1024 ** 3 }));
const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const result = spawnSync(
  process.execPath,
  [`--max-old-space-size=${heapMiB}`, compiler, "--noEmit"],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) throw new Error(`Web typechecking stopped with ${result.signal}.`);
process.exitCode = result.status ?? 1;
