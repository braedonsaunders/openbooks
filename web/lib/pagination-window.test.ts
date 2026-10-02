import assert from 'node:assert/strict'
import test from 'node:test'
import { paginationWindow } from './pagination-window'
test('bounded pagination never invents a total and retains the actual loaded range',()=>{
  const window=paginationWindow({total:null,page:3,perPage:100,loadedCount:4,hasMore:true})
  assert.deepEqual(window,{unknownTotal:true,visibleCount:4,pageCount:4,from:201,to:204,isOutOfRange:false})
  assert.equal(paginationWindow({total:null,page:3,perPage:100,loadedCount:4}).pageCount,3)
  assert.equal(paginationWindow({total:null,page:3,perPage:100,loadedCount:0}).to,0)
})
test('unknown pagination refuses missing, oversized and fractional counts',()=>{
  for(const loadedCount of [undefined,-1,101,0.5,NaN]) assert.throws(()=>paginationWindow({total:null,page:1,perPage:100,loadedCount}),/loaded row count/)
  assert.throws(()=>paginationWindow({total:null,page:0,perPage:100,loadedCount:1}),/valid page/)
})
test('known totals retain the final range and out-of-range recovery',()=>{
  assert.equal(paginationWindow({total:204,page:3,perPage:100}).to,204)
  assert.equal(paginationWindow({total:204,page:4,perPage:100}).isOutOfRange,true)
})
