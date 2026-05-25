import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { registerRoutes } from '../../api/routes';
import { ReservationServiceImpl } from '../../services/ReservationService';
import { RedisInventoryService } from '../../services/InventoryService';
import { InMemoryReservationRepository, InMemoryInventoryRepository } from '../../infrastructure/repositories/InMemoryRepositories';
import { MockCacheProvider } from '../mocks/MockCacheProvider';
import { MockQueueProvider } from '../mocks/MockQueueProvider';
import { ReservationWorker } from '../../workers/processors';
import { ReservationStatus } from '../../domain/types';

const logger = pino({ level: 'silent' });

async function buildTestApp() {
  const cache = new MockCacheProvider();
  const queue = new MockQueueProvider();
  const reservationRepo = new InMemoryReservationRepository();
  const inventoryRepo = new InMemoryInventoryRepository();
  const reservationWorker = new ReservationWorker(reservationRepo, logger);

  const inventoryService = new RedisInventoryService(cache, inventoryRepo, logger);
  const reservationService = new ReservationServiceImpl(
    reservationRepo,
    inventoryService,
    queue,
    logger
  );

  queue.process('reservations', (data) =>
    reservationWorker.processReservation(data)
  );

  const app = Fastify({ logger: false });
  await registerRoutes(app, reservationService, inventoryService);
  await app.ready();

  return { app, cache, queue, reservationRepo, inventoryService };
}

describe('API Routes', () => {
  let app: FastifyInstance;
  let cache: MockCacheProvider;
  let inventoryService: RedisInventoryService;
  let reservationRepo: InMemoryReservationRepository;

  beforeEach(async () => {
    ({ app, cache, inventoryService, reservationRepo } = await buildTestApp());
  });

  afterEach(async () => {
    await app.close();
  });

  // ── Health ────────────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('should return 200 with status ok', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'ok' });
    });
  });

  // ── Inventory ─────────────────────────────────────────────────────────────

  describe('POST /inventory/initialize', () => {
    it('should initialize product stock and return 200', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/inventory/initialize',
        payload: { productId: 'prod-1', totalStock: 50 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: true,
        data: { productId: 'prod-1', totalStock: 50 },
      });
      expect(cache.getStockRaw('prod-1')).toBe(50);
    });

    it('should return 400 for missing productId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/inventory/initialize',
        payload: { totalStock: 50 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().success).toBe(false);
    });

    it('should return 400 for negative stock', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/inventory/initialize',
        payload: { productId: 'prod-1', totalStock: -5 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /inventory/:productId', () => {
    it('should return available stock', async () => {
      await inventoryService.initializeProductStock('prod-1', 30);

      const res = await app.inject({
        method: 'GET',
        url: '/inventory/prod-1',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        success: true,
        data: { productId: 'prod-1', availableStock: 30 },
      });
    });
  });

  // ── Reservations ──────────────────────────────────────────────────────────

  describe('POST /reservations', () => {
    it('should create a reservation and return 201', async () => {
      await inventoryService.initializeProductStock('prod-2', 10);

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: {
          reservationRequestId: uuidv4(),
          productId: 'prod-2',
          userId: 'user-1',
          quantity: 2,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.productId).toBe('prod-2');
      expect(body.data.status).toBe(ReservationStatus.ACTIVE);
      expect(cache.getStockRaw('prod-2')).toBe(8);
    });

    it('should return 400 when stock is insufficient', async () => {
      await inventoryService.initializeProductStock('prod-3', 1);

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: {
          reservationRequestId: uuidv4(),
          productId: 'prod-3',
          userId: 'user-1',
          quantity: 5,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INSUFFICIENT_INVENTORY');
    });

    it('should return 409 for duplicate reservationRequestId', async () => {
      await inventoryService.initializeProductStock('prod-4', 10);
      const requestId = uuidv4();

      await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: {
          reservationRequestId: requestId,
          productId: 'prod-4',
          userId: 'user-1',
          quantity: 1,
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: {
          reservationRequestId: requestId,
          productId: 'prod-4',
          userId: 'user-1',
          quantity: 1,
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE_RESERVATION');
    });

    it('should return 400 for invalid payload (non-uuid requestId)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: {
          reservationRequestId: 'not-a-uuid',
          productId: 'prod-1',
          userId: 'user-1',
          quantity: 1,
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should return 400 for zero quantity', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: {
          reservationRequestId: uuidv4(),
          productId: 'prod-1',
          userId: 'user-1',
          quantity: 0,
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /reservations/:reservationId', () => {
    it('should return an existing reservation', async () => {
      await inventoryService.initializeProductStock('prod-5', 5);

      const created = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: {
          reservationRequestId: uuidv4(),
          productId: 'prod-5',
          userId: 'user-1',
          quantity: 1,
        },
      });

      const reservationId = created.json().data.id;

      // Persist via worker (simulated by queue)
      await reservationRepo.create({
        ...created.json().data,
        status: ReservationStatus.ACTIVE,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${reservationId}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.id).toBe(reservationId);
    });

    it('should return 404 for unknown reservationId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/reservations/${uuidv4()}`,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('RESERVATION_NOT_FOUND');
    });

    it('should return 400 for non-uuid reservationId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/reservations/not-a-uuid',
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /reservations/:reservationId/confirm', () => {
    it('should confirm an active reservation', async () => {
      await inventoryService.initializeProductStock('prod-6', 5);

      const created = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: {
          reservationRequestId: uuidv4(),
          productId: 'prod-6',
          userId: 'user-1',
          quantity: 1,
        },
      });

      const reservation = created.json().data;
      await reservationRepo.create({
        ...reservation,
        status: ReservationStatus.ACTIVE,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${reservation.id}/confirm`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('should return 400 when confirming already-expired reservation', async () => {
      await inventoryService.initializeProductStock('prod-6', 5);

      const created = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: {
          reservationRequestId: uuidv4(),
          productId: 'prod-6',
          userId: 'user-1',
          quantity: 1,
        },
      });

      const reservation = created.json().data;
      // Advance state to EXPIRED directly
      await reservationRepo.updateStatus(reservation.id, ReservationStatus.EXPIRED);

      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${reservation.id}/confirm`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_RESERVATION_STATE');
    });
  });

  describe('POST /reservations/:reservationId/cancel', () => {
    it('should cancel an active reservation and restore stock', async () => {
      await inventoryService.initializeProductStock('prod-7', 5);

      const created = await app.inject({
        method: 'POST',
        url: '/reservations',
        payload: {
          reservationRequestId: uuidv4(),
          productId: 'prod-7',
          userId: 'user-1',
          quantity: 2,
        },
      });

      const reservation = created.json().data;
      await reservationRepo.create({
        ...reservation,
        status: ReservationStatus.ACTIVE,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/reservations/${reservation.id}/cancel`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(cache.getStockRaw('prod-7')).toBe(5); // restored
    });
  });
});