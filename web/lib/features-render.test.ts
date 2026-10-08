import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('feature questions share render facts while later renders and live executors observe changes', () => {
  const result = spawnSync(process.execPath, [
    '--no-concurrent-sparkplug', '--no-concurrent-recompilation',
    '--conditions=react-server', '--import=tsx', '--import=../scripts/test-hooks.mjs', '--input-type=module',
  ], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, OPENBOOKS_DB_URL: '', TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) },
    input: `
      import assert from 'node:assert/strict';
      import {createRequire} from 'node:module';
      import {PassThrough} from 'node:stream';
      import React from 'react';
      import {PgDialect} from 'drizzle-orm/pg-core';
      const {db}=await import('@openbooks/engine/src/platform/db.ts');
      const {isFeatureEnabled,orgFeatureState,resolvedFeatureState}=await import('./lib/features.ts');
      const {isFeatureEnabled:engineFeatureEnabled}=await import('@openbooks/engine/src/organization/feature-state.ts');
      const dialect=new PgDialect();
      const facts=new Map([
        ['company-a',{state:{projects:true,preBilling:true},subsidiaries:2,currency:true}],
        ['company-b',{state:{projects:false,preBilling:true,multiSubsidiary:false,multiCurrency:false},subsidiaries:3,currency:true}],
      ]);
      const calls=[];
      let unavailable=false;
      db.execute=async query=>{
        const {sql,params}=dialect.sqlToQuery(query);
        const org=params.find(value=>typeof value==='string'&&value.startsWith('company-'));
        assert.ok(facts.has(org),'every fact is scoped to an organization');
        calls.push({sql,org});
        const current=facts.get(org);
        if(sql.includes("settings->'features' as f")) {
          if(unavailable)throw new Error('feature settings unavailable');
          return {rows:[{f:structuredClone(current.state)}]};
        }
        if(sql.includes('from subsidiaries'))return {rows:[{n:current.subsidiaries}]};
        if(sql.includes('from journal_lines')&&sql.includes('from fx_rates'))return {rows:[{on:current.currency}]};
        throw new Error('Unexpected query: '+sql);
      };
      const require=createRequire(import.meta.url);
      const {renderToPipeableStream}=require('next/dist/compiled/react-server-dom-webpack/server.node');
      async function render(probe){
        const sink=new PassThrough();sink.resume();const errors=[];
        const ended=new Promise((resolve,reject)=>{sink.on('end',resolve);sink.on('error',reject);});
        renderToPipeableStream(React.createElement(async()=>{await probe();return 'rendered';}),{}, {onError:error=>errors.push(error)}).pipe(sink);
        await ended;if(errors.length)throw errors[0];
      }
      const count=(org,source)=>calls.filter(call=>call.org===org&&call.sql.includes(source)).length;
      await render(async()=>{
        const [project,child,raw,resolved,subsidiary,currency]=await Promise.all([
          isFeatureEnabled('company-a','projects'),isFeatureEnabled('company-a','preBilling'),
          orgFeatureState('company-a'),resolvedFeatureState('company-a'),
          isFeatureEnabled('company-a','multiSubsidiary'),isFeatureEnabled('company-a','multiCurrency'),
        ]);
        assert.equal(project,true);assert.equal(child,true);
        assert.equal(subsidiary,true);assert.equal(currency,true);
        assert.equal(resolved.multiSubsidiary,true);assert.equal(resolved.multiCurrency,true);
        raw.projects=false;resolved.projects=false;
        assert.equal((await orgFeatureState('company-a')).projects,true,'returned copies cannot poison render facts');
        assert.equal((await resolvedFeatureState('company-a')).projects,true);
      });
      assert.equal(count('company-a',"settings->'features'"),1);
      assert.equal(count('company-a','from subsidiaries'),1);
      assert.equal(count('company-a','from journal_lines'),1);
      await render(async()=>{
        const [resolved,child]=await Promise.all([resolvedFeatureState('company-b'),isFeatureEnabled('company-b','preBilling')]);
        assert.equal(child,false,'a child override cannot resurrect a disabled parent');
        assert.equal(resolved.multiSubsidiary,false);assert.equal(resolved.multiCurrency,false);
      });
      assert.equal(count('company-b',"settings->'features'"),1);
      assert.equal(count('company-b','from subsidiaries'),0,'explicit overrides bypass data-dependent defaults');
      assert.equal(count('company-b','from journal_lines'),0);
      facts.get('company-a').state.projects=false;
      facts.get('company-a').subsidiaries=1;facts.get('company-a').currency=false;
      await render(async()=>{
        assert.equal(await isFeatureEnabled('company-a','preBilling'),false);
        const resolved=await resolvedFeatureState('company-a');
        assert.equal(resolved.multiSubsidiary,false);assert.equal(resolved.multiCurrency,false);
      });
      assert.equal(count('company-a',"settings->'features'"),2,'a later render reads fresh state');
      const before=count('company-a',"settings->'features'");
      await render(async()=>{
        assert.equal(await isFeatureEnabled('company-a','projects',db),false);
        facts.get('company-a').state.projects=true;
        assert.equal(await isFeatureEnabled('company-a','projects',db),true,'transaction-bound checks stay live within a render');
        assert.equal(await engineFeatureEnabled('company-a','projects',db),true);
        facts.get('company-a').state.projects=false;
        assert.equal(await engineFeatureEnabled('company-a','projects',db),false,'engine authority stays live');
      });
      assert.equal(count('company-a',"settings->'features'"),before+4);
      assert.equal(await isFeatureEnabled('company-a','projects'),false);
      facts.get('company-a').state.projects=true;
      assert.equal(await isFeatureEnabled('company-a','projects'),true,'standalone API/action reads do not share render facts');
      assert.equal(count('company-a',"settings->'features'"),before+6);
      unavailable=true;
      await render(async()=>{
        const results=await Promise.allSettled([isFeatureEnabled('company-a','projects'),isFeatureEnabled('company-a','payroll')]);
        assert.ok(results.every(result=>result.status==='rejected'&&result.reason.message==='feature settings unavailable'),'read failure refuses every dependent feature');
      });
      assert.equal(count('company-a',"settings->'features'"),before+7);
      unavailable=false;
      await render(async()=>assert.equal(await isFeatureEnabled('company-a','projects'),true));
      assert.equal(count('company-a',"settings->'features'"),before+8,'a new render retries failed reads');
    `,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
