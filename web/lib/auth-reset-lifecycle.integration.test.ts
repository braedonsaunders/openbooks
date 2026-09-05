import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, env } from '@openbooks/engine/src/db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/test-fixtures.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
    return nextResolve(specifier, context);
  },
});

for (const scenario of ['pending login', 'pending enrollment', 'revoked enrollment'] as const) {
  test(`password reset invalidates ${scenario} from the previous credential`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    const priorSecret = env.SESSION_SECRET;
    env.SESSION_SECRET = randomBytes(32).toString('hex');
    try {
      const auth = await import('./auth');
      const { completePasswordReset } = await import('./auth-reset');
      const { sealSecret } = await import('./secrets');
      const { generateTotpSecret, totpCode } = await import('./auth-totp');
      const userId = (await seedFlowActors(org.orgId)).adminId;
      const email = (await db.execute<{ email: string }>(sql`select email from users where id=${userId}`)).rows[0]!.email;
      const oldPassword = 'Old isolated account password 2941';
      const newPassword = 'New isolated account password 7832';
      await db.execute(sql`update orgs set env_kind='production' where id=${org.orgId}`);
      await db.execute(sql`update users set password_hash=${await auth.hashPassword(oldPassword)} where id=${userId}`);
      const context = { networkAddress: '127.0.0.1', userAgent: 'isolated reset regression' };
      const secret = generateTotpSecret();
      if (scenario === 'pending login') {
        await db.execute(sql`insert into auth_mfa_factors (user_id,secret_encrypted,enabled_at) values (${userId},${sealSecret(secret)},now())`);
      }
      const login = await auth.login(email, oldPassword, context);
      let enrollment: Awaited<ReturnType<typeof auth.beginMfaSetup>> = null;
      let sessionId = '';
      if (scenario === 'pending login') {
        assert.equal(login.kind, 'mfa_required');
      } else {
        assert.equal(login.kind, 'success');
        assert.ok(login.kind === 'success');
        sessionId = (await auth.validateSessionToken(login.token))!.sessionId;
        enrollment = await auth.beginMfaSetup(userId, sessionId, oldPassword, context);
        assert.ok(enrollment);
      }
      if (scenario === 'revoked enrollment') {
        assert.equal(await auth.revokeUserSession(userId, sessionId), true);
        assert.equal(await auth.confirmMfaSetup(userId, sessionId, totpCode(enrollment!.secret)!.code), null);
        assert.equal((await auth.getMfaStatus(userId)).enabled, false);
        return;
      }
      const rawToken = randomBytes(32).toString('base64url');
      await db.execute(sql`insert into auth_password_resets (user_id,token_hash,expires_at) values (${userId},${createHash('sha256').update(rawToken).digest('hex')},now()+interval '30 minutes')`);
      assert.deepEqual(await completePasswordReset(rawToken, newPassword), { ok: true });
      if (scenario === 'pending login') {
        assert.ok(login.kind === 'mfa_required');
        assert.equal((await auth.completeMfaLogin(login.challengeToken, totpCode(secret)!.code, context)).kind, 'invalid');
        const fresh = await auth.login(email, newPassword, context);
        assert.ok(fresh.kind === 'mfa_required');
        assert.equal((await auth.completeMfaLogin(fresh.challengeToken, totpCode(secret)!.code, context)).kind, 'success');
      } else {
        assert.equal(await auth.confirmMfaSetup(userId, sessionId, totpCode(enrollment!.secret)!.code), null);
        assert.equal((await auth.getMfaStatus(userId)).enabled, false);
      }
      assert.equal((await auth.login(email, oldPassword, context)).kind, 'invalid');
      assert.deepEqual(await completePasswordReset(rawToken, newPassword), { ok: false, reason: 'invalid_token' });
    } finally {
      if (priorSecret === undefined) delete env.SESSION_SECRET;
      else env.SESSION_SECRET = priorSecret;
      await dropScratchOrg(org.orgId);
    }
  });
}
