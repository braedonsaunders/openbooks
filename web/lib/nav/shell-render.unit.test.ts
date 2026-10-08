import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// React's cache must be exercised by an actual server render. The standalone
// runner deliberately has no request cache and cannot prove these boundaries.
test('menus share source reads within a render and recheck organization and role authority on the next render', () => {
  const result = spawnSync(process.execPath, [
    '--no-concurrent-sparkplug', '--no-concurrent-recompilation',
    '--conditions=react-server', '--import=tsx', '--import=../scripts/test-hooks.mjs', '--input-type=module',
  ], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, OPENBOOKS_DB_URL: '', TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)) },
    input: `
      import assert from 'node:assert/strict';
      import {registerHooks,createRequire} from 'node:module';
      import {PassThrough} from 'node:stream';
      import React from 'react';
      import {PgDialect} from 'drizzle-orm/pg-core';
      registerHooks({resolve(specifier,context,next) {
        if(specifier==='next-intl/server') return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export async function getTranslations(){return key=>key;}')};
        return next(specifier,context);
      }});
      const {db} = await import('@openbooks/engine/src/platform/db.ts');
      const {FEATURES} = await import('@openbooks/engine/src/organization/feature-registry.ts');
      const {defaultNavConfig} = await import('./lib/nav/registry.ts');
      const {resolveNav} = await import('./lib/nav/resolve.ts');
      const {resolveLocalNavigation} = await import('./lib/nav/local.ts');
      const {navigationExtensionContributions,savedNavigationConfig} = await import('./lib/nav/config.ts');
      const dialect=new PgDialect();
      const calls=[];
      let recordRoles=['auditor'];
      let config=defaultNavConfig();
      db.execute=async query=>{
        const {sql,params}=dialect.sqlToQuery(query);
        const org=params.find(value=>typeof value==='string'&&value.startsWith('company-'));
        assert.ok(org,'each navigation read is organization-scoped: '+sql);
        calls.push({sql,org});
        if(sql.includes('from org_nav_configs')) return {rows:[{config,updated_at:new Date()}]};
        if(sql.includes("settings->'features' as f")) return {rows:[{f:Object.fromEntries(FEATURES.map(feature=>[feature.key,!['multiSubsidiary','multiCurrency'].includes(feature.key)]))}]};
        if(sql.includes('from apps m')||sql.includes('from apps a')) return {rows:[]};
        if(sql.includes('from custom_record_types')) return {rows:[{key:'restricted',plural_name:org+' records',icon_key:'File',allowed_roles:recordRoles}]};
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
      async function probe(org,role,visible){
        const [first,second,local]=await Promise.all([
          resolveNav(org,()=>true,[role],key=>key),
          resolveNav(org,()=>true,[role],key=>key),
          resolveLocalNavigation({user:{orgId:org},permissions:new Set(['*'])}),
          navigationExtensionContributions(org),savedNavigationConfig(org),
        ]);
        assert.deepEqual(first,second);
        assert.equal(first.flatMap(group=>group.items).some(item=>item.href==='/records/restricted'),visible);
        assert.ok(local.groups.length>0);
      }
      await render(()=>probe('company-a','auditor',true));
      const count=(org,source)=>calls.filter(call=>call.org===org&&call.sql.includes(source)).length;
      for(const source of ['from org_nav_configs','from apps m','from apps a','from custom_record_types']) assert.equal(count('company-a',source),1,source+' shared within render');
      recordRoles=['manager'];
      await render(()=>probe('company-a','auditor',false));
      for(const source of ['from org_nav_configs','from apps m','from apps a','from custom_record_types']) assert.equal(count('company-a',source),2,source+' refreshed on next render');
      await render(()=>probe('company-b','manager',true));
      for(const source of ['from org_nav_configs','from apps m','from apps a','from custom_record_types']) assert.equal(count('company-b',source),1,source+' keyed by organization');
      const before=count('company-a','from org_nav_configs');
      await savedNavigationConfig('company-a');await savedNavigationConfig('company-a');
      assert.equal(count('company-a','from org_nav_configs'),before+2,'standalone calls keep live reads');
    `,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
