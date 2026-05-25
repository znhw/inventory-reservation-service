import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { ReservationServiceImpl } from '../../services/ReservationService';
import { RedisInventoryService } from '../../services/InventoryService';
import { InMemoryReservationRepository, InMemoryInventoryRepository } from '../../infrastructure/repositories/InMemoryRepositories';
import { MockCacheProvider } from '../mocks/MockCacheProvider';
import { MockQueueProvider } from '../mocks/MockQueueProvider';
import { ReservationWorker, ExpiryWorker } from '../../workers/processors';
import { ReservationStatus } from '../../domain/types';
import { DuplicateReservationError } from '../../domain/errors';

const logger = pino({ level: 'silent' });

function buildStack() {
  const cache = new MockCacheProvider();
  const queue = new MockQueueProvider();
  const reservationRepo = new InMemoryReservationRepository();
  const inventoryRepo = new InMemoryInventoryRepository();
  const reservationWorker = new ReservationWorker(reservationRepo, logger);
  const inventoryService = new RedisInventoryService(cache, inventoryRepo, logger);
  const expiryWorker = new ExpiryWorker(reservationRepo, inventoryService, logger);

  const reservationService = new ReservationServiceImpl(
    reservationRepo,
    inventoryService,
    queue,
    logger
  );

  queue.process('reservations', (data) =>
    reservationWorker.processReservation(data)
  );
  queue.process('reservation-expiry', (data) =>
    expiryWorker.processExpiry(data)
  );

  return {
    cache,
    queue,
    reservationRepo,
    inventoryRepo,
    inventoryService,
    reservationService,
    reservationWorker,
    expiryWorker,
  };
}

