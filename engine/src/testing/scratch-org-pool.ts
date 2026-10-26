export interface ScratchOrgLifecycleMetrics {
  poolSize: number;
  fullBootstrap: number;
  leases: number;
  releases: number;
  resets: number;
  fullTeardown: number;
  schemaWideVerification: number;
  activeLeases: number;
  leakDetections: number;
}

export interface ScratchOrgPoolStore<T extends { orgId: string }> {
  bootstrap(): Promise<T>;
  reset(org: T): Promise<void>;
  teardown(org: T): Promise<void>;
}

export interface ScratchOrgPoolOptions<T extends { orgId: string }> {
  size: number;
  isolatedDatabase: boolean;
  store: ScratchOrgPoolStore<T>;
}

type PoolSlot<T extends { orgId: string }> = { org: T; leased: boolean; tainted: boolean };

/** The store owns committed reset and teardown semantics for each bounded lease. */
export class ScratchOrgPool<T extends { orgId: string }> {
  readonly metrics: ScratchOrgLifecycleMetrics;
  private readonly store: ScratchOrgPoolStore<T>;
  private readonly slots: PoolSlot<T>[] = [];
  private readonly waiters: {
    resolve: (slot: PoolSlot<T>) => void;
    reject: (error: Error) => void;
  }[] = [];
  private closed = false;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private growthPromise: Promise<void> | undefined;
  private readonly releasing = new Map<string, Promise<void>>();

  constructor(options: ScratchOrgPoolOptions<T>) {
    if (!Number.isInteger(options.size) || options.size < 1 || options.size > 16) {
      throw new Error(
        `scratch fixture pool size must be an integer in [1, 16], got ${options.size}`,
      );
    }
    if (!options.isolatedDatabase) {
      throw new Error(
        "scratch fixture pooling requires an explicitly dedicated ephemeral database; refusing shared DB",
      );
    }
    this.store = options.store;
    this.metrics = {
      poolSize: options.size,
      fullBootstrap: 0,
      leases: 0,
      releases: 0,
      resets: 0,
      fullTeardown: 0,
      schemaWideVerification: 0,
      activeLeases: 0,
      leakDetections: 0,
    };
    this.targetSize = options.size;
  }

  private readonly targetSize: number;

