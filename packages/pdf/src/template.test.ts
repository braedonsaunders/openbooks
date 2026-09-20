import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compileTemplateHtml,
  expandRepeatMarkers,
  renderTemplate,
  sanitizeRenderedHtml,
  sanitizeTemplateHtml,
  sanitizeTokenizedFragment,
  TEMPLATE_RENDER_LIMITS,
} from './template'

test('triple-brace record values are escaped unless raw values are explicitly enabled', () => {
  const rendered = renderTemplate(
    '<p>{{{memo}}}</p>',
    { memo: '<img src="https://attacker.example/pixel" onerror="steal()">Visible note' },
    { escapeHtml: true },
  )

  // HTML-bearing merge values are plainified before escaping, so an injected
  // element (including its external URL) cannot reach the printed body.
  assert.equal(rendered, '<p>Visible note</p>')
  assert.doesNotMatch(rendered, /attacker\.example|<img/i)
})

test('trusted callers can explicitly opt into raw HTML values', () => {
  assert.equal(
    renderTemplate(
      '<p>{{{memo}}}</p>',
      { memo: '<strong>Approved markup</strong>' },
      { escapeHtml: true, allowRawValues: true },
    ),
    '<p><strong>Approved markup</strong></p>',
  )
})

test('repeat rows still expand on table rows', () => {
  assert.equal(
    expandRepeatMarkers('<table><tbody><tr data-each="lines"><td>{{amount}}</td></tr></tbody></table>'),
    '<table><tbody>{{#each lines}}<tr><td>{{amount}}</td></tr>{{/each}}</tbody></table>',
  )
  assert.equal(
    expandRepeatMarkers('<table><tbody><tr data-if="memo"><td>{{memo}}</td></tr></tbody></table>'),
    '<table><tbody>{{#if memo}}<tr><td>{{memo}}</td></tr>{{/if}}</tbody></table>',
  )
})

test('conditional markers expand on section wrappers, not just rows', () => {
  assert.equal(
    expandRepeatMarkers('<div data-if="work_description">Hi {{work_description}}</div>'),
    '{{#if work_description}}<div>Hi {{work_description}}</div>{{/if}}',
  )
  assert.equal(
    expandRepeatMarkers('<table data-if="lines"><tbody><tr><td>x</td></tr></tbody></table>'),
    '{{#if lines}}<table><tbody><tr><td>x</td></tr></tbody></table>{{/if}}',
  )
  // Marker attributes are stripped; other attributes survive untouched.
  assert.equal(
    expandRepeatMarkers('<div class="sig" data-if="seal">x</div>'),
    '{{#if seal}}<div class="sig">x</div>{{/if}}',
  )
})

test('marked elements nest: a conditional section around a repeat row', () => {
  const out = expandRepeatMarkers(
    '<div data-if="lines"><table><tbody><tr data-each="lines"><td>{{amount}}</td></tr></tbody></table></div>',
  )
  assert.equal(
    out,
    '{{#if lines}}<div><table><tbody>{{#each lines}}<tr><td>{{amount}}</td></tr>{{/each}}</tbody></table></div>{{/if}}',
  )
  // The expanded template renders: empty collection hides the section, a
  // non-empty one repeats the row inside it.
  assert.equal(renderTemplate(out, { lines: [] }, { escapeHtml: true }), '')
  assert.equal(
    renderTemplate(out, { lines: [{ amount: '1' }, { amount: '2' }] }, { escapeHtml: true }),
    '<div><table><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody></table></div>',
  )
})

test('same-name nesting pairs with the nearest close', () => {
  assert.equal(
    expandRepeatMarkers('<div data-if="a"><div>inner</div></div>'),
    '{{#if a}}<div><div>inner</div></div>{{/if}}',
  )
})

test('marked nested same-name elements render nested conditions', () => {
  // The inner marked close must pop the inner frame — not decrement the
  // outer and leave it falsely unclosed.
  const out = expandRepeatMarkers('<div data-if="outer"><div data-if="inner">x</div></div>')
  assert.equal(out, '{{#if outer}}<div>{{#if inner}}<div>x</div>{{/if}}</div>{{/if}}')
  assert.equal(renderTemplate(out, { outer: true, inner: false }, { escapeHtml: true }), '<div></div>')
  assert.equal(
    renderTemplate(out, { outer: true, inner: true }, { escapeHtml: true }),
    '<div><div>x</div></div>',
  )
  assert.equal(renderTemplate(out, { outer: false, inner: true }, { escapeHtml: true }), '')
})

test('marked and unmarked same-name nesting mix without stealing closes', () => {
  assert.equal(
    expandRepeatMarkers('<div data-if="a"><div data-if="b"><div>deep</div></div></div>'),
    '{{#if a}}<div>{{#if b}}<div><div>deep</div></div>{{/if}}</div>{{/if}}',
  )
  assert.equal(
    expandRepeatMarkers('<div><div data-if="a">x</div></div>'),
    '<div>{{#if a}}<div>x</div>{{/if}}</div>',
  )
})

test('a nested table inside a repeat row pairs instead of breaking', () => {
  assert.equal(
    expandRepeatMarkers(
      '<table><tbody><tr data-each="lines"><td><table><tbody><tr><td>n</td></tr></tbody></table></td></tr></tbody></table>',
    ),
    '<table><tbody>{{#each lines}}<tr><td><table><tbody><tr><td>n</td></tr></tbody></table></td></tr>{{/each}}</tbody></table>',
  )
})

