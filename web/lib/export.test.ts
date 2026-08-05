import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('export responses support Unicode filenames with an ASCII-safe header', () => {
  const source = `
    import assert from "node:assert/strict";
    import { pdfResponse } from "./web/lib/export.ts";
    const response = pdfResponse(Buffer.from("pdf"), "Résumé — Direction");
    const value = response.headers.get("content-disposition");
    assert.equal(value, "inline; filename=\\\"Resume Direction.pdf\\\"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%E2%80%94%20Direction.pdf");
    assert.match(value, /^[\\x00-\\x7f]+$/);
  `
  const result = spawnSync(
    process.execPath,
    ['--conditions=react-server', '--import', 'tsx', '--input-type=module', '-e', source],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
