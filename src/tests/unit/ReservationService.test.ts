import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { ReservationServiceImpl } from '../../services/ReservationService';
import { RedisInventoryService } from '../../services/InventoryService';
import { InMemoryReservationRepository, InMemoryInventoryRepository } from '../../infrastructure/repositories/InMemoryRepositories';
import { MockCacheProvider } from '../mocks/MockCacheProvider';
import { MockQueueProvider } from '../mocks/MockQueueProvider';
import { ReservationWorker } from '../../workers/processors';
import { ReservationStatus } from '../../domain/types';
import {
  DuplicateReservationError,
  InsufficientInventoryError,
  InvalidReservationStateError,
  ReservationNotFoundError,
} from '../../domain/errors';

const logger = pino({ level: 'silent' });

function buildServices() {
  const cache = new MockCacheProvider();
  const queue = new MockQueueProvider();
  const reservationRepo = new InMemoryReservationRepository();
  const inventoryRepo = new InMemoryInventoryRepository();

  const inventoryService = new RedisInventoryService(cache, inventoryRepo, logger);
  const reservationService = new ReservationServiceImpl(
    reservationRepo,
    inventoryService,
    queue,
    logger
  );

  // Wire the worker so non-delayed jobs execute synchronously in tests
  const worker = new ReservationWorker(reservationRepo, logger);
  void queue.process('reservations', (data: unknown) =>
    worker.processReservation(data as Parameters<typeof worker.processReservation>[0])
  );

  return { cache, queue, reservationRepo, inventoryRepo, inventoryService, reservationService };
}

