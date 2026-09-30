import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { scanText } from './check-api-error-sanitization.mjs'

const scan = (text) => scanText('route.ts', text)

test('caught messages and stringified errors are refused with their response location', () => {
  for (const expression of ['error.message', 'error?.message', 'error["message"]', 'String(error)', 'error instanceof Error ? error.message : "Failed"']) {
    assert.deepEqual(scan(`try { work() } catch (error) {\n return NextResponse.json({ error: ${expression} })\n}`), [2], expression)
  }
})

test('aliases of a caught object retain the same direct response check', () => {
  assert.deepEqual(scan('try { work() } catch (error) { const alias = error; return Response.json({error: alias.message}) }'), [1])
})

test('validation messages, safe responses and shadowed callback bindings remain permitted', () => {
  assert.deepEqual(scan('return NextResponse.json({error: query.error.issues.map(issue => issue.message).join("; ")})'), [])
  assert.deepEqual(scan('try { work() } catch (error) { return apiErrorResponse(error) }'), [])
  assert.deepEqual(scan('try { work() } catch (error) { return Response.json({error: issues.map(error => error.message)}) }'), [])
  assert.deepEqual(scan('try { work() } catch (error) { const message = publicMessage(error); return Response.json({error: message}) }'), [])
})

test('native inventory option validation is compatible with the guard', () => {
  const path = 'web/app/api/inventory/movement-options/route.ts'
  assert.deepEqual(scanText(path, readFileSync(path, 'utf8')), [])
})
