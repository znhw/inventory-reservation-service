import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { ReservationServiceImpl } from '../../services/ReservationService';
import { RedisInventoryService } from '../../services/InventoryService';
import { InMemoryReservationRepository, InMemoryInventoryRepository } from '../../infrastructure/repositories/InMemoryRepositories';
import { MockCacheProvider } from '../mocks/MockCacheProvider';
import { MockQueueProvider } from '../mocks/MockQueueProvider';
import { ReservationWorker } from '../../workers/processors';
import { ReservationStatus } from '../../domain/types';
import { InsufficientInventoryError } from '../../domain/errors';

const logger = pino({ level: 'silent' });

function buildFullStack(initialStock: number) {
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

  // Wire up the worker so the queue processes jobs
  queue.process('reservations', (data) =>
    reservationWorker.processReservation(data)
  );

  return { cache, queue, reservationRepo, inventoryRepo, inventoryService, reservationService };
}

async function attempt(
  reservationService: ReservationServiceImpl,
  productId: string
): Promise<'success' | 'failure'> {
  try {
    await reservationService.createReservation({
      reservationRequestId: uuidv4(),
      productId,
      userId: uuidv4(),
      quantity: 1,
    });
    return 'success';
  } catch (e) {
    if (e instanceof InsufficientInventoryError) return 'failure';
    throw e;
  }
}

describe('Concurrency — overselling prevention', () => {
  it('stock=1, 500 concurrent requests → exactly 1 success, 499 failures', async () => {
    const { inventoryService, reservationService, cache } = buildFullStack(1);
    await inventoryService.initializeProductStock('flash-prod', 1);

    const results = await Promise.all(
      Array.from({ length: 500 }, () => attempt(reservationService, 'flash-prod'))
    );

    const successes = results.filter((r) => r === 'success').length;
    const failures = results.filter((r) => r === 'failure').length;

    expect(successes).toBe(1);
    expect(failures).toBe(499);

    // Stock must never go negative
    expect(cache.getStockRaw('flash-prod')).toBe(0);
  });

  it('stock=10, 500 concurrent requests → exactly 10 successes', async () => {
    const { inventoryService, reservationService, cache } = buildFullStack(10);
    await inventoryService.initializeProductStock('flash-prod-10', 10);

    const results = await Promise.all(
      Array.from({ length: 500 }, () =>
        attempt(reservationService, 'flash-prod-10')
      )
    );

    const successes = results.filter((r) => r === 'success').length;
    expect(successes).toBe(10);
    expect(cache.getStockRaw('flash-prod-10')).toBe(0);
  });

  it('stock=0 → all 100 requests fail immediately', async () => {
    const { inventoryService, reservationService } = buildFullStack(0);
    await inventoryService.initializeProductStock('empty-prod', 0);

    const results = await Promise.all(
      Array.from({ length: 100 }, () => attempt(reservationService, 'empty-prod'))
    );

    expect(results.every((r) => r === 'failure')).toBe(true);
  });

  it('stock never goes negative under concurrent load', async () => {
    const { inventoryService, reservationService, cache } = buildFullStack(5);
    await inventoryService.initializeProductStock('prod-neg', 5);

    await Promise.all(
      Array.from({ length: 200 }, () => attempt(reservationService, 'prod-neg'))
    );

    const remaining = cache.getStockRaw('prod-neg');
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThanOrEqual(5);
  });

  it('same reservationRequestId submitted concurrently → only 1 reservation persisted', async () => {
    const { inventoryService, reservationService, reservationRepo } =
      buildFullStack(100);
    await inventoryService.initializeProductStock('prod-idem', 100);

    const sharedRequestId = uuidv4();

    // In a real distributed system the duplicate guard is enforced by Redis
    // (atomic Lua key + DB unique constraint). In the in-memory mock the JS
    // event loop serialises awaits, so concurrent calls may all pass the
    // pre-enqueue check before the first one is persisted.
    // The authoritative guarantee we test: the DB must contain exactly 1
    // persisted record per reservationRequestId (enforced by the worker's
    // findById idempotency check + the repo's request-id index).
    await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        reservationService.createReservation({
          reservationRequestId: sharedRequestId,
          productId: 'prod-idem',
          userId: 'user-1',
          quantity: 1,
        })
      )
    );

    // The DB must contain at most 1 reservation for this requestId
    const all = reservationRepo.getAll();
    const withSharedId = all.filter(
      (r) => r.reservationRequestId === sharedRequestId
    );
    expect(withSharedId).toHaveLength(1);
  });

  it('cancel restores stock so a subsequent request can succeed', async () => {
    const { inventoryService, reservationService, reservationRepo, cache } =
      buildFullStack(1);
    await inventoryService.initializeProductStock('prod-restore', 1);

    // Reserve the only item
    const first = await reservationService.createReservation({
      reservationRequestId: uuidv4(),
      productId: 'prod-restore',
      userId: 'user-a',
      quantity: 1,
    });
    await reservationRepo.create({ ...first, status: ReservationStatus.ACTIVE });
    expect(cache.getStockRaw('prod-restore')).toBe(0);

    // Second request should fail while first is active
    const beforeCancel = await attempt(reservationService, 'prod-restore');
    expect(beforeCancel).toBe('failure');

    // Cancel first
    await reservationService.cancelReservation(first.id);
    expect(cache.getStockRaw('prod-restore')).toBe(1);

    // Now a new request should succeed
    const afterCancel = await attempt(reservationService, 'prod-restore');
    expect(afterCancel).toBe('success');
  });
});