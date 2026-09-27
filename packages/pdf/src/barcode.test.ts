import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODE128_BAR_HEIGHT_MM,
  CODE128_MODULE_WIDTH_MM,
  CODE128_QUIET_ZONE_MODULES,
  encodeCode128,
  renderCode128Svg,
} from './barcode'

test('Code 128 C matches the published 123456 symbol pattern', () => {
  const encoded = encodeCode128('123456')
  assert.deepEqual(encoded.codewords, [105, 12, 34, 56, 44, 106])
  assert.deepEqual(encoded.patterns, [
    '211232', '112232', '131123', '331121', '132131', '2331112',
  ])
})

test('Code 128 B and C switching matches the published symbol patterns', () => {
  const encoded = encodeCode128('AB123456')
  assert.deepEqual(encoded.codewords, [104, 33, 34, 99, 12, 34, 56, 26, 106])
  assert.deepEqual(encoded.patterns, [
    '211214', '111323', '131123', '113141', '112232', '131123', '331121', '321221', '2331112',
  ])
})

test('Code 128 C switches back to B and checksums both code-set changes', () => {
  const encoded = encodeCode128('123456A')
  assert.deepEqual(encoded.codewords, [105, 12, 34, 56, 100, 33, 94, 106])
  assert.deepEqual(encoded.patterns, [
    '211232', '112232', '131123', '331121', '114131', '111323', '131141', '2331112',
  ])
})

test('Code 128 B matches the published Code 128 sample pattern', () => {
  const encoded = encodeCode128('Code 128')
  assert.deepEqual(encoded.codewords, [104, 35, 79, 68, 69, 0, 17, 18, 24, 64, 106])
  assert.deepEqual(encoded.patterns, [
    '211214', '131321', '134111', '141221', '112214', '212222',
    '123221', '223211', '311222', '111422', '2331112',
  ])
})

test('SVG uses the stated module width and quiet zone and includes readable text', () => {
  const svg = renderCode128Svg('SHP-0042-C1')
  assert.match(svg, new RegExp(`width="[\\d.]+mm" height="${CODE128_BAR_HEIGHT_MM + 4}mm"`))
  assert.match(svg, /viewBox="0 0 /)
  assert.match(svg, /shape-rendering="crispEdges"/)
  assert.match(svg, /aria-label="Code 128 SHP-0042-C1"/)
  assert.match(svg, /<text[^>]*>SHP-0042-C1<\/text>/)
  assert.equal(CODE128_MODULE_WIDTH_MM, 0.25)
  assert.equal(CODE128_QUIET_ZONE_MODULES, 10)
})

test('unsupported values are refused instead of being changed before encoding', () => {
  assert.throws(() => encodeCode128(''), /non-empty/)
  assert.throws(() => encodeCode128('A\nB'), /printable ASCII/)
  assert.throws(() => encodeCode128('München'), /printable ASCII/)
})
