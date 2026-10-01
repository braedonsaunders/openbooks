declare module 'unzipper' {
  import type { Readable, Duplex } from 'node:stream'
  export interface Entry extends Readable {
    path: string
    autodrain(): { promise(): Promise<void> }
  }
  export function Parse(options: { forceStream: true }): Duplex & AsyncIterable<Entry>
}
