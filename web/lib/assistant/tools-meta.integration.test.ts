import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';

const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
    }
    return nextResolve(path, context);
  }
  return nextResolve(specifier, context);
} });

const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { FEATURES } = await import('../features');
const { executeAssistantTool } = await import('./registry');
const { ASSISTANT_TOOLS } = await import('./registry');
const { canRunTool } = await import('./gate');
const { resolvedFeatureState } = await import('../features');

void sql;
void db;

function userFor(orgId: string, tag: string): SessionUser {
  const userId = randomUUID();
  return {
    id: userId,
    orgId,
    name: `Capability prober ${tag}`,
    email: `capability-${tag}@scratch.test`,
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
}

type CapabilityGroup = { module: string; tools: { name: string; blurb: string }[] };
type CapabilityData = {
  groups: CapabilityGroup[];
  featuresOff: string[];
  totalTools: number;
};

function toolNames(data: CapabilityData): Set<string> {
  return new Set(data.groups.flatMap((g) => g.tools.map((t) => t.name)));
}

test('describe_capabilities answers from the live catalog for a minimal reader', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const authz = { user: userFor(org.orgId, 'min'), permissions: new Set(['assistant.use']), allowedSubsidiaryIds: null };
    await withOrgContext(org.orgId, async () => {
      const result = await executeAssistantTool(authz, 'describe_capabilities', {});
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(result.ok);
      assert.ok(JSON.parse(JSON.stringify(result.data)));
      const data = result.data as CapabilityData;
      const names = toolNames(data);
      assert.ok(names.has('whoami'), 'live catalog must include whoami');
      assert.ok(names.has('describe_capabilities'), 'live catalog must include itself');
      assert.ok(!names.has('find_accounts'), 'gl-gated tool must be hidden without gl.read');
      assert.deepEqual(data.featuresOff, [...data.featuresOff].sort());
      const known = new Set(FEATURES.map((f) => f.key));
      for (const key of data.featuresOff) assert.ok(known.has(key), `unknown feature key ${key}`);
      // Parity: everything listed is actually runnable by this actor.
      const features = await resolvedFeatureState(org.orgId);
      const byName = new Map(ASSISTANT_TOOLS.map((t) => [t.name, t]));
      for (const name of names) {
        const definition = byName.get(name);
        if (!definition) continue; // application-catalog entries live elsewhere
        assert.equal(canRunTool(authz, definition, features), true, `${name} listed but not runnable`);
      }
      assert.equal(data.totalTools, names.size);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('describe_capabilities widens with the caller permissions', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const authz = {
      user: userFor(org.orgId, 'gl'),
      permissions: new Set(['assistant.use', 'gl.read']),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(org.orgId, async () => {
      const result = await executeAssistantTool(authz, 'describe_capabilities', {});
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(result.ok);
      assert.ok(toolNames(result.data as CapabilityData).has('find_accounts'));
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
