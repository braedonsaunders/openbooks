import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { revokeRuntimeFunctionExecute } from "./bootstrap-function-denials.ts";

const adminUrl = process.env.OPENBOOKS_TEST_ADMIN_DB_URL;
// Same convention as bootstrap-precreated-roles: a canonical DB partition
// must refuse a missing administrator endpoint rather than silently skip
// this provisioning proof. Runs inside the shard's own database (a scratch
// database on a shared cluster invites the connection reaper), in a scratch
// schema with uniquely suffixed roles and functions so concurrent shards
// cannot collide.
const DB = Boolean(process.env.OPENBOOKS_DB_URL || adminUrl);

test(
  "runtime function denials keep owner EXECUTE while denying foreign functions",
  { skip: !DB, timeout: 120_000 },
  async (t) => {
    assert.ok(
      adminUrl,
      "this test requires OPENBOOKS_TEST_ADMIN_DB_URL; use the test cluster administrator endpoint",
    );
    const suffix = randomBytes(6).toString("hex");
    const builder = `ob_g48_deny_builder_${suffix}`;
    const runtime = `ob_g48_deny_runtime_${suffix}`;
    const other = `ob_g48_deny_other_${suffix}`;
    const stranger = `ob_g48_deny_stranger_${suffix}`;
    const schema = `g48_deny_sch_${suffix}`;
    const owned = `g48_deny_owned_fn_${suffix}`;
    const foreign = `g48_deny_foreign_fn_${suffix}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    t.after(async () => {
      await admin.query(`drop schema if exists ${schema} cascade`).catch(() => undefined);
      // Revoke before dropping: DROP ROLE refuses while grants remain.
      for (const role of [builder, runtime, other, stranger]) {
        await admin.query(`revoke all on schema ${schema} from ${role}`).catch(() => undefined);
      }
      for (const role of [builder, runtime, other, stranger]) {
        await admin.query(`drop role if exists ${role}`).catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
    });
    const as = async (role: string, text: string) => {
      await admin.query(`set session authorization ${role}`);
      try {
        return await admin.query(text);
      } finally {
        await admin.query("reset session authorization");
      }
    };

    for (const role of [builder, runtime, other, stranger]) {
      await admin.query(`create role ${role} nologin`);
    }
    await admin.query(`create schema ${schema}`);
    // Builders need USAGE plus CREATE in the scratch schema (resolution needs
    // USAGE); the runtime needs CREATE to replace, mirroring the vested app
    // schema after the transfer. The stranger gets nothing.
    for (const role of [builder, runtime, other]) {
      await admin.query(`grant usage, create on schema ${schema} to ${role}`);
    }
    // The owned function has the exact shape migration 0069 leaves behind:
    // PUBLIC revoked, migration owner retained — then ownership moves to the
    // runtime role (ALTER rewrites the old owner's grant entry to the new
    // owner). The foreign function is owned by someone else entirely.
    await as(builder, `create function ${schema}.${owned}() returns integer language plpgsql as $x$ begin return 1; end $x$`);
    await as(builder, `revoke execute on function ${schema}.${owned}() from public`);
    await as(other, `create function ${schema}.${foreign}() returns integer language plpgsql as $x$ begin return 1; end $x$`);
    await as(other, `revoke execute on function ${schema}.${foreign}() from public`);
    await admin.query(`alter function ${schema}.${owned}() owner to ${runtime}`);
    const shaped = await admin.query(
      "select proacl from pg_proc where proname = $1",
      [`${owned}`],
    );
    assert.equal(
      shaped.rows[0].proacl,
      `{${runtime}=X/${runtime}}`,
      "precondition: the transfer rewrites the old owner's grant to the runtime role",
    );

    const revoked = await revokeRuntimeFunctionExecute(admin, runtime, schema);
    assert.equal(revoked, 1, "only the foreign function is revoked, never the owned one");

    const verdict = await admin.query(
      `select has_function_privilege($1, '${schema}.${owned}()'::regprocedure, 'EXECUTE') as owner_keeps,
              has_function_privilege($1, '${schema}.${foreign}()'::regprocedure, 'EXECUTE') as foreign_denied,
              has_function_privilege($2, '${schema}.${owned}()'::regprocedure, 'EXECUTE') as stranger_owned_denied,
              has_function_privilege($2, '${schema}.${foreign}()'::regprocedure, 'EXECUTE') as stranger_foreign_denied`,
      [runtime, stranger],
    );
    assert.equal(verdict.rows[0].owner_keeps, true, "the owner keeps EXECUTE on its own function");
    assert.equal(
      verdict.rows[0].foreign_denied,
      false,
      "the runtime role cannot execute a function it does not own",
    );
    assert.equal(
      verdict.rows[0].stranger_owned_denied,
      false,
      "PUBLIC stays revoked: a stranger cannot execute the owned function",
    );
    assert.equal(
      verdict.rows[0].stranger_foreign_denied,
      false,
      "PUBLIC stays revoked: a stranger cannot execute the foreign function",
    );
    // The migration-replay path that first surfaced this needs replace rights.
    await as(
      runtime,
      `create or replace function ${schema}.${owned}() returns integer language plpgsql as $x$ begin return 2; end $x$`,
    );
  },
);
