import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import pino from 'pino';
import { Config } from '../config/config';
import { RedisCacheProvider } from '../infrastructure/cache/RedisCacheProvider';
import { BullMQProvider } from '../infrastructure/queue/BullMQProvider';
import {
  InMemoryReservationRepository,
  InMemoryInventoryRepository,
} from '../infrastructure/repositories/InMemoryRepositories';
import { RedisInventoryService } from '../services/InventoryService';
import { ReservationServiceImpl } from '../services/ReservationService';
import { ReservationWorker, ExpiryWorker } from '../workers/processors';
import { registerRoutes } from '../api/routes';

export interface AppComponents {
  fastify: FastifyInstance;
  cache: RedisCacheProvider;
  queue: BullMQProvider;
  logger: pino.Logger;
}

export async function createApp(config: Config): Promise<AppComponents> {
  // Create logger
  const logger = pino({
    level: config.logLevel,
    transport:
      config.env === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  });

  // Create infrastructure components
  const cache = new RedisCacheProvider(config.redisUrl, logger);
  const queue = new BullMQProvider(config.redisUrl, logger);

  // Create repositories
  const reservationRepo = new InMemoryReservationRepository();
  const inventoryRepo = new InMemoryInventoryRepository();

  // Create services
  const inventoryService = new RedisInventoryService(
    cache,
    inventoryRepo,
    logger
  );

  const reservationService = new ReservationServiceImpl(
    reservationRepo,
    inventoryService,
    queue,
    logger
  );

  // Create workers
  const reservationWorker = new ReservationWorker(reservationRepo, logger);
  const expiryWorker = new ExpiryWorker(
    reservationRepo,
    inventoryService,
    logger
  );

  // Start queue workers
  await queue.process(
    'reservations',
    async (jobData) => {
      await reservationWorker.processReservation(jobData);
    },
    config.queueConcurrency
  );

  await queue.process(
    'reservation-expiry',
    async (jobData) => {
      await expiryWorker.processExpiry(jobData);
    },
    config.queueConcurrency
  );

  // Create Fastify instance
  const fastify = Fastify({
    logger,
    requestIdLogLabel: 'reqId',
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
  });

  // Register plugins
  await fastify.register(cors, {
    origin: true,
    credentials: true,
  });

  // Register routes
  await registerRoutes(fastify, reservationService, inventoryService);

  // Graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');

    try {
      await fastify.close();
      await queue.close();
      await cache.disconnect();
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return {
    fastify,
    cache,
    queue,
    logger,
  };
}

export async function startServer(
  fastify: FastifyInstance,
  config: Config,
  logger: pino.Logger
): Promise<void> {
  try {
    await fastify.listen({
      port: config.port,
      host: config.host,
    });

    logger.info(
      { port: config.port, host: config.host },
      'Server started successfully'
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}