import Redis from 'ioredis';
import { CacheProvider } from './CacheProvider';
import { RedisConnectionError } from '../../domain/errors';
import { Logger } from 'pino';

export class RedisCacheProvider implements CacheProvider {
  private client: Redis;
  private logger: Logger;

  // Lua script for atomic reservation
  // Checks stock availability and decrements if available
  private readonly RESERVE_SCRIPT = `
    local stock_key = KEYS[1]
    local reservation_key = KEYS[2]
    local quantity = tonumber(ARGV[1])
    local reservation_id = ARGV[2]
    local ttl = tonumber(ARGV[3])
    
    -- Check if reservation already exists (idempotency)
    if redis.call('EXISTS', reservation_key) == 1 then
      return 0  -- Already reserved
    end
    
    -- Get current stock
    local current_stock = tonumber(redis.call('GET', stock_key) or '0')
    
    -- Check if enough stock available
    if current_stock < quantity then
      return -1  -- Insufficient stock
    end
    
    -- Atomically decrement stock and create reservation
    redis.call('DECRBY', stock_key, quantity)
    redis.call('SET', reservation_key, reservation_id)
    redis.call('EXPIRE', reservation_key, ttl)
    
    return 1  -- Success
  `;

  // Lua script for atomic release (cancel/expire)
  private readonly RELEASE_SCRIPT = `
    local stock_key = KEYS[1]
    local reservation_key = KEYS[2]
    local quantity = tonumber(ARGV[1])
    
    -- Check if reservation exists
    if redis.call('EXISTS', reservation_key) == 1 then
      -- Restore stock and delete reservation
      redis.call('INCRBY', stock_key, quantity)
      redis.call('DEL', reservation_key)
      return 1
    end
    
    return 0
  `;

  // Lua script for atomic confirm
  private readonly CONFIRM_SCRIPT = `
    local reservation_key = KEYS[1]
    
    -- Check if reservation exists
    if redis.call('EXISTS', reservation_key) == 1 then
      -- Just delete the reservation (stock already decremented)
      redis.call('DEL', reservation_key)
      return 1
    end
    
    return 0
  `;

  constructor(
    redisUrl: string,
    logger: Logger,
    options: {
      maxRetriesPerRequest?: number;
      enableReadyCheck?: boolean;
      lazyConnect?: boolean;
    } = {}
  ) {
    this.logger = logger;
    
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: options.maxRetriesPerRequest ?? 3,
      enableReadyCheck: options.enableReadyCheck ?? true,
      lazyConnect: options.lazyConnect ?? false,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        this.logger.warn({ times, delay }, 'Redis connection retry');
        return delay;
      },
    });

    this.client.on('error', (err) => {
      this.logger.error({ err }, 'Redis client error');
    });

    this.client.on('connect', () => {
      this.logger.info('Redis client connected');
    });

    this.client.on('ready', () => {
      this.logger.info('Redis client ready');
    });

    this.client.on('close', () => {
      this.logger.warn('Redis connection closed');
    });
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      this.logger.error({ err: error, key }, 'Redis GET error');
      throw new RedisConnectionError('Failed to get value from Redis');
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds) {
        await this.client.setex(key, ttlSeconds, value);
      } else {
        await this.client.set(key, value);
      }
    } catch (error) {
      this.logger.error({ err: error, key }, 'Redis SET error');
      throw new RedisConnectionError('Failed to set value in Redis');
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      this.logger.error({ err: error, key }, 'Redis DEL error');
      throw new RedisConnectionError('Failed to delete key from Redis');
    }
  }

  async incr(key: string): Promise<number> {
    try {
      return await this.client.incr(key);
    } catch (error) {
      this.logger.error({ err: error, key }, 'Redis INCR error');
      throw new RedisConnectionError('Failed to increment value in Redis');
    }
  }

  async decr(key: string): Promise<number> {
    try {
      return await this.client.decr(key);
    } catch (error) {
      this.logger.error({ err: error, key }, 'Redis DECR error');
      throw new RedisConnectionError('Failed to decrement value in Redis');
    }
  }

  async decrBy(key: string, amount: number): Promise<number> {
    try {
      return await this.client.decrby(key, amount);
    } catch (error) {
      this.logger.error({ err: error, key, amount }, 'Redis DECRBY error');
      throw new RedisConnectionError('Failed to decrement value in Redis');
    }
  }

  async incrBy(key: string, amount: number): Promise<number> {
    try {
      return await this.client.incrby(key, amount);
    } catch (error) {
      this.logger.error({ err: error, key, amount }, 'Redis INCRBY error');
      throw new RedisConnectionError('Failed to increment value in Redis');
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      this.logger.error({ err: error, key }, 'Redis EXISTS error');
      throw new RedisConnectionError('Failed to check key existence in Redis');
    }
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.expire(key, ttlSeconds);
    } catch (error) {
      this.logger.error({ err: error, key, ttlSeconds }, 'Redis EXPIRE error');
      throw new RedisConnectionError('Failed to set expiry in Redis');
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      return await this.client.ttl(key);
    } catch (error) {
      this.logger.error({ err: error, key }, 'Redis TTL error');
      throw new RedisConnectionError('Failed to get TTL from Redis');
    }
  }

  async executeAtomicReservation(
    productId: string,
    quantity: number,
    reservationId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    try {
      const stockKey = `inventory:stock:${productId}`;
      const reservationKey = `inventory:reservation:${reservationId}`;

      const result = await this.client.eval(
        this.RESERVE_SCRIPT,
        2,
        stockKey,
        reservationKey,
        quantity.toString(),
        reservationId,
        ttlSeconds.toString()
      ) as number;

      if (result === -1) {
        // Insufficient stock
        return false;
      } else if (result === 0) {
        // Already reserved (idempotent)
        this.logger.info({ reservationId }, 'Duplicate reservation attempt (idempotent)');
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error({ err: error, productId, reservationId }, 'Atomic reservation error');
      throw new RedisConnectionError('Failed to execute atomic reservation');
    }
  }

  async executeAtomicRelease(
    productId: string,
    quantity: number,
    reservationId: string
  ): Promise<void> {
    try {
      const stockKey = `inventory:stock:${productId}`;
      const reservationKey = `inventory:reservation:${reservationId}`;

      await this.client.eval(
        this.RELEASE_SCRIPT,
        2,
        stockKey,
        reservationKey,
        quantity.toString()
      );
    } catch (error) {
      this.logger.error({ err: error, productId, reservationId }, 'Atomic release error');
      throw new RedisConnectionError('Failed to execute atomic release');
    }
  }

  async executeAtomicConfirm(
    productId: string,
    quantity: number,
    reservationId: string
  ): Promise<void> {
    try {
      const reservationKey = `inventory:reservation:${reservationId}`;

      await this.client.eval(
        this.CONFIRM_SCRIPT,
        1,
        reservationKey
      );
    } catch (error) {
      this.logger.error({ err: error, productId, reservationId }, 'Atomic confirm error');
      throw new RedisConnectionError('Failed to execute atomic confirm');
    }
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      this.logger.error({ err: error }, 'Redis PING error');
      return false;
    }
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}