export interface CacheProvider {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  decrBy(key: string, amount: number): Promise<number>;
  incrBy(key: string, amount: number): Promise<number>;
  exists(key: string): Promise<boolean>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  ttl(key: string): Promise<number>;
  
  // Atomic operations via Lua script
  executeAtomicReservation(
    productId: string,
    quantity: number,
    reservationId: string,
    ttlSeconds: number
  ): Promise<boolean>;
  
  executeAtomicRelease(
    productId: string,
    quantity: number,
    reservationId: string
  ): Promise<void>;
  
  executeAtomicConfirm(
    productId: string,
    quantity: number,
    reservationId: string
  ): Promise<void>;
  
  // Health check
  ping(): Promise<boolean>;
}