import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("every database pool survives an idle connection error and reports it", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import pg from "pg";
    const pools = [];
    const OriginalPool = pg.Pool;
    pg.Pool = class extends OriginalPool {
      constructor(options) {
        super(options);
        pools.push(this);
      }
    };
    const messages = [];
    console.error = (...parts) => messages.push(parts.join(" "));
    await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    assert.equal(pools.length, 5, "exercise runtime, trusted, trusted maintenance, governed read and maintenance pools");
    const names = ["runtime", "trusted", "trusted maintenance", "governed read", "maintenance"];
    for (const [index, pool] of pools.entries()) {
      const count = messages.length;
      assert.doesNotThrow(() => pool.emit("error", new Error("idle database connection interrupted")), names[index] + " pool must not terminate the process");
      assert.equal(messages.length, count + 1, names[index] + " pool must report its connection error");
      assert.match(messages.at(-1), /idle database connection interrupted/);
      await pool.end();
    }
  `], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: "test",
      OPENBOOKS_DB_URL: "postgresql://runtime:unit-test@127.0.0.1:1/unconnected",
      OPENBOOKS_BYPASS_DB_URL: "postgresql://trusted:unit-test@127.0.0.1:1/unconnected",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.error, undefined, result.error?.message ?? "pool error probe must start and finish without a subprocess error");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
