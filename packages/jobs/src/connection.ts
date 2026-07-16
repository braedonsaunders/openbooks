import { Redis } from 'ioredis'
import type { ConnectionOptions } from 'bullmq'
import { getRedisUrl } from './config'

// Producers and blocking consumers require opposite retry semantics. Web
// requests and scheduler publishers must fail in bounded time when Redis is
// unavailable; workers must keep their blocking connections alive indefinitely
// so BullMQ can resume consumption after an outage. Both clients stay lazy so
// importing a queue never connects (Next's build walks this graph).

let producerConnection: Redis | undefined
let blockingConnection: Redis | undefined

export function getConnection(): ConnectionOptions {
  producerConnection ??= new Redis(getRedisUrl(), { enableReadyCheck: false, maxRetriesPerRequest: 1 })
  return producerConnection as unknown as ConnectionOptions
}

export function getBlockingConnection(): ConnectionOptions {
  blockingConnection ??= new Redis(getRedisUrl(), { enableReadyCheck: false, maxRetriesPerRequest: null })
  return blockingConnection as unknown as ConnectionOptions
}

/** Close both shared clients after BullMQ workers have finished draining. */
export async function closeJobConnections(): Promise<void> {
  const connections = [producerConnection, blockingConnection].filter((c): c is Redis => Boolean(c))
  producerConnection = undefined
  blockingConnection = undefined
  await Promise.allSettled(
    connections.map(async (connection) => {
      try {
        await connection.quit()
      } catch {
        connection.disconnect(false)
      }
    }),
  )
}
