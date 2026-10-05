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
let readCacheConnection: Redis | undefined
let readCacheReady: Promise<void> | undefined
const WORKER_HEARTBEAT_KEY = 'openbooks:worker:heartbeat'

export function getConnection(): ConnectionOptions {
  producerConnection ??= new Redis(getRedisUrl(), {
    enableReadyCheck: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  })
  return producerConnection as unknown as ConnectionOptions
}

export function getBlockingConnection(): ConnectionOptions {
  blockingConnection ??= new Redis(getRedisUrl(), {
    enableReadyCheck: false,
    lazyConnect: true,
    maxRetriesPerRequest: null,
  })
  return blockingConnection as unknown as ConnectionOptions
}

/** Optional read caching has its own bounded transport: a cache outage must
 * neither queue thousands of offline commands nor change worker semantics. */
export async function getReadCacheConnection(): Promise<Redis | undefined> {
  if (!readCacheConnection) {
    readCacheConnection = new Redis(getRedisUrl(), {
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
      connectTimeout: 250, commandTimeout: 250,
      retryStrategy: () => 1000,
    })
    // Unavailability is returned to the caller, which reads the source data.
    readCacheConnection.on('error', () => {})
  }
  if (readCacheConnection.status === 'wait' && !readCacheReady) {
    readCacheReady = readCacheConnection.connect().catch(() => {}).finally(() => { readCacheReady = undefined })
  }
  if (readCacheReady) await readCacheReady
  return readCacheConnection.status === 'ready' ? readCacheConnection : undefined
}

/** Refresh the deployment-wide worker heartbeat with a short expiry. */
export async function markWorkerHeartbeat(now = new Date()): Promise<void> {
  const connection = getConnection() as unknown as Redis
  await connection.set(WORKER_HEARTBEAT_KEY, now.toISOString(), 'EX', 60)
}

/** Read the latest worker heartbeat; null means no live worker has reported. */
export async function getWorkerHeartbeat(): Promise<string | null> {
  const connection = getConnection() as unknown as Redis
  return connection.get(WORKER_HEARTBEAT_KEY)
}

/** Close both shared clients after BullMQ workers have finished draining. */
export async function closeJobConnections(): Promise<void> {
  const connections = [producerConnection, blockingConnection, readCacheConnection].filter((c): c is Redis => Boolean(c))
  producerConnection = undefined
  blockingConnection = undefined
  readCacheConnection = undefined
  readCacheReady = undefined
  await Promise.allSettled(
    connections.map(async (connection) => {
      if (connection.status === 'wait') {
        connection.disconnect(false)
        return
      }
      try {
        await connection.quit()
      } catch {
        connection.disconnect(false)
      }
    }),
  )
}
