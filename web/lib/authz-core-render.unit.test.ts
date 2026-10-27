import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("re-resolved actor authority is shared within a server render and live everywhere else", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--no-concurrent-sparkplug",
      "--no-concurrent-recompilation",
      "--conditions=react-server",
      "--import=tsx",
      "--input-type=module",
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        OPENBOOKS_DB_URL: "",
        TSX_TSCONFIG_PATH: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
      },
      input: `
      import assert from 'node:assert/strict';
      import {registerHooks, createRequire} from 'node:module';
      import {PassThrough} from 'node:stream';
      import React from 'react';
      const state = {reads: [], active: true};
      globalThis[Symbol.for('openbooks.actor-render-test')] = state;
      const database = 'data:text/javascript,' + encodeURIComponent(
        'export const db={execute:async()=>{throw new Error("Unexpected query: super admins resolve without role reads")}};' +
        'export function pinnedTransactionExecutor(){return undefined;}'
      );
      const principal = 'data:text/javascript,' + encodeURIComponent(
        'export async function actorPrincipal(runner,orgId,userId){' +
        'const s=globalThis[Symbol.for("openbooks.actor-render-test")];' +
        's.reads.push({runner:runner.label??"db",orgId,userId});' +
        'return {id:userId,orgId,email:userId+"@example.test",name:userId,isActive:s.active,isSuperAdmin:true};}'
      );
      const authority = 'data:text/javascript,' + encodeURIComponent(
        'export async function extensionPermissionAvailability(){return {active:[],inactive:[]};}' +
        'export function denyInactiveExtensionPermissions(p){return p;}'
      );
      registerHooks({resolve(specifier, context, next) {
        if (specifier === '@openbooks/engine/platform/database') return {url:database,shortCircuit:true};
        if (specifier === '@openbooks/engine/organization/actor-permissions') return {url:principal,shortCircuit:true};
        if (specifier === '@openbooks/engine/organization/authority') return {url:authority,shortCircuit:true};
        return next(specifier, context);
      }});
      const {resolveAuthzByUserId} = await import('./lib/authz-core.ts');
      const require = createRequire(import.meta.url);
      const {renderToPipeableStream} = require('next/dist/compiled/react-server-dom-webpack/server.node');
      async function render(probe) {
        const sink = new PassThrough();
        sink.resume();
        const errors = [];
        const ended = new Promise((resolve,reject) => {sink.on('end',resolve);sink.on('error',reject);});
        renderToPipeableStream(React.createElement(async () => {await probe();return 'listed';}), {}, {
          onError: error => { errors.push(error); },
        }).pipe(sink);
        await ended;
        if(errors.length) throw errors[0];
      }
      await render(async () => {
        const [first, second] = await Promise.all([
          resolveAuthzByUserId('company-a','viewer'),
          resolveAuthzByUserId('company-a','viewer'),
        ]);
        assert.equal(first, second);
        assert.equal(await resolveAuthzByUserId('company-a','viewer'), first);
        const other = await resolveAuthzByUserId('company-a','approver');
        assert.equal(other.user.id, 'approver');
        const transaction = {label:'transaction', execute: async () => { throw new Error('unexpected'); }};
        await resolveAuthzByUserId('company-a','viewer',transaction);
        await resolveAuthzByUserId('company-a','viewer',transaction);
      });
      assert.deepEqual(state.reads.map(r => r.runner+':'+r.userId), [
        'db:viewer','db:approver','transaction:viewer','transaction:viewer',
      ], 'one read per actor in a render; a transaction runner always reads on its own client');
      state.reads = [];
      await render(async () => { await resolveAuthzByUserId('company-a','viewer'); });
      assert.equal(state.reads.length, 1, 'a new request re-resolves the actor');
      state.reads = [];
      state.active = false;
      assert.equal(await resolveAuthzByUserId('company-a','viewer'), null);
      assert.equal(await resolveAuthzByUserId('company-a','viewer'), null);
      assert.equal(state.reads.length, 2, 'API and background calls resolve live and fail closed on deactivation');
    `,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
