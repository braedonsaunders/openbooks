import { pipeline } from 'node:stream'

// pipeline destroys the downstream response if the upstream body is truncated;
// plain pipe leaves browsers waiting forever after headers have been sent.
export function forwardResponse(upstream, downstream) {
  downstream.writeHead(upstream.statusCode ?? 502, upstream.headers)
  pipeline(upstream, downstream, (error) => {
    if (error) downstream.destroy(error)
  })
}
