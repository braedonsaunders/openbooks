import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env, withBypass } from "@openbooks/engine/src/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/test-fixtures.ts";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });

for (const method of ["reset", "begin MFA", "confirm MFA"] as const) {
  for (const expires of [true, false]) {
    test(`${method} ${expires ? "refuses a credential expiring" : "accepts an unexpired credential"} while waiting for its user lock`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      const priorSecret = env.SESSION_SECRET;
      env.SESSION_SECRET = randomBytes(32).toString("hex");
      let release = () => {};
      let holder: Promise<void> | undefined;
      let contender: Promise<unknown> | undefined;
      try {
        const auth = await import("./auth");
        const { completePasswordReset } = await import("./auth-reset");
        const { sealSecret } = await import("./secrets");
        const { generateTotpSecret, totpCode } = await import("./auth-totp");
        const userId = (await seedFlowActors(org.orgId)).adminId;
        const password = "Isolated original password 8614";
        const originalHash = await auth.hashPassword(password);
        await db.execute(sql`update users set password_hash=${originalHash} where id=${userId}`);
        const sessionId = randomUUID();
        const rawToken = randomBytes(32).toString("base64url");
        const secret = generateTotpSecret();
        const duration = expires ? "1 second" : "30 minutes";
        if (method !== "reset") {
          await db.execute(sql`insert into auth_sessions(id,user_id,token_hash,auth_method,expires_at)
            values (${sessionId},${userId},${createHash("sha256").update(rawToken).digest("hex")},'password',clock_timestamp()+${duration}::interval)`);
          if (method === "confirm MFA") await db.execute(sql`
            insert into auth_mfa_factors(user_id,secret_encrypted,setup_session_id,setup_expires_at)
            values (${userId},${sealSecret(secret)},${sessionId},now()+interval '30 minutes')`);
        } else {
          await db.execute(sql`insert into auth_password_resets(user_id,token_hash,expires_at)
            values (${userId},${createHash("sha256").update(rawToken).digest("hex")},clock_timestamp()+${duration}::interval)`);
        }
        let staged!: () => void;
        const ready = new Promise<void>(resolve => { staged = resolve; });
        const hold = new Promise<void>(resolve => { release = resolve; });
        let holderPid = 0;
        holder = withBypass(async () => {
          holderPid = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
          await db.execute(sql`select id from users where id=${userId} for update`);
          staged();
          await hold;
        });
        await Promise.race([ready, holder]);
        contender = method === "reset" ? completePasswordReset(rawToken, "Isolated replacement password 7861")
          : method === "begin MFA" ? auth.beginMfaSetup(userId, sessionId, password, { networkAddress: "127.0.0.1", userAgent: "expiry regression" })
          : auth.confirmMfaSetup(userId, sessionId, totpCode(secret)!.code);
        let settled = false;
        void contender.then(() => { settled = true; }, () => { settled = true; });
        let blocked = false;
        const deadline = Date.now() + 5000;
        while (!settled && Date.now() < deadline) {
          blocked = (await db.execute<{ blocked: boolean }>(sql`select exists(
            select 1 from pg_stat_activity where datname=current_database() and ${holderPid}=any(pg_blocking_pids(pid))
          ) as blocked`)).rows[0]!.blocked;
          if (blocked) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(blocked, "the credential must still be valid when the operation starts waiting");
        if (expires) {
          let expired = false;
          while (Date.now() < deadline) {
            expired = (await db.execute<{ expired: boolean }>(method === "reset"
              ? sql`select expires_at <= clock_timestamp() as expired from auth_password_resets where user_id=${userId}`
              : sql`select expires_at <= clock_timestamp() as expired from auth_sessions where id=${sessionId}`)).rows[0]!.expired;
            if (expired) break;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.ok(expired, "release only after PostgreSQL confirms real credential expiry");
        }
        release();
        await holder;
        const result = await contender;
        if (method === "reset") {
          assert.deepEqual(result, expires ? { ok: false, reason: "invalid_token" } : { ok: true });
          if (expires) assert.equal((await db.execute<{ password_hash: string }>(sql`select password_hash from users where id=${userId}`)).rows[0]!.password_hash, originalHash);
        } else {
          if (expires) assert.equal(result, null);
          else assert.ok(result);
          const factor = (await db.execute<{ enabled_at: string | null }>(sql`select enabled_at from auth_mfa_factors where user_id=${userId}`)).rows[0];
          if (method === "begin MFA" && expires) assert.equal(factor, undefined);
          if (method === "confirm MFA") assert.equal(Boolean(factor?.enabled_at), !expires);
        }
      } finally {
        release();
        await Promise.allSettled([holder, contender]);
        if (priorSecret === undefined) delete env.SESSION_SECRET;
        else env.SESSION_SECRET = priorSecret;
        await dropScratchOrg(org.orgId);
      }
    });
  }
}