  async start(): Promise<void> {
    if (this.closed) throw new Error("scratch fixture pool is already closed");
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      for (let i = 0; i < this.targetSize; i += 1) {
        this.slots.push({ org: await this.store.bootstrap(), leased: false, tainted: false });
        this.metrics.fullBootstrap += 1;
      }
    })();
    await this.startPromise;
  }

  private reserve(slot: PoolSlot<T>): PoolSlot<T> {
    slot.leased = true;
    this.metrics.leases += 1;
    this.metrics.activeLeases += 1;
    return slot;
  }

  private async nextSlot(): Promise<PoolSlot<T>> {
    for (;;) {
      if (this.closed) throw new Error("scratch fixture pool is already closed");
      const available = this.slots.find((slot) => !slot.leased && !slot.tainted);
      // Reserve before yielding: two callers must never observe the same free slot.
      if (available) return this.reserve(available);
      if (this.slots.every((slot) => slot.tainted))
        throw new Error("scratch fixture pool has no healthy slots");

      // Grow the pool when a test holds every warmed slot.
      if (this.slots.length < 16) {
        if (!this.growthPromise) {
          this.growthPromise = Promise.resolve().then(async () => {
            const org = await this.store.bootstrap();
            this.slots.push({ org, leased: false, tainted: false });
            this.metrics.fullBootstrap += 1;
          });
        }
        const growth = this.growthPromise;
        try {
          await growth;
        } finally {
          if (this.growthPromise === growth) this.growthPromise = undefined;
        }
        continue;
      }

      return await new Promise<PoolSlot<T>>((resolve, reject) =>
        this.waiters.push({ resolve, reject }),
      );
    }
  }

  async lease(): Promise<T> {
    await this.start();
    if (this.closed) throw new Error("scratch fixture pool is already closed");
    const slot = await this.nextSlot();
    if (this.closed) throw new Error("scratch fixture pool is already closed");
    return slot.org;
  }

  async release(orgId: string): Promise<void> {
    const slot = this.slots.find((candidate) => candidate.org.orgId === orgId);
    if (!slot) throw new Error(`scratch fixture ${orgId} is not owned by this pool`);
    const pending = this.releasing.get(orgId);
    if (pending) return pending;
    if (!slot.leased) return;
    if (this.closed) throw new Error("scratch fixture pool is already closed");

    // Register the reset before running user/store code, including synchronous
    // failures. Retries join this operation rather than resetting twice.
    const task = Promise.resolve().then(async () => {
      let failure: unknown;
      let failed = false;
      try {
        await this.store.reset(slot.org);
        this.metrics.resets += 1;
      } catch (error) {
        failed = true;
        slot.tainted = true;
        this.metrics.leakDetections += 1;
        failure = error;
      } finally {
        slot.leased = false;
        this.metrics.activeLeases -= 1;
        this.metrics.releases += 1;
        // Remove the completed operation before handing the slot to a borrower
        // whose own immediate release must start a new reset.
        this.releasing.delete(orgId);
      }
      if (this.slots.every((candidate) => candidate.tainted)) {
        for (const waiter of this.waiters.splice(0))
          waiter.reject(new Error("scratch fixture pool has no healthy slots"));
      }
      const waiter = this.closed ? undefined : this.waiters.shift();
      if (waiter) {
        if (slot.tainted)
          waiter.reject(new Error(`scratch fixture ${orgId} was tainted by a failed reset`));
        else waiter.resolve(this.reserve(slot));
      }
      if (failed) throw failure;
    });
    this.releasing.set(orgId, task);
    return task;
  }

  has(orgId: string): boolean {
    return this.slots.some((slot) => slot.org.orgId === orgId);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter.reject(new Error("scratch fixture pool closed"));
    this.closePromise = (async () => {
      const errors: unknown[] = [];
      // A partial bootstrap still owns every successfully created tenant.
      if (this.startPromise) {
        try {
          await this.startPromise;
        } catch (error) {
          errors.push(error);
        }
      }
      if (this.growthPromise) {
        try {
          await this.growthPromise;
        } catch (error) {
          errors.push(error);
        }
      }
      const resets = await Promise.allSettled([...this.releasing.values()]);
      for (const reset of resets) if (reset.status === "rejected") errors.push(reset.reason);
      if (this.metrics.activeLeases > 0) this.metrics.leakDetections += this.metrics.activeLeases;
      for (const slot of this.slots) {
        try {
          await this.store.teardown(slot.org);
          this.metrics.fullTeardown += 1;
          this.metrics.schemaWideVerification += 1;
        } catch (error) {
          errors.push(error);
        }
      }
      if (
        errors.length > 0 ||
        this.metrics.leakDetections > 0 ||
        this.metrics.activeLeases !== 0 ||
        this.metrics.leases !== this.metrics.releases
      ) {
        throw new Error(
          `scratch fixture pool closed with lifecycle failures: ${JSON.stringify({
            errors: errors.map((error) => String(error)),
            metrics: this.metrics,
          })}`,
        );
      }
    })();
    return this.closePromise;
  }
}

export function scratchOrgPoolSize(): number {
  const raw = process.env.OPENBOOKS_TEST_FIXTURE_POOL_SIZE ?? "4";
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 1 || size > 16) {
    throw new Error(`OPENBOOKS_TEST_FIXTURE_POOL_SIZE must be an integer in [1, 16], got ${raw}`);
  }
  return size;
}

export function fixturePoolingEnabled(): boolean {
  return process.env.OPENBOOKS_TEST_FIXTURE_POOL === "1";
}
