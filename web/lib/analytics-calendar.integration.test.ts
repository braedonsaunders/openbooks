import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({resolve(specifier,context,next){
  if(specifier === 'server-only')return {shortCircuit:true,url:'data:text/javascript,export {}'};
  if(specifier === '../money-server' && context.parentURL?.includes('/analytics/'))return {shortCircuit:true,url:'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}'};
  return next(specifier,context);
}});
const {withOrgContext} = await import('@openbooks/engine/src/db.ts');
const {createScratchOrg,dropScratchOrg} = await import('@openbooks/engine/src/test-fixtures.ts');
const {healthData} = await import('./analytics/health-data');
const {financialHealth} = await import('./analytics/financial-health');
const {customerData} = await import('./analytics/customer-data');
const {vendorData} = await import('./analytics/vendor-data');
const {spendVelocityData} = await import('./analytics/spend-velocity-data');
for(const name of ['health dashboard','health score','customer','vendor','spend'] as const){
  for(const range of [{from:'2024-02-01',to:'2024-02-29'},{from:'2024-02-29',to:'2024-03-31'},{from:'2024-03-01',to:'2024-03-31'}]){
    test(`Analytics calendar ${name}: ${range.from} to ${range.to}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
      const org=await createScratchOrg();
      try{
        await withOrgContext(org.orgId,async()=>{
          const period={...range,label:'Calendar review'};
          const result=name === 'health dashboard' ? await healthData(period,org.orgId,null)
            : name === 'health score' ? await financialHealth(period,undefined,org.orgId,null)
            : name === 'customer' ? await customerData(period,org.orgId,null)
            : name === 'vendor' ? await vendorData(period,org.orgId,null)
            : await spendVelocityData(org.orgId,period,null);
          assert.ok(result && typeof result === 'object');
        });
      }finally{await dropScratchOrg(org.orgId);}
    });
  }
}