describe('Failure modes', () => {
  describe('Idempotency — duplicate reservation_request_id', () => {
    it('should reject a duplicate request with DuplicateReservationError', async () => {
      const { inventoryService, reservationService } = buildStack();
      await inventoryService.initializeProductStock('prod-1', 10);

      const requestId = uuidv4();
      await reservationService.createReservation({
        reservationRequestId: requestId,
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 1,
      });

      await expect(
        reservationService.createReservation({
          reservationRequestId: requestId,
          productId: 'prod-1',
          userId: 'user-1',
          quantity: 1,
        })
      ).rejects.toThrow(DuplicateReservationError);
    });

    it('should not deduct stock twice for a duplicate request', async () => {
      const { cache, inventoryService, reservationService } = buildStack();
      await inventoryService.initializeProductStock('prod-1', 5);

      const requestId = uuidv4();
      await reservationService.createReservation({
        reservationRequestId: requestId,
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 2,
      });

      try {
        await reservationService.createReservation({
          reservationRequestId: requestId,
          productId: 'prod-1',
          userId: 'user-1',
          quantity: 2,
        });
      } catch {
        // expected
      }

      // Only 2 deducted, not 4
      expect(cache.getStockRaw('prod-1')).toBe(3);
    });

    it('worker replaying a job for an existing reservationId is a no-op', async () => {
      const { reservationRepo, reservationWorker } = buildStack();

      const reservationId = uuidv4();
      const jobData = {
        reservationId,
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 1,
        reservationRequestId: uuidv4(),
      };

      await reservationWorker.processReservation(jobData);
      await reservationWorker.processReservation(jobData); // replay
      await reservationWorker.processReservation(jobData); // again

      const all = reservationRepo.getAll().filter((r) => r.id === reservationId);
      expect(all).toHaveLength(1);
    });
  });

  describe('Expiry drift — delayed job runs late', () => {
    it('should still expire a reservation whose expiry has long passed', async () => {
      const { cache, reservationRepo, inventoryService, expiryWorker } =
        buildStack();

      await inventoryService.initializeProductStock('prod-2', 5);
      await cache.executeAtomicReservation('prod-2', 3, 'res-drift', 120);

      // Reservation expired 10 minutes ago
      const wayPast = new Date(Date.now() - 600_000);
      await reservationRepo.create({
        id: 'res-drift',
        reservationRequestId: uuidv4(),
        productId: 'prod-2',
        userId: 'user-1',
        quantity: 3,
        status: ReservationStatus.ACTIVE,
        expiresAt: wayPast,
      });

      await expiryWorker.processExpiry({
        reservationId: 'res-drift',
        productId: 'prod-2',
        quantity: 3,
      });

      const updated = await reservationRepo.findById('res-drift');
      expect(updated!.status).toBe(ReservationStatus.EXPIRED);
      expect(cache.getStockRaw('prod-2')).toBe(5);
    });

    it('should skip expiry when delayed job runs early (clock drift)', async () => {
      const { cache, reservationRepo, inventoryService, expiryWorker } =
        buildStack();

      await inventoryService.initializeProductStock('prod-2', 5);
      await cache.executeAtomicReservation('prod-2', 2, 'res-early', 120);

      // Still 5 minutes to expiry
      const future = new Date(Date.now() + 300_000);
      await reservationRepo.create({
        id: 'res-early',
        reservationRequestId: uuidv4(),
        productId: 'prod-2',
        userId: 'user-1',
        quantity: 2,
        status: ReservationStatus.ACTIVE,
        expiresAt: future,
      });

      await expiryWorker.processExpiry({
        reservationId: 'res-early',
        productId: 'prod-2',
        quantity: 2,
      });

      const updated = await reservationRepo.findById('res-early');
      expect(updated!.status).toBe(ReservationStatus.ACTIVE);
      // Stock NOT restored
      expect(cache.getStockRaw('prod-2')).toBe(3);
    });
  });

  describe('Worker crash recovery — Redis succeeded, DB write pending', () => {
    it('replaying the reservation job persists the reservation', async () => {
      const { cache, reservationRepo, inventoryService, reservationWorker } =
        buildStack();

      await inventoryService.initializeProductStock('prod-3', 5);

      // Simulate: Redis atomically reserved stock, but the DB write never happened
      const reservationId = uuidv4();
      await cache.executeAtomicReservation('prod-3', 1, reservationId, 120);
      expect(cache.getStockRaw('prod-3')).toBe(4);

      // Worker replays the job
      await reservationWorker.processReservation({
        reservationId,
        productId: 'prod-3',
        userId: 'user-1',
        quantity: 1,
        reservationRequestId: uuidv4(),
      });

      const saved = await reservationRepo.findById(reservationId);
      expect(saved).not.toBeNull();
      expect(saved!.status).toBe(ReservationStatus.ACTIVE);

      // Stock still correctly deducted
      expect(cache.getStockRaw('prod-3')).toBe(4);
    });

    it('expiry job handles missing Redis key (TTL already evicted) gracefully', async () => {
      const { reservationRepo, inventoryService, expiryWorker, cache } =
        buildStack();

      await inventoryService.initializeProductStock('prod-3', 5);

      // Reservation exists in DB but Redis key has already been evicted by TTL
      const pastExpiry = new Date(Date.now() - 5000);
      await reservationRepo.create({
        id: 'res-ttl',
        reservationRequestId: uuidv4(),
        productId: 'prod-3',
        userId: 'user-1',
        quantity: 2,
        status: ReservationStatus.ACTIVE,
        expiresAt: pastExpiry,
      });

      // Note: no Redis key set for this reservation (already evicted)
      await expiryWorker.processExpiry({
        reservationId: 'res-ttl',
        productId: 'prod-3',
        quantity: 2,
      });

      const updated = await reservationRepo.findById('res-ttl');
      expect(updated!.status).toBe(ReservationStatus.EXPIRED);

      // Stock should be incremented (release is idempotent when key missing)
      expect(cache.getStockRaw('prod-3')).toBeGreaterThanOrEqual(5);
    });
  });
});