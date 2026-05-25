import { z } from 'zod';

const ConfigSchema = z.object({
  // Server
  port: z.number().int().positive().default(3000),
  host: z.string().default('0.0.0.0'),
  env: z.enum(['development', 'production', 'test']).default('development'),

  // Redis
  redisUrl: z.string().url().default('redis://localhost:6379'),

  // Queue
  queueConcurrency: z.number().int().positive().default(5),

  // Logging
  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const config = {
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
    host: process.env.HOST || '0.0.0.0',
    env: process.env.NODE_ENV || 'development',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    queueConcurrency: process.env.QUEUE_CONCURRENCY
      ? parseInt(process.env.QUEUE_CONCURRENCY, 10)
      : 5,
    logLevel: process.env.LOG_LEVEL || 'info',
  };

  return ConfigSchema.parse(config);
}