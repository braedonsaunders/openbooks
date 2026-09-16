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
const { buildToolRegistry, executeAssistantTool } = await import('./registry');
const { ASSISTANT_TOOLS } = await import('./registry');
const { canRunTool } = await import('./gate');
const { resolvedFeatureState } = await import('../features');

/** Switch optional modules on, mirroring the contract harness feature flags. */
async function enableFeatures(orgId: string, keys: string[]): Promise<void> {
  const flags = Object.fromEntries(keys.map((key) => [key, true]));
  await db.execute(sql`
    update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||${JSON.stringify(flags)}::jsonb)
    where id = ${orgId}
  `);
}

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

test('find_tools searches the live gated catalog and names activated modules', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFeatures(org.orgId, ['inventory']);
    const authz = {
      user: userFor(org.orgId, 'find'),
      permissions: new Set(['assistant.use', 'assistant.write', 'gl.read', 'items.read', 'payroll.read', 'payroll.manage']),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(org.orgId, async () => {
      const result = await executeAssistantTool(authz, 'find_tools', { query: 'inventory' });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(result.ok);
      const data = result.data as { tools: { name: string; blurb: string; module: string }[]; modules: string[] };
      assert.ok(data.tools.length > 0 && data.tools.length <= 8, JSON.stringify(data.tools.map((t) => t.name)));
      assert.ok(
        data.tools.some((t) => t.name === 'inventory_levels'),
        JSON.stringify(data.tools.map((t) => t.name)),
      );
      assert.ok(data.modules.includes('inventory'), JSON.stringify(data.modules));
      for (const tool of data.tools) {
        assert.ok(typeof tool.blurb === 'string' && tool.blurb.length > 0, tool.name);
      }
      // Parity: everything returned is actually runnable by this actor.
      const features = await resolvedFeatureState(org.orgId);
      const byName = new Map(ASSISTANT_TOOLS.map((t) => [t.name, t]));
      for (const tool of data.tools) {
        const definition = byName.get(tool.name);
        if (!definition) continue; // application-catalog entries live elsewhere
        assert.equal(canRunTool(authz, definition, features), true, `${tool.name} listed but not runnable`);
      }
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('find_tools serves a module slice, an overview, and stable errors', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFeatures(org.orgId, ['payroll']);
    const authz = {
      user: userFor(org.orgId, 'slice'),
      permissions: new Set(['assistant.use', 'payroll.read']),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(org.orgId, async () => {
      const slice = await executeAssistantTool(authz, 'find_tools', { module: 'payroll' });
      assert.equal(slice.ok, true, JSON.stringify(slice));
      assert.ok(slice.ok);
      const tools = (slice.data as { tools: { name: string; module: string }[] }).tools;
      assert.ok(tools.length > 0);
      for (const tool of tools) assert.equal(tool.module, 'payroll');
      assert.deepEqual((slice.data as { modules: string[] }).modules, ['payroll']);

      const overview = await executeAssistantTool(authz, 'find_tools', {});
      assert.equal(overview.ok, true, JSON.stringify(overview));
      assert.ok(overview.ok);
      const modules = (overview.data as { modules: string[] }).modules;
      assert.ok(modules.includes('core') && modules.includes('payroll'), JSON.stringify(modules));

      const unknown = await executeAssistantTool(authz, 'find_tools', { module: 'no_such_module' });
      assert.deepEqual(unknown, { ok: false, error: `unknown module; use one of: ${[...modules].sort().join(', ')}` });

      const invalid = await executeAssistantTool(authz, 'find_tools', { limit: 99 });
      assert.deepEqual(invalid, { ok: false, error: 'invalid_input' });
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('find_tools activates modules through the chat ToolSet hook only', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFeatures(org.orgId, ['payroll']);
    const authz = {
      user: userFor(org.orgId, 'hook'),
      permissions: new Set(['assistant.use', 'payroll.read']),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(org.orgId, async () => {
      const features = await resolvedFeatureState(org.orgId);
      const captured: string[][] = [];
      const tools = buildToolRegistry(authz, features, {
        onActivateModules: (modules) => captured.push(modules),
      });
      const entry = tools['find_tools'] as unknown as {
        execute: (args: unknown) => Promise<{ ok: boolean }>;
      };
      assert.ok(entry && typeof entry.execute === 'function', 'find_tools must be registered');
      const result = await entry.execute({ query: 'pay run' });
      assert.equal(result.ok, true, JSON.stringify(result));
      // payroll must activate; ledger also matches because find_documents
      // searches pay runs (its blurb says so) — relevance, not noise.
      assert.ok(captured.length === 1 && captured[0]?.includes('payroll'), JSON.stringify(captured));

      // Without the hook (MCP, background agents) the same call only answers.
      const plain = buildToolRegistry(authz, features);
      const plainEntry = plain['find_tools'] as unknown as {
        execute: (args: unknown) => Promise<{ ok: boolean }>;
      };
      assert.equal((await plainEntry.execute({ query: 'pay run' })).ok, true);
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
