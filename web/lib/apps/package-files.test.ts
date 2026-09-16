import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppStarter } from './starter'
import { packageFromSourceFiles, packageSourceFiles, nextAppVersion, validPackagePath } from './package-files'
import { parseManifest, validateBundle } from './manifest'
import { parseNativeExtension } from './native-ui'

test('both app starters validate against actual renderer contracts and roundtrip source without duplicate manifest', () => {
  for (const renderer of ['native','sandbox'] as const) {
    const bundle = createAppStarter(renderer)
    const parsed = parseManifest(bundle.manifest)
    assert.equal(parsed.ok, true, parsed.errors.join('; '))
    assert.equal(validateBundle(parsed.manifest!, bundle.files.map(file => file.path)).ok,true)
    if (renderer === 'native') assert.equal(parseNativeExtension(bundle.files[0]!.content,parsed.manifest).screens.length,1)
    assert.deepEqual(packageFromSourceFiles(packageSourceFiles(bundle)),bundle)
  }
})
test('package editing preserves binary bytes and explicit denied grants and rejects missing entry or unsafe paths', () => {
  const bundle = createAppStarter('sandbox')
  bundle.files.push({ path:'assets/image.png',content:'AAEC/w==',isBinary:true })
  assert.deepEqual(packageFromSourceFiles(packageSourceFiles(bundle),[]),{...bundle,grantedPermissions:[]})
  for (const path of ['../outside','/absolute','frontend//file.js','frontend/','manifest.json','x\\y.js']) assert.equal(validPackagePath(path),false,path)
  assert.equal(validPackagePath('frontend/components/app.js'),true)
  assert.throws(()=>packageFromSourceFiles(packageSourceFiles(bundle).filter(file=>file.path!=='frontend/index.html')),/entry not found/)
  const files=packageSourceFiles(bundle)
  assert.throws(()=>packageFromSourceFiles([...files,files[1]!]),/unique path/)
})
test('both starters demonstrate one sample assistant tool served by a bundled endpoint', () => {
  for (const renderer of ['native','sandbox'] as const) {
    const bundle = createAppStarter(renderer)
    const manifest = parseManifest(bundle.manifest).manifest!
    assert.equal(manifest.tools.length, 1)
    const tool = manifest.tools[0]!
    assert.equal(tool.handler, 'sample-tool')
    assert.equal(tool.readOnly, true)
    const endpoint = manifest.endpoints.find((e) => e.name === tool.handler)
    assert.ok(endpoint, 'the sample tool handler must be a declared endpoint')
    assert.ok(bundle.files.some((f) => f.path === endpoint!.file), 'the endpoint file must ship in the bundle')
  }
})
test('version suggestion creates a new patch label without number precision loss',()=>{
  assert.equal(nextAppVersion('1'),'1.0.1')
  assert.equal(nextAppVersion('2.3.9-beta'),'2.3.10')
  assert.equal(nextAppVersion('1.0.999999999999999999999'),'1.0.1000000000000000000000')
})
