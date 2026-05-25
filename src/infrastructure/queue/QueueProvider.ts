export interface QueueJob<T = unknown> {
  id?: string;
  data: T;
  opts?: {
    delay?: number;
    attempts?: number;
    backoff?: number | { type: string; delay: number };
  };
}

export interface QueueProvider {
  addJob<T>(queueName: string, job: QueueJob<T>): Promise<void>;
  process(
    queueName: string,
    handler: (job: unknown) => Promise<void>,
    concurrency?: number
  ): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
}
