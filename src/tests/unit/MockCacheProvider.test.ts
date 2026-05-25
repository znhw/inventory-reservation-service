import { describe, it, expect, beforeEach } from 'vitest';
import { MockCacheProvider } from '../mocks/MockCacheProvider';

/**
 * Verifying the MockCacheProvider's atomic logic mirrors the Lua scripts.
 * These run zero infrastructure — pure in-memory.
 */
describe('MockCacheProvider — atomic operations', () => {
  let cache: MockCacheProvider;

  beforeEach(() => {
    cache = new MockCacheProvider();
  });

  describe('executeAtomicReservation', () => {
    it('succeeds and deducts stock when enough is available', async () => {
      await cache.set('inventory:stock:prod-1', '10');
      const ok = await cache.executeAtomicReservation('prod-1', 3, 'res-1', 60);

      expect(ok).toBe(true);
      expect(cache.getStockRaw('prod-1')).toBe(7);
      expect(cache.hasReservationKey('res-1')).toBe(true);
    });

    it('fails when stock is exactly 0', async () => {
      await cache.set('inventory:stock:prod-1', '0');
      const ok = await cache.executeAtomicReservation('prod-1', 1, 'res-1', 60);

      expect(ok).toBe(false);
      expect(cache.getStockRaw('prod-1')).toBe(0); // no change
    });

    it('fails when requested quantity exceeds available stock', async () => {
      await cache.set('inventory:stock:prod-1', '2');
      const ok = await cache.executeAtomicReservation('prod-1', 5, 'res-1', 60);

      expect(ok).toBe(false);
      expect(cache.getStockRaw('prod-1')).toBe(2); // unchanged
    });

    it('is idempotent — second call with same reservationId returns false without double-deducting', async () => {
      await cache.set('inventory:stock:prod-1', '10');

      const first = await cache.executeAtomicReservation('prod-1', 2, 'res-idem', 60);
      expect(first).toBe(true);
      expect(cache.getStockRaw('prod-1')).toBe(8);

      const second = await cache.executeAtomicReservation('prod-1', 2, 'res-idem', 60);
      expect(second).toBe(false);
      expect(cache.getStockRaw('prod-1')).toBe(8); // not deducted twice
    });

    it('stock never goes below zero under rapid fire calls', async () => {
      await cache.set('inventory:stock:prod-1', '1');

      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          cache.executeAtomicReservation('prod-1', 1, `res-${i}`, 60)
        )
      );

      const successes = results.filter(Boolean).length;
      expect(successes).toBe(1);
      expect(cache.getStockRaw('prod-1')).toBe(0);
    });
  });

  describe('executeAtomicRelease', () => {
    it('restores stock and removes the reservation key', async () => {
      await cache.set('inventory:stock:prod-1', '8');
      await cache.set('inventory:reservation:res-1', 'res-1');

      await cache.executeAtomicRelease('prod-1', 2, 'res-1');

      expect(cache.getStockRaw('prod-1')).toBe(10);
      expect(cache.hasReservationKey('res-1')).toBe(false);
    });

    it('is a no-op when reservation key does not exist (already released)', async () => {
      await cache.set('inventory:stock:prod-1', '10');

      await cache.executeAtomicRelease('prod-1', 2, 'ghost-res');

      expect(cache.getStockRaw('prod-1')).toBe(10); // unchanged
    });
  });

  describe('executeAtomicConfirm', () => {
    it('removes the reservation key but leaves stock deducted', async () => {
      await cache.set('inventory:stock:prod-1', '8');
      await cache.set('inventory:reservation:res-1', 'res-1');

      await cache.executeAtomicConfirm('prod-1', 2, 'res-1');

      expect(cache.hasReservationKey('res-1')).toBe(false);
      expect(cache.getStockRaw('prod-1')).toBe(8); // stays deducted
    });
  });
});