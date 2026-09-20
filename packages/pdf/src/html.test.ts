import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowedPdfRequest, preparePdfChromeHtml } from './html'
import { pdfChromeSubresourceRequests } from './template'

test('allows the print document and inline visual resources only', () => {
  assert.equal(isAllowedPdfRequest('document', 'about:blank'), true)
  assert.equal(isAllowedPdfRequest('image', 'data:image/png;base64,AAAA'), true)
  assert.equal(isAllowedPdfRequest('font', 'data:font/woff2;base64,AAAA'), true)
  assert.equal(isAllowedPdfRequest('stylesheet', 'data:text/css,body%7Bcolor%3Ared%7D'), true)
})

test('blocks template-authored network and non-visual requests', () => {
  assert.equal(isAllowedPdfRequest('image', 'http://169.254.169.254/latest/meta-data/'), false)
  assert.equal(isAllowedPdfRequest('stylesheet', 'https://internal.example/admin'), false)
  assert.equal(isAllowedPdfRequest('document', 'https://example.com/redirect'), false)
  assert.equal(isAllowedPdfRequest('image', 'file:///etc/passwd'), false)
  assert.equal(isAllowedPdfRequest('script', 'data:text/javascript,alert(1)'), false)
})

test('header and footer chrome HTML cannot produce a network request', () => {
  // Chromium prints headerTemplate/footerTemplate as their own documents;
  // page request interception never sees those subresources. Authored
  // http(s) images and stylesheets must be rewritten so the only remaining
  // chrome subresources are ones isAllowedPdfRequest would continue.
  const authoredHeader =
    '<div>Acme <img src="https://static.example/logo.png" alt="mark"></div>'
  const authoredFooter =
    '<link rel="stylesheet" href="https://static.example/sheet.css">' +
      '<div style="background:url(https://static.example/logo.png)">Page {{page}}</div>'

  const authoredRequests = [
    ...pdfChromeSubresourceRequests(authoredHeader),
    ...pdfChromeSubresourceRequests(authoredFooter),
  ]
  assert.ok(
    authoredRequests.some(
      (request) =>
        request.resourceType === 'image' &&
        !isAllowedPdfRequest(request.resourceType, request.url),
    ),
  )
  assert.ok(
    authoredRequests.some(
      (request) =>
        request.resourceType === 'stylesheet' &&
        !isAllowedPdfRequest(request.resourceType, request.url),
    ),
  )

  const header = preparePdfChromeHtml(authoredHeader)
  const footer = preparePdfChromeHtml(authoredFooter)
  const chromeRequests = [
    ...pdfChromeSubresourceRequests(header),
    ...pdfChromeSubresourceRequests(footer),
  ]
  assert.match(header, /Acme/)
  assert.match(footer, /pageNumber/)
  assert.equal(
    chromeRequests.filter((request) => /^https?:/i.test(request.url)).length,
    0,
  )
  assert.ok(
    chromeRequests.every((request) => isAllowedPdfRequest(request.resourceType, request.url)),
  )

  const inline = preparePdfChromeHtml('<img src="data:image/png;base64,AAAA" alt="logo">')
  const inlineRequests = pdfChromeSubresourceRequests(inline)
  assert.ok(inlineRequests.some((request) => request.url.startsWith('data:image/png')))
  assert.ok(
    inlineRequests.every((request) => isAllowedPdfRequest(request.resourceType, request.url)),
  )
})

test('header chrome CSS image-set and escaped url() cannot produce a network request', () => {
  // image-set() accepts a string URL without url(); a regex that only
  // rewrites url() leaves Chromium a fetchable candidate. CSS identifier
  // escapes (`\75rl` = url) hide the function from a literal /url(/ match.
  const imageSet = preparePdfChromeHtml(
    '<div style="background-image:image-set(&quot;https://static.example/logo.png&quot; 1x)">Acme</div>',
  )
  const escapedFn = preparePdfChromeHtml(
    '<div style="background:\\75rl(https://static.example/logo.png)">Acme</div>',
  )
  const escapedUrl = preparePdfChromeHtml(
    '<div style="background:url(\\68ttps://static.example/logo.png)">Acme</div>',
  )
  const styleBlock = preparePdfChromeHtml(
    '<style>p{background-image:image-set(url(https://static.example/logo.png) 1x)}</style>Page {{page}}',
  )
  const webkitSet = preparePdfChromeHtml(
    '<div style="background-image:-webkit-image-set(&quot;https://static.example/logo.png&quot; 1x)">Acme</div>',
  )
  const escapedSet = preparePdfChromeHtml(
    '<div style="background-image:\\69mage-set(&quot;https://static.example/logo.png&quot; 1x)">Acme</div>',
  )

  for (const html of [imageSet, escapedFn, escapedUrl, styleBlock, webkitSet, escapedSet]) {
    assert.match(html, /Acme|pageNumber/)
    assert.doesNotMatch(html, /static\.example/i)
    assert.doesNotMatch(html, /https?:\/\//i)
    const requests = pdfChromeSubresourceRequests(html)
    assert.equal(requests.filter((request) => /^https?:/i.test(request.url)).length, 0)
    assert.ok(requests.every((request) => isAllowedPdfRequest(request.resourceType, request.url)))
  }

  const inlineSet = preparePdfChromeHtml(
    '<div style="background-image:image-set(url(data:image/png;base64,AAAA) 1x)">Acme</div>',
  )
  assert.match(inlineSet, /data:image\/png;base64,AAAA/)
  assert.ok(
    pdfChromeSubresourceRequests(inlineSet).every((request) =>
      isAllowedPdfRequest(request.resourceType, request.url),
    ),
  )
})
