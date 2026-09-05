import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env, withBypass } from "@openbooks/engine/src/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/test-fixtures.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    return nextResolve(specifier, context);
  },
});

for (const method of ["password", "new OIDC identity", "mapped OIDC identity"] as const) {
  test(`${method} observes MFA enabled while its user lock is pending`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    const priorSecret = env.SESSION_SECRET;
    env.SESSION_SECRET = "isolated-mfa-concurrency-regression-2026-09-05";
    let release = () => {};
    let held: Promise<unknown> | undefined;
    let contender: Promise<import("./auth").LoginResult> | undefined;
    try {
      const auth = await import("./auth");
      const { sealSecret } = await import("./secrets");
      const { generateTotpSecret, totpCode } = await import("./auth-totp");
      const userId = (await seedFlowActors(org.orgId)).adminId;
      const email = (await db.execute<{ email: string }>(sql`select email from users where id=${userId}`)).rows[0]!.email;
      const password = "Isolated MFA transition password 8945";
      await db.execute(sql`update orgs set env_kind='production' where id=${org.orgId}`);
      await db.execute(sql`update users set password_hash=${await auth.hashPassword(password)} where id=${userId}`);
      const issuer = "https://identity.example.test";
      if (method === "mapped OIDC identity") {
        await db.execute(sql`insert into auth_oidc_identities (issuer,subject,user_id,email_at_link)
          values (${issuer},${userId},${userId},${email})`);
      }
      const secret = generateTotpSecret();
      let staged!: () => void;
      const ready = new Promise<void>(resolve => { staged = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      let holderPid = 0;
      // Hold the same user → factor transaction boundary as MFA confirmation.
      held = withBypass(async () => {
        holderPid = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
        await db.execute(sql`select id from users where id=${userId} for update`);
        await db.execute(sql`insert into auth_mfa_factors (user_id,secret_encrypted,enabled_at)
          values (${userId},${sealSecret(secret)},now())`);
        staged();
        await hold;
      });
      await Promise.race([ready, held]);
      const context = { networkAddress: "127.0.0.1", userAgent: "isolated MFA concurrency test" };
      contender = method === "password" ? auth.login(email, password, context)
        : auth.finishOidcLogin({ issuer, subject: userId, email, emailVerified: true, context });
      let settled = false;
      void contender.then(() => { settled = true; }, () => { settled = true; });
      const deadline = Date.now() + 10_000;
      let blocked = false;
      while (!settled && Date.now() < deadline) {
        blocked = (await db.execute<{ blocked: boolean }>(sql`select exists(
          select 1 from pg_stat_activity where datname=current_database()
            and ${holderPid}=any(pg_blocking_pids(pid))
        ) as blocked`)).rows[0]!.blocked;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(blocked, "login must reach the held user lock before MFA commits");
      release();
      await held;
      const result = await contender;
      assert.equal(result.kind, "mfa_required", "newly enabled MFA must gate this login");
      assert.ok(result.kind === "mfa_required");
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from auth_sessions where user_id=${userId}`)).rows[0]!.n, 0);
      assert.equal((await auth.completeMfaLogin(result.challengeToken, totpCode(secret)!.code, context)).kind, "success");
    } finally {
      release();
      await Promise.allSettled([held, contender]);
      if (priorSecret === undefined) delete env.SESSION_SECRET;
      else env.SESSION_SECRET = priorSecret;
      await dropScratchOrg(org.orgId);
    }
  });
}