test('nested markers are capped at nestingDepth like the renderer', () => {
  const nest = (depth: number): string =>
    '<div data-if="a">'.repeat(depth) + 'x' + '</div>'.repeat(depth)
  // 32 nested markers expand; the 33rd is refused before it can push.
  const ok = expandRepeatMarkers(nest(TEMPLATE_RENDER_LIMITS.nestingDepth))
  assert.match(ok, /\{\{#if a\}\}/)
  assert.throws(() => expandRepeatMarkers(nest(TEMPLATE_RENDER_LIMITS.nestingDepth + 1)), /nested blocks/)
  // Unmarked nesting never counts toward the marker cap.
  const plain = '<div>'.repeat(100) + '<div data-if="a">x</div>' + '</div>'.repeat(100)
  assert.match(expandRepeatMarkers(plain), /\{\{#if a\}\}/)
})

test('malformed markers are refused, never half-expanded', () => {
  // Self-closing marked element: nothing to pair with.
  assert.throws(() => expandRepeatMarkers('<div data-if="a" />'), /closing tag/)
  // Unclosed marked element.
  assert.throws(() => expandRepeatMarkers('<div data-if="a">x'), /closing tag/)
  assert.throws(() => expandRepeatMarkers('<table><tbody><tr data-each="lines"><td>x</td>'), /closing tag/)
  // Overlapping markers.
  assert.throws(
    () => expandRepeatMarkers('<div data-if="a"><span data-if="b"></div></span>'),
    /overlap/,
  )
  // Two markers on one element.
  assert.throws(() => expandRepeatMarkers('<tr data-each="a" data-if="b"><td>x</td></tr>'), /more than one/)
  // Invalid value paths.
  assert.throws(() => expandRepeatMarkers('<tr data-each=""><td>x</td></tr>'), /invalid value path/)
  assert.throws(() => expandRepeatMarkers('<tr data-each="a b"><td>x</td></tr>'), /invalid value path/)
})

test('unmarked HTML passes through byte-identical', () => {
  const html = '<div class="x"><table><tbody><tr><td>1</td></tr></tbody></table></div>'
  assert.equal(expandRepeatMarkers(html), html)
})

test('rendered-output sanitizing keeps the merge size policy, not the authored one', () => {
  // A valid merge repeats content past the 1MB authored ceiling: between the
  // two limits the merged body must sanitize clean, still stripping schemes.
  const big = `<div>${'a'.repeat(1_500_000)}</div><a href="javascript:alert(1)">x</a>`
  assert.ok(big.length > TEMPLATE_RENDER_LIMITS.templateChars)
  assert.ok(big.length < TEMPLATE_RENDER_LIMITS.renderOutputChars)
  assert.throws(() => sanitizeTemplateHtml(big), /Authored template HTML exceeded/)
  const clean = sanitizeRenderedHtml(big)
  assert.ok(clean.includes('a'.repeat(100)))
  assert.doesNotMatch(clean, /javascript:/i)
})

test('rendered-output sanitizing still refuses output past the render limit', () => {
  const over = `<div>${'a'.repeat(TEMPLATE_RENDER_LIMITS.renderOutputChars + 1)}</div>`
  assert.throws(() => sanitizeRenderedHtml(over), /exceeded/)
})

test('tokenized header/footer fragments drop network resource URLs and keep inline ones', () => {
  const network = sanitizeTokenizedFragment(
    '<div>Acme<img src="http://169.254.169.254/latest/meta-data/" alt="mark"></div>',
  )
  assert.match(network, /Acme/)
  assert.match(network, /alt="mark"/)
  assert.doesNotMatch(network, /169\.254|https?:\/\//i)

  const stylesheet = sanitizeTokenizedFragment(
    '<link rel="stylesheet" href="https://internal.example/admin"><div>{{page}}</div>',
  )
  assert.match(stylesheet, /\{\{page\}\}/)
  assert.doesNotMatch(stylesheet, /internal\.example|href="https?:/i)

  const css = sanitizeTokenizedFragment(
    '<style>@import url("https://internal.example/sheet.css"); p{color:red}</style>' +
      '<div style="background:url(https://internal.example/logo.png)">x</div>',
  )
  assert.doesNotMatch(css, /internal\.example|https?:\/\//i)
  assert.match(css, />x</)

  const inline = sanitizeTokenizedFragment('<img src="data:image/png;base64,AAAA" alt="logo">')
  assert.match(inline, /data:image\/png;base64,AAAA/)

  // Navigation hrefs are not subresource fetches; escaped text is not markup.
  const link = sanitizeTokenizedFragment('<div><a href="https://example.com/docs">Guide</a></div>')
  assert.match(link, /href="https:\/\/example\.com\/docs"/)
  const escaped = sanitizeTokenizedFragment(
    '<div>&lt;img src=&quot;https://attacker.example/pixel&quot;&gt;note</div>',
  )
  assert.match(escaped, /attacker\.example/)
  assert.doesNotMatch(escaped, /<img/i)
})

test('the field-ticket conditional sections compile to live conditionals', () => {
  // Mirrors the shipped starter shapes: section wrappers guarded by data-if.
  const { compiledHtml } = compileTemplateHtml(
    '<div data-if="work_description">{{work_description}}</div>' +
      '<table data-if="lines"><tbody><tr data-each="lines"><td>{{amount}}</td></tr></tbody></table>' +
      '<div data-if="seal"><img src="seal.png"></div>',
  )
  assert.match(compiledHtml, /\{\{#if work_description\}\}/)
  assert.match(compiledHtml, /\{\{#if lines\}\}/)
  assert.match(compiledHtml, /\{\{#each lines\}\}/)
  assert.match(compiledHtml, /\{\{#if seal\}\}/)
  assert.doesNotMatch(compiledHtml, /data-(each|if)=/)
})
