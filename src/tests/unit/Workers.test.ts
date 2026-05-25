import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { ReservationWorker, ExpiryWorker } from '../../workers/processors';
import { InMemoryReservationRepository, InMemoryInventoryRepository } from '../../infrastructure/repositories/InMemoryRepositories';
import { MockCacheProvider } from '../mocks/MockCacheProvider';
import { RedisInventoryService } from '../../services/InventoryService';
import { ReservationStatus } from '../../domain/types';

const logger = pino({ level: 'silent' });

function buildWorkerDeps() {
  const cache = new MockCacheProvider();
  const reservationRepo = new InMemoryReservationRepository();
  const inventoryRepo = new InMemoryInventoryRepository();
  const inventoryService = new RedisInventoryService(cache, inventoryRepo, logger);

  return { cache, reservationRepo, inventoryRepo, inventoryService };
}

describe('ReservationWorker', () => {
  describe('processReservation', () => {
    it('should persist a reservation to the database', async () => {
      const { reservationRepo } = buildWorkerDeps();
      const worker = new ReservationWorker(reservationRepo, logger);

      const reservationId = uuidv4();
      const jobData = {
        reservationId,
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 2,
        reservationRequestId: uuidv4(),
      };

      await worker.processReservation(jobData);

      const saved = await reservationRepo.findById(reservationId);
      expect(saved).not.toBeNull();
      expect(saved!.id).toBe(reservationId);
      expect(saved!.productId).toBe('prod-1');
      expect(saved!.userId).toBe('user-1');
      expect(saved!.quantity).toBe(2);
      expect(saved!.status).toBe(ReservationStatus.ACTIVE);
      expect(saved!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('should be idempotent — reprocessing the same job is a no-op', async () => {
      const { reservationRepo } = buildWorkerDeps();
      const worker = new ReservationWorker(reservationRepo, logger);

      const reservationId = uuidv4();
      const jobData = {
        reservationId,
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 1,
        reservationRequestId: uuidv4(),
      };

      await worker.processReservation(jobData);
      await worker.processReservation(jobData); // second call — must not throw / duplicate

      const all = reservationRepo.getAll().filter((r) => r.id === reservationId);
      expect(all).toHaveLength(1);
    });
  });
});

describe('ExpiryWorker', () => {
  it('should expire an active reservation and restore stock', async () => {
    const { cache, reservationRepo, inventoryService } = buildWorkerDeps();
    const worker = new ExpiryWorker(reservationRepo, inventoryService, logger);

    // Set up stock and reserve some
    await inventoryService.initializeProductStock('prod-1', 5);
    await cache.executeAtomicReservation('prod-1', 2, 'res-1', 120);

    // Persist the reservation with an already-past expiry date
    const pastExpiry = new Date(Date.now() - 1000);
    await reservationRepo.create({
      id: 'res-1',
      reservationRequestId: uuidv4(),
      productId: 'prod-1',
      userId: 'user-1',
      quantity: 2,
      status: ReservationStatus.ACTIVE,
      expiresAt: pastExpiry,
    });

    await worker.processExpiry({
      reservationId: 'res-1',
      productId: 'prod-1',
      quantity: 2,
    });

    const updated = await reservationRepo.findById('res-1');
    expect(updated!.status).toBe(ReservationStatus.EXPIRED);
    expect(cache.getStockRaw('prod-1')).toBe(5); // restored
  });

  it('should skip expiry if reservation is not yet expired (delayed-job drift)', async () => {
    const { cache, reservationRepo, inventoryService } = buildWorkerDeps();
    const worker = new ExpiryWorker(reservationRepo, inventoryService, logger);

    await inventoryService.initializeProductStock('prod-1', 5);
    await cache.executeAtomicReservation('prod-1', 2, 'res-2', 120);

    // Expiry date is in the future
    const futureExpiry = new Date(Date.now() + 60_000);
    await reservationRepo.create({
      id: 'res-2',
      reservationRequestId: uuidv4(),
      productId: 'prod-1',
      userId: 'user-1',
      quantity: 2,
      status: ReservationStatus.ACTIVE,
      expiresAt: futureExpiry,
    });

    await worker.processExpiry({
      reservationId: 'res-2',
      productId: 'prod-1',
      quantity: 2,
    });

    // Should still be ACTIVE and stock unchanged
    const updated = await reservationRepo.findById('res-2');
    expect(updated!.status).toBe(ReservationStatus.ACTIVE);
    expect(cache.getStockRaw('prod-1')).toBe(3); // still deducted
  });

  it('should skip expiry if reservation is already CONFIRMED', async () => {
    const { cache, reservationRepo, inventoryService } = buildWorkerDeps();
    const worker = new ExpiryWorker(reservationRepo, inventoryService, logger);

    await inventoryService.initializeProductStock('prod-1', 5);

    const pastExpiry = new Date(Date.now() - 1000);
    await reservationRepo.create({
      id: 'res-3',
      reservationRequestId: uuidv4(),
      productId: 'prod-1',
      userId: 'user-1',
      quantity: 2,
      status: ReservationStatus.CONFIRMED,
      expiresAt: pastExpiry,
    });

    await worker.processExpiry({
      reservationId: 'res-3',
      productId: 'prod-1',
      quantity: 2,
    });

    const updated = await reservationRepo.findById('res-3');
    expect(updated!.status).toBe(ReservationStatus.CONFIRMED);
    expect(cache.getStockRaw('prod-1')).toBe(5); // nothing was deducted
  });

  it('should handle gracefully when reservation does not exist', async () => {
    const { reservationRepo, inventoryService } = buildWorkerDeps();
    const worker = new ExpiryWorker(reservationRepo, inventoryService, logger);

    // Must not throw
    await expect(
      worker.processExpiry({
        reservationId: uuidv4(),
        productId: 'prod-1',
        quantity: 1,
      })
    ).resolves.toBeUndefined();
  });
});