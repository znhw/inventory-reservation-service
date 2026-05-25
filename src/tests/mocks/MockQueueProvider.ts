import { QueueProvider, QueueJob } from '../../infrastructure/queue/QueueProvider';

interface RegisteredHandler {
  handler: (data: unknown) => Promise<void>;
  concurrency: number;
}

/**
 * Synchronous in-process queue for tests.
 * - addJob executes the handler immediately (no real queue) unless
 *   the job has a delay, in which case it is stored for later replay.
 * - Supports delayed-job inspection for expiry tests.
 */
export class MockQueueProvider implements QueueProvider {
  private handlers: Map<string, RegisteredHandler> = new Map();
  private delayedJobs: Map<string, { queueName: string; job: QueueJob }[]> =
    new Map();
  private processedJobs: { queueName: string; data: unknown }[] = [];
  private failNextJob = false;

  reset(): void {
    this.delayedJobs.clear();
    this.processedJobs = [];
    this.failNextJob = false;
  }

  /** Simulate a transient worker failure on the next enqueued job. */
  simulateNextJobFailure(): void {
    this.failNextJob = true;
  }

  async addJob<T>(queueName: string, job: QueueJob<T>): Promise<void> {
    if (job.opts?.delay && job.opts.delay > 0) {
      if (!this.delayedJobs.has(queueName)) {
        this.delayedJobs.set(queueName, []);
      }
      this.delayedJobs.get(queueName)!.push({ queueName, job });
      return;
    }

    const registered = this.handlers.get(queueName);
    if (!registered) return;

    if (this.failNextJob) {
      this.failNextJob = false;
      throw new Error('Simulated job failure');
    }

    await registered.handler(job.data);
    this.processedJobs.push({ queueName, data: job.data });
  }

  async process(
    queueName: string,
    handler: (job: unknown) => Promise<void>,
    concurrency: number = 1
  ): Promise<void> {
    this.handlers.set(queueName, { handler, concurrency });
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  // ── Test helpers ────────────────────────────────────────────────────────────

  /** Manually flush all delayed jobs for a queue (simulates time passing). */
  async flushDelayedJobs(queueName: string): Promise<void> {
    const jobs = this.delayedJobs.get(queueName) ?? [];
    const registered = this.handlers.get(queueName);
    if (!registered) return;

    for (const { job } of jobs) {
      await registered.handler(job.data);
      this.processedJobs.push({ queueName, data: job.data });
    }

    this.delayedJobs.set(queueName, []);
  }

  getProcessedJobs(queueName?: string) {
    if (queueName) {
      return this.processedJobs.filter((j) => j.queueName === queueName);
    }
    return this.processedJobs;
  }

  getDelayedJobs(queueName: string) {
    return this.delayedJobs.get(queueName) ?? [];
  }

  countDelayedJobs(queueName: string): number {
    return this.getDelayedJobs(queueName).length;
  }
}
