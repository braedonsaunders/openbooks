// Run with: node --import tsx --test web/lib/apps/store-audit.test.ts
//
// The source-level checks stay runnable without PostgreSQL (and guard the
// ordering that makes the evidence durable). When a test database is
// available, the integration cases below exercise the actual store entry
// points and verify rollback, audit evidence, and immutable revisions.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context)
    }
    return nextResolve(specifier, context)
  },
})

const storeSource = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')
const routeSource = readFileSync(new URL('../../app/api/apps/[key]/route.ts', import.meta.url), 'utf8')

function functionBody(source: string, name: string): string {
  const exported = source.indexOf(`export async function ${name}`)
  const privateFunction = source.indexOf(`async function ${name}`)
  const start = exported >= 0 ? exported : privateFunction
  assert.notEqual(start, -1, `${name} must remain defined`)
  const end = source.indexOf('\nexport ', start + 1)
  return source.slice(start, end === -1 ? undefined : end)
}

function errorMessage(error: unknown): string {
  let current: unknown = error
  const messages: string[] = []
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    messages.push(current.message)
    current = (current as Error & { cause?: unknown }).cause
  }
  return messages.join(': ')
}

function registerSourceTests(): void {
  test('uninstall captures every cascading app row before the delete, with before/after evidence', () => {
    const body = functionBody(storeSource, 'deleteApp')
    const versions = body.indexOf('from app_versions')
    const files = body.indexOf('from app_files')
    const runs = body.indexOf('from app_runs')
    const storage = body.indexOf('from app_storage')
    const audit = body.indexOf("event: 'app_uninstall'")
    const deleteIndex = body.indexOf('delete from apps')

    assert.match(body, /await db\.transaction\(async \(tx\) =>/)
    assert.ok(versions >= 0 && files > versions && runs > files && storage > runs)
    assert.ok(audit > storage, 'the audit insert must follow all evidence reads')
    assert.ok(deleteIndex > audit, 'the destructive cascade must be last')
    assert.match(body, /versions: versions\.rows/)
    assert.match(body, /files: files\.rows/)
    assert.match(body, /runs: runs\.rows/)
    assert.match(body, /storage: storage\.rows/)
    assert.match(body, /before:\s*\{/)
    assert.match(body, /after: preserveHistory \? \{ status: 'disabled', historyPreserved: true \} : null/)
    assert.match(body, /actor_id\)/)
  })

  test('status transitions carry actor and before/after evidence in the same transaction', () => {
    const body = functionBody(storeSource, 'setAppStatus')
    const update = body.indexOf('update apps')
    const audit = body.indexOf('insert into audit_log')
    assert.match(body, /userId: string/)
    assert.match(body, /for update/)
    assert.match(body, /event: 'app_status_changed'/)
    assert.match(body, /before: \{ key: app\.key, name: app\.name, status: app\.status \}/)
    assert.match(body, /after: \{ key: app\.key, name: app\.name, status \}/)
    assert.ok(update >= 0 && audit > update)
    assert.match(routeSource, /setAppStatus\(gate\.user\.orgId, gate\.user\.id, key, body\.status\)/)
  })

  test('package versions have one installer and no activated-source editing entry points', () => {
    for (const name of ['createAppScaffold','updateAppMeta','writeAppFile','deleteAppFile']) assert.doesNotMatch(storeSource,new RegExp(`export async function ${name}\\(`))
    assert.match(functionBody(storeSource,'installApp'),/insert into app_versions/)
    assert.match(routeSource,/setAppStatus/)
  })

}

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

if (DB) {
  const { sql } = await import('drizzle-orm')
  const { db, withBypass, withOrgContext, env } = await import('@openbooks/engine/src/db.ts')
  const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
    '@openbooks/engine/src/test-fixtures.ts',
  )
  const {
    deleteApp,
    getAppByKey,
    installApp,
    setAppStatus,
  } = await import('./store.ts')

  // Register the entire queue after imports; --test-force-exit must not
  // finish source checks while database cases are still being loaded.
  registerSourceTests()

  assert.ok(env.OPENBOOKS_DB_URL)

  async function seedApp() {
    const org = await withBypass(() => createScratchOrg())
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId
    const key = `audit-proof-${org.orgId.slice(0, 8)}`
    await withBypass(() =>
      installApp(org.orgId, actorId, {
        manifest: {
          key,
          name: 'Audit Proof',
          version: '1.0.0',
          description: 'evidence test',
          permissions: [],
          frontend: { entry: 'frontend/index.html' },
          endpoints: [{ name: 'hello', file: 'backend/hello.js', method: 'POST' }],
        },
        files: [
          { path: 'frontend/index.html', content: '<html>proof</html>' },
          { path: 'frontend/styles.css', content: 'body { color: black }' },
          { path: 'backend/hello.js', content: 'function handler() { return { ok: true } }' },
        ],
      }),
    )
    return { org, actorId, key }
  }

  test('uninstall leaves an append-only snapshot and rolls back when its audit write is refused', async () => {
    const fx = await seedApp()
    const triggerName = `apps_uninstall_audit_${fx.org.orgId.replaceAll('-', '')}`
    const functionName = `apps_uninstall_audit_fn_${fx.org.orgId.replaceAll('-', '')}`
    try {
      const app = (await withBypass(() => getAppByKey(fx.org.orgId, fx.key)))!
      await withBypass(async () => {
        await db.execute(sql`
          insert into app_runs (org_id, app_id, version_id, endpoint, status, units, logs, actor_id)
          values (${fx.org.orgId}, ${app.id}, ${app.activeVersionId}, 'hello', 'ok', 3,
                  '["ran"]'::jsonb, ${fx.actorId})`)
        await db.execute(sql`
          insert into app_storage (org_id, app_id, namespace, key, value, created_by, updated_by)
          values (${fx.org.orgId}, ${app.id}, 'proof', 'answer', '{"ok":true}'::jsonb,
                  ${fx.actorId}, ${fx.actorId})`)
      })

      await withBypass(async () => {
        await db.execute(sql`
          create function ${sql.identifier(functionName)}() returns trigger language plpgsql as $$
          begin
            if new.table_name = 'apps' and new.action = 'delete' then
              raise exception 'forced app audit failure';
            end if;
            return new;
          end $$`)
        await db.execute(sql`
          create trigger ${sql.identifier(triggerName)}
            before insert on audit_log for each row
            execute function ${sql.identifier(functionName)}()`)
      })
      try {
        // deleteApp resolves its row through the ambient scope: unscoped it
        // silently no-ops (no row found, no audit) and the refusal below
        // would vacuously pass. The org scope reproduces the route.
        await assert.rejects(
          withOrgContext(fx.org.orgId, () => deleteApp(fx.org.orgId, fx.actorId, fx.key)),
          (error: unknown) => /forced app audit failure/.test(errorMessage(error)),
        )
      } finally {
        await withBypass(async () => {
          await db.execute(sql`drop trigger if exists ${sql.identifier(triggerName)} on audit_log`)
          await db.execute(sql`drop function if exists ${sql.identifier(functionName)}()`)
        })
      }

      assert.ok(await withBypass(() => getAppByKey(fx.org.orgId, fx.key)))
      const beforeDelete = await withBypass(() =>
        db.execute<{ n: string }>(sql`
          select count(*)::text as n from audit_log
           where org_id = ${fx.org.orgId} and action = 'delete'
             and changes->>'event' = 'app_uninstall'`),
      )
      assert.equal(beforeDelete.rows[0]!.n, '0')

      // Same ambient-scope class as the refusal call above: deleteApp resolves
      // its row through the ambient scope, so the real uninstall needs the
      // org scope too — unscoped it silently no-ops and leaves no evidence.
      await withOrgContext(fx.org.orgId, () => deleteApp(fx.org.orgId, fx.actorId, fx.key))
      const evidence = await withBypass(() =>
        db.execute<{
          actorId: string
          changes: {
            before: {
              versions: unknown[]
              files: unknown[]
              runs: unknown[]
              storage: unknown[]
            }
            after: unknown
          }
        }>(sql`
          select actor_id as "actorId", changes
            from audit_log
           where org_id = ${fx.org.orgId} and action = 'delete'
             and changes->>'event' = 'app_uninstall'
           order by at desc limit 1`),
      )
      assert.equal(evidence.rows.length, 1)
      assert.equal(evidence.rows[0]!.actorId, fx.actorId)
      assert.equal(evidence.rows[0]!.changes.after, null)
      assert.equal(evidence.rows[0]!.changes.before.versions.length, 1)
      assert.equal(evidence.rows[0]!.changes.before.files.length, 3)
      assert.equal(evidence.rows[0]!.changes.before.runs.length, 1)
      assert.equal(evidence.rows[0]!.changes.before.storage.length, 1)
      assert.equal(await withBypass(() => getAppByKey(fx.org.orgId, fx.key)), null)
    } finally {
      await withBypass(() => dropScratchOrg(fx.org.orgId))
    }
  })

  test('status changes are actor-audited and audit refusal leaves the status unchanged', async () => {
    const fx = await seedApp()
    const triggerName = `apps_status_audit_${fx.org.orgId.replaceAll('-', '')}`
    const functionName = `apps_status_audit_fn_${fx.org.orgId.replaceAll('-', '')}`
    try {
      await withOrgContext(fx.org.orgId, () => setAppStatus(fx.org.orgId, fx.actorId, fx.key, 'disabled'))
      const disabled = await withBypass(() => getAppByKey(fx.org.orgId, fx.key))
      assert.equal(disabled?.status, 'disabled')
      const audited = await withBypass(() =>
        db.execute<{ actorId: string; changes: { before: { status: string }; after: { status: string } } }>(sql`
          select actor_id as "actorId", changes from audit_log
           where org_id = ${fx.org.orgId} and action = 'update'
             and changes->>'event' = 'app_status_changed'
           order by at desc limit 1`),
      )
      assert.equal(audited.rows[0]!.actorId, fx.actorId)
      assert.deepEqual(audited.rows[0]!.changes.before.status, 'installed')
      assert.deepEqual(audited.rows[0]!.changes.after.status, 'disabled')

      await withBypass(async () => {
        await db.execute(sql`
          create function ${sql.identifier(functionName)}() returns trigger language plpgsql as $$
          begin
            if new.changes->>'event' = 'app_status_changed' then
              raise exception 'forced status audit failure';
            end if;
            return new;
          end $$`)
        await db.execute(sql`
          create trigger ${sql.identifier(triggerName)}
            before insert on audit_log for each row
            execute function ${sql.identifier(functionName)}()`)
      })
      try {
        await assert.rejects(
          withOrgContext(fx.org.orgId, () => setAppStatus(fx.org.orgId, fx.actorId, fx.key, 'installed')),
          (error: unknown) => /forced status audit failure/.test(errorMessage(error)),
        )
      } finally {
        await withBypass(async () => {
          await db.execute(sql`drop trigger if exists ${sql.identifier(triggerName)} on audit_log`)
          await db.execute(sql`drop function if exists ${sql.identifier(functionName)}()`)
        })
      }
      assert.equal((await withBypass(() => getAppByKey(fx.org.orgId, fx.key)))?.status, 'disabled')
    } finally {
      await withBypass(() => dropScratchOrg(fx.org.orgId))
    }
  })

  test('reviewed package revisions preserve historical metadata and executed files', async () => {
    const fx=await seedApp()
    try {
      const original=(await withBypass(()=>getAppByKey(fx.org.orgId,fx.key)))!
      const files=(await withBypass(()=>db.execute<{path:string;content:string;isBinary:boolean}>(sql`select path,content,is_binary as "isBinary" from app_files where org_id=${fx.org.orgId} and version_id=${original.activeVersionId}`))).rows
      const before=files.find(file=>file.path==='frontend/styles.css')!.content
      const editedFiles=files.map(file=>file.path==='frontend/styles.css'?{...file,content:'body { color: blue }'}:file)
      await withBypass(()=>installApp(fx.org.orgId,fx.actorId,{manifest:{...original.manifest!,name:'Renamed Proof',version:'2.0.0'},files:editedFiles}))
      const edited=(await withBypass(()=>getAppByKey(fx.org.orgId,fx.key)))!
      assert.notEqual(edited.activeVersionId,original.activeVersionId)
      assert.equal(edited.name,'Renamed Proof')
      const historical=(await withBypass(()=>db.execute<{status:string;manifest:{name:string}}>(sql`select status,manifest from app_versions where id=${original.activeVersionId}`))).rows[0]!
      assert.equal(historical.status,'superseded');assert.equal(historical.manifest.name,original.name)
      const css=(await withBypass(()=>db.execute<{version_id:string;content:string}>(sql`select version_id,content from app_files where org_id=${fx.org.orgId} and path='frontend/styles.css'`))).rows
      assert.equal(css.find(file=>file.version_id===original.activeVersionId)!.content,before)
      assert.equal(css.find(file=>file.version_id===edited.activeVersionId)!.content,'body { color: blue }')
      await withBypass(()=>installApp(fx.org.orgId,fx.actorId,{manifest:{...edited.manifest!,version:'3.0.0'},files:editedFiles.filter(file=>file.path!=='frontend/styles.css')}))
      const removed=(await withBypass(()=>getAppByKey(fx.org.orgId,fx.key)))!
      const retained=(await withBypass(()=>db.execute<{version_id:string}>(sql`select version_id from app_files where org_id=${fx.org.orgId} and path='frontend/styles.css'`))).rows
      assert.ok(retained.some(file=>file.version_id===edited.activeVersionId));assert.ok(!retained.some(file=>file.version_id===removed.activeVersionId))
    } finally { await withBypass(()=>dropScratchOrg(fx.org.orgId)) }
  })

} else {
  registerSourceTests()
}
