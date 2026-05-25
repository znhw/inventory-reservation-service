import { CacheProvider } from '../infrastructure/cache/CacheProvider';

/**
 * In-memory CacheProvider that faithfully mimics the Lua-script atomics.
 * Used in unit and integration tests so no real Redis is required.
 */
export class MockCacheProvider implements CacheProvider {
  private store: Map<string, string> = new Map();
  private expirations: Map<string, number> = new Map(); // key → expiry epoch ms

  // ── helpers ────────────────────────────────────────────────────────────────

  private isExpired(key: string): boolean {
    const exp = this.expirations.get(key);
    if (exp === undefined) return false;
    if (Date.now() > exp) {
      this.store.delete(key);
      this.expirations.delete(key);
      return true;
    }
    return false;
  }

  private liveGet(key: string): string | null {
    if (this.isExpired(key)) return null;
    return this.store.get(key) ?? null;
  }

  reset(): void {
    this.store.clear();
    this.expirations.clear();
  }

  // ── CacheProvider implementation ───────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    return this.liveGet(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.store.set(key, value);
    if (ttlSeconds !== undefined) {
      this.expirations.set(key, Date.now() + ttlSeconds * 1000);
    } else {
      this.expirations.delete(key);
    }
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
    this.expirations.delete(key);
  }

  async incr(key: string): Promise<number> {
    const cur = parseInt(this.liveGet(key) ?? '0', 10);
    const next = cur + 1;
    this.store.set(key, String(next));
    return next;
  }

  async decr(key: string): Promise<number> {
    const cur = parseInt(this.liveGet(key) ?? '0', 10);
    const next = cur - 1;
    this.store.set(key, String(next));
    return next;
  }

  async decrBy(key: string, amount: number): Promise<number> {
    const cur = parseInt(this.liveGet(key) ?? '0', 10);
    const next = cur - amount;
    this.store.set(key, String(next));
    return next;
  }

  async incrBy(key: string, amount: number): Promise<number> {
    const cur = parseInt(this.liveGet(key) ?? '0', 10);
    const next = cur + amount;
    this.store.set(key, String(next));
    return next;
  }

  async exists(key: string): Promise<boolean> {
    return this.liveGet(key) !== null;
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    if (this.store.has(key)) {
      this.expirations.set(key, Date.now() + ttlSeconds * 1000);
    }
  }

  async ttl(key: string): Promise<number> {
    const exp = this.expirations.get(key);
    if (exp === undefined) return -1;
    const remaining = Math.ceil((exp - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  // ── Atomic operations (mirrors Lua script logic exactly) ───────────────────

  async executeAtomicReservation(
    productId: string,
    quantity: number,
    reservationId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const stockKey = `inventory:stock:${productId}`;
    const reservationKey = `inventory:reservation:${reservationId}`;

    // Idempotency: already claimed
    if (this.liveGet(reservationKey) !== null) return false;

    const currentStock = parseInt(this.liveGet(stockKey) ?? '0', 10);
    if (currentStock < quantity) return false;

    this.store.set(stockKey, String(currentStock - quantity));
    this.store.set(reservationKey, reservationId);
    this.expirations.set(
      reservationKey,
      Date.now() + ttlSeconds * 1000
    );

    return true;
  }

  async executeAtomicRelease(
    productId: string,
    quantity: number,
    reservationId: string
  ): Promise<void> {
    const stockKey = `inventory:stock:${productId}`;
    const reservationKey = `inventory:reservation:${reservationId}`;

    if (this.liveGet(reservationKey) !== null) {
      const currentStock = parseInt(this.liveGet(stockKey) ?? '0', 10);
      this.store.set(stockKey, String(currentStock + quantity));
      this.store.delete(reservationKey);
      this.expirations.delete(reservationKey);
    }
  }

  async executeAtomicConfirm(
    _productId: string,
    _quantity: number,
    reservationId: string
  ): Promise<void> {
    const reservationKey = `inventory:reservation:${reservationId}`;
    this.store.delete(reservationKey);
    this.expirations.delete(reservationKey);
  }

  // ── Test helpers ───────────────────────────────────────────────────────────

  getStockRaw(productId: string): number {
    return parseInt(this.liveGet(`inventory:stock:${productId}`) ?? '0', 10);
  }

  hasReservationKey(reservationId: string): boolean {
    return this.liveGet(`inventory:reservation:${reservationId}`) !== null;
  }
}