describe('ReservationService', () => {
  describe('createReservation', () => {
    it('should create a reservation when stock is available', async () => {
      const { cache, inventoryService, reservationService } = buildServices();

      await inventoryService.initializeProductStock('prod-1', 10);

      const reservation = await reservationService.createReservation({
        reservationRequestId: uuidv4(),
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 2,
      });

      expect(reservation.id).toBeDefined();
      expect(reservation.productId).toBe('prod-1');
      expect(reservation.userId).toBe('user-1');
      expect(reservation.quantity).toBe(2);
      expect(reservation.status).toBe(ReservationStatus.ACTIVE);
      expect(reservation.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(cache.getStockRaw('prod-1')).toBe(8); // 10 - 2
    });

    it('should throw InsufficientInventoryError when stock is 0', async () => {
      const { inventoryService, reservationService } = buildServices();
      await inventoryService.initializeProductStock('prod-1', 0);

      await expect(
        reservationService.createReservation({
          reservationRequestId: uuidv4(),
          productId: 'prod-1',
          userId: 'user-1',
          quantity: 1,
        })
      ).rejects.toThrow(InsufficientInventoryError);
    });

    it('should throw InsufficientInventoryError when requesting more than available', async () => {
      const { inventoryService, reservationService } = buildServices();
      await inventoryService.initializeProductStock('prod-1', 3);

      await expect(
        reservationService.createReservation({
          reservationRequestId: uuidv4(),
          productId: 'prod-1',
          userId: 'user-1',
          quantity: 5,
        })
      ).rejects.toThrow(InsufficientInventoryError);
    });

    it('should throw DuplicateReservationError on repeated reservationRequestId', async () => {
      const { inventoryService, reservationService } = buildServices();
      await inventoryService.initializeProductStock('prod-1', 10);

      const requestId = uuidv4();

      // First call succeeds
      await reservationService.createReservation({
        reservationRequestId: requestId,
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 1,
      });

      // Second call with same ID must be rejected
      await expect(
        reservationService.createReservation({
          reservationRequestId: requestId,
          productId: 'prod-1',
          userId: 'user-1',
          quantity: 1,
        })
      ).rejects.toThrow(DuplicateReservationError);
    });

    it('should enqueue a reservation job and a delayed expiry job', async () => {
      const { inventoryService, reservationService, queue } = buildServices();
      await inventoryService.initializeProductStock('prod-1', 10);

      await reservationService.createReservation({
        reservationRequestId: uuidv4(),
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 1,
      });

      // The reservation job runs immediately (no delay), counted in processedJobs
      // The expiry job is delayed, sitting in the delayed queue
      expect(queue.getProcessedJobs('reservations').length).toBeGreaterThanOrEqual(1);
      expect(queue.countDelayedJobs('reservation-expiry')).toBe(1);
    });

    it('should not go negative when stock is exactly 1', async () => {
      const { cache, inventoryService, reservationService } = buildServices();
      await inventoryService.initializeProductStock('prod-1', 1);

      await reservationService.createReservation({
        reservationRequestId: uuidv4(),
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 1,
      });

      expect(cache.getStockRaw('prod-1')).toBe(0);
    });
  });

  describe('cancelReservation', () => {
    it('should cancel an active reservation and restore stock', async () => {
      const { cache, inventoryService, reservationService, reservationRepo } =
        buildServices();
      await inventoryService.initializeProductStock('prod-1', 5);

      const reservation = await reservationService.createReservation({
        reservationRequestId: uuidv4(),
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 2,
      });

      // Worker would have persisted it; simulate that here
      await reservationRepo.create({
        ...reservation,
        status: ReservationStatus.ACTIVE,
      });

      await reservationService.cancelReservation(reservation.id);

      const updated = await reservationRepo.findById(reservation.id);
      expect(updated?.status).toBe(ReservationStatus.CANCELLED);
      expect(cache.getStockRaw('prod-1')).toBe(5); // fully restored
    });

    it('should throw ReservationNotFoundError for unknown id', async () => {
      const { reservationService } = buildServices();

      await expect(
        reservationService.cancelReservation(uuidv4())
      ).rejects.toThrow(ReservationNotFoundError);
    });

    it('should throw InvalidReservationStateError when cancelling a confirmed reservation', async () => {
      const { inventoryService, reservationService, reservationRepo } =
        buildServices();
      await inventoryService.initializeProductStock('prod-1', 5);

      const reservation = await reservationService.createReservation({
        reservationRequestId: uuidv4(),
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 1,
      });

      // Advance state to CONFIRMED directly
      await reservationRepo.updateStatus(reservation.id, ReservationStatus.CONFIRMED);

      await expect(
        reservationService.cancelReservation(reservation.id)
      ).rejects.toThrow(InvalidReservationStateError);
    });
  });

  describe('confirmReservation', () => {
    it('should confirm an active reservation', async () => {
      const { cache, inventoryService, reservationService, reservationRepo } =
        buildServices();
      await inventoryService.initializeProductStock('prod-1', 5);

      const reservation = await reservationService.createReservation({
        reservationRequestId: uuidv4(),
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 2,
      });

      await reservationRepo.create({
        ...reservation,
        status: ReservationStatus.ACTIVE,
      });

      await reservationService.confirmReservation(reservation.id);

      const updated = await reservationRepo.findById(reservation.id);
      expect(updated?.status).toBe(ReservationStatus.CONFIRMED);

      // Stock stays deducted after confirmation
      expect(cache.getStockRaw('prod-1')).toBe(3);

      // Temporary Redis reservation key should be gone
      expect(cache.hasReservationKey(reservation.id)).toBe(false);
    });

    it('should throw InvalidReservationStateError when confirming an expired reservation', async () => {
      const { inventoryService, reservationService, reservationRepo } =
        buildServices();
      await inventoryService.initializeProductStock('prod-1', 5);

      const reservation = await reservationService.createReservation({
        reservationRequestId: uuidv4(),
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 1,
      });

      // Advance state to EXPIRED directly
      await reservationRepo.updateStatus(reservation.id, ReservationStatus.EXPIRED);

      await expect(
        reservationService.confirmReservation(reservation.id)
      ).rejects.toThrow(InvalidReservationStateError);
    });
  });

  describe('getReservation', () => {
    it('should return an existing reservation', async () => {
      const { inventoryService, reservationService, reservationRepo } =
        buildServices();
      await inventoryService.initializeProductStock('prod-1', 5);

      const reservation = await reservationService.createReservation({
        reservationRequestId: uuidv4(),
        productId: 'prod-1',
        userId: 'user-1',
        quantity: 1,
      });

      await reservationRepo.create({ ...reservation, status: ReservationStatus.ACTIVE });

      const found = await reservationService.getReservation(reservation.id);
      expect(found.id).toBe(reservation.id);
    });

    it('should throw ReservationNotFoundError for missing id', async () => {
      const { reservationService } = buildServices();

      await expect(
        reservationService.getReservation(uuidv4())
      ).rejects.toThrow(ReservationNotFoundError);
    });
  });
});