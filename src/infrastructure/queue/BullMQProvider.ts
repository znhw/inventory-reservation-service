import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { QueueProvider, QueueJob } from './QueueProvider';
import { QueueError } from '../../domain/errors';
import { Logger } from 'pino';
import Redis from 'ioredis';

export class BullMQProvider implements QueueProvider {
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private queueEvents: Map<string, QueueEvents> = new Map();
  private connection: Redis;
  private logger: Logger;

  constructor(redisUrl: string, logger: Logger) {
    this.logger = logger;
    this.connection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    this.connection.on('error', (err) => {
      this.logger.error({ err }, 'Queue Redis connection error');
    });
  }

  private getQueue(queueName: string): Queue {
    if (!this.queues.has(queueName)) {
      const queue = new Queue(queueName, {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
          removeOnComplete: {
            age: 3600, // Keep completed jobs for 1 hour
            count: 1000,
          },
          removeOnFail: {
            age: 86400, // Keep failed jobs for 24 hours
          },
        },
      });

      // Set up queue events for monitoring
      const events = new QueueEvents(queueName, {
        connection: this.connection.duplicate(),
      });

      events.on('failed', ({ jobId, failedReason }) => {
        this.logger.error(
          { queueName, jobId, failedReason },
          'Job failed'
        );
      });

      events.on('completed', ({ jobId }) => {
        this.logger.info({ queueName, jobId }, 'Job completed');
      });

      this.queues.set(queueName, queue);
      this.queueEvents.set(queueName, events);
    }

    return this.queues.get(queueName)!;
  }

  async addJob<T>(queueName: string, job: QueueJob<T>): Promise<void> {
    try {
      const queue = this.getQueue(queueName);
      
      await queue.add(
        job.id || 'job',
        job.data,
        {
          jobId: job.id,
          delay: job.opts?.delay,
          attempts: job.opts?.attempts,
          backoff: job.opts?.backoff,
        }
      );

      this.logger.debug({ queueName, jobId: job.id }, 'Job added to queue');
    } catch (error) {
      this.logger.error({ err: error, queueName, jobId: job.id }, 'Failed to add job to queue');
      throw new QueueError(`Failed to add job to queue ${queueName}`);
    }
  }

  async process<T>(
    queueName: string,
    handler: (job: T) => Promise<void>,
    concurrency: number = 1
  ): Promise<void> {
    try {
      if (this.workers.has(queueName)) {
        this.logger.warn({ queueName }, 'Worker already exists for queue');
        return;
      }

      const worker = new Worker(
        queueName,
        async (job: Job<T>) => {
          this.logger.info(
            { queueName, jobId: job.id, data: job.data },
            'Processing job'
          );

          try {
            await handler(job.data);
          } catch (error) {
            this.logger.error(
              { err: error, queueName, jobId: job.id },
              'Job handler error'
            );
            throw error;
          }
        },
        {
          connection: this.connection.duplicate(),
          concurrency,
          limiter: {
            max: 100,
            duration: 1000, // Max 100 jobs per second
          },
        }
      );

      worker.on('completed', (job) => {
        this.logger.info({ queueName, jobId: job.id }, 'Worker completed job');
      });

      worker.on('failed', (job, err) => {
        this.logger.error(
          { queueName, jobId: job?.id, err },
          'Worker failed to process job'
        );
      });

      worker.on('error', (err) => {
        this.logger.error({ queueName, err }, 'Worker error');
      });

      this.workers.set(queueName, worker);
      this.logger.info({ queueName, concurrency }, 'Worker started');
    } catch (error) {
      this.logger.error({ err: error, queueName }, 'Failed to start worker');
      throw new QueueError(`Failed to start worker for queue ${queueName}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.connection.ping();
      return result === 'PONG';
    } catch (error) {
      this.logger.error({ err: error }, 'Queue health check failed');
      return false;
    }
  }

  async close(): Promise<void> {
    this.logger.info('Closing queue connections');

    // Close all workers
    for (const [name, worker] of this.workers.entries()) {
      this.logger.info({ queueName: name }, 'Closing worker');
      await worker.close();
    }

    // Close all queue events
    for (const [name, events] of this.queueEvents.entries()) {
      this.logger.info({ queueName: name }, 'Closing queue events');
      await events.close();
    }

    // Close all queues
    for (const [name, queue] of this.queues.entries()) {
      this.logger.info({ queueName: name }, 'Closing queue');
      await queue.close();
    }

    // Close connection
    await this.connection.quit();
    
    this.logger.info('All queue connections closed');
  }
}