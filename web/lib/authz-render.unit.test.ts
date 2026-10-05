import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('server renders share authority without retaining it across requests or verified frames', () => {
  const result = spawnSync(process.execPath, [
    '--no-concurrent-sparkplug', '--no-concurrent-recompilation',
    '--conditions=react-server', '--import=tsx', '--input-type=module',
  ], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, OPENBOOKS_DB_URL: '', TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) },
    input: `
      import assert from 'node:assert/strict';
      import {registerHooks, createRequire} from 'node:module';
      import {PassThrough} from 'node:stream';
      import React from 'react';
      const state = {reads: 0, user: null, error: null};
      globalThis[Symbol.for('openbooks.authority-render-test')] = state;
      const database = 'data:text/javascript,' + encodeURIComponent(
        'export const db={execute:async()=>({rows:[]})};' +
        'export const ambientTenantOrgId=()=>null;' +
        'const unexpected=()=>{throw new Error("Unexpected database operation during authority rendering");};' +
        'export const withOrgTransaction=unexpected,withOrgContext=unexpected,withOrg=unexpected,' +
        'withMaintenanceTransaction=unexpected,withBypass=unexpected,withBypassContext=unexpected,' +
        'inDbTransaction=unexpected,inExecutorTransaction=unexpected,withTransactionSavepoint=unexpected,' +
        'connectBypassLongClient=unexpected,connectGovernedReadClient=unexpected,' +
        'registerRequestOrgResolver=unexpected,currentRequestOrgResolver=unexpected,' +
        'ambientBypassWithoutTransaction=unexpected,assertSafeRuntimeDatabaseRole=unexpected;' +
        'export const env={},pool={},orgContext={getStore:()=>undefined};'
      );
      const identity = 'data:text/javascript,' + encodeURIComponent(
        'export async function currentUser(){' +
        'const s=globalThis[Symbol.for("openbooks.authority-render-test")];' +
        's.reads++;if(s.error)throw s.error;return s.user;}'
      );
      registerHooks({resolve(specifier, context, next) {
        if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts'))
          return {url:identity,shortCircuit:true};
        if (specifier.endsWith('/platform/db.ts') || specifier === '@openbooks/engine/platform/database')
          return {url:database,shortCircuit:true};
        return next(specifier, context);
      }});
      const {getAuthz, can} = await import('./lib/authz.ts');
      const {withAuthzContext} = await import('./lib/authz-context.ts');
      const require = createRequire(import.meta.url);
      const {renderToPipeableStream} = require('next/dist/compiled/react-server-dom-webpack/server.node');
      const user = orgId => ({id:'operator',orgId,isSuperAdmin:true});
      async function render(probe) {
        const sink = new PassThrough();
        sink.resume();
        const errors = [];
        const ended = new Promise((resolve,reject) => {sink.on('end',resolve);sink.on('error',reject);});
        renderToPipeableStream(React.createElement(async () => {await probe();return 'authorized';}), {}, {
          onError: error => errors.push(error),
        }).pipe(sink);
        await ended;
        if(errors.length) throw errors[0];
      }
      async function probe(orgId) {
        const [first,second] = await Promise.all([getAuthz(),getAuthz()]);
        assert.equal(first,second);
        assert.equal(first?.user.orgId ?? null,orgId);
      }
      state.user = user('company-a');
      await render(async () => {
        await probe('company-a');
        const verified = {user:user('restricted-company'),permissions:new Set(['reports.read']),allowedSubsidiaryIds:new Set(['entity-a'])};
        await withAuthzContext(verified,async () => {
          const scoped = await getAuthz();
          assert.equal(scoped.user.orgId,'restricted-company');
          assert.deepEqual([...scoped.allowedSubsidiaryIds],['entity-a']);
          assert.equal(can(scoped,'payroll.post'),false);
        });
        await probe('company-a');
      });
      assert.equal(state.reads,1);
      state.user = user('company-b');
      await render(() => probe('company-b'));
      assert.equal(state.reads,2);
      state.user = null;
      await render(() => probe(null));
      assert.equal(state.reads,3);
      state.user = user('company-c');
      await getAuthz();await getAuthz();
      assert.equal(state.reads,5,'API/background calls must not retain a render snapshot');
      state.error = new Error('Session validation unavailable');
      await render(async () => {
        const results = await Promise.allSettled([getAuthz(),getAuthz()]);
        assert.ok(results.every(result => result.status === 'rejected' && result.reason.message === state.error.message));
      });
      assert.equal(state.reads,6);
      state.error = null;
      await render(() => probe('company-c'));
      assert.equal(state.reads,7,'a failed prior render must not poison the next request');
    `,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
