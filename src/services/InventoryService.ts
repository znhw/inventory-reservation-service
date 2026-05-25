import { CacheProvider } from '../infrastructure/cache/CacheProvider';
import { InventoryRepository } from '../infrastructure/repositories/interfaces';
import { InsufficientInventoryError, ProductNotFoundError } from '../domain/errors';
import { Logger } from 'pino';

export interface InventoryService {
  checkAndReserve(
    productId: string,
    quantity: number,
    reservationId: string
  ): Promise<void>;
  releaseReservation(
    productId: string,
    quantity: number,
    reservationId: string
  ): Promise<void>;
  confirmReservation(
    productId: string,
    quantity: number,
    reservationId: string
  ): Promise<void>;
  getAvailableStock(productId: string): Promise<number>;
  initializeProductStock(productId: string, totalStock: number): Promise<void>;
}

export class RedisInventoryService implements InventoryService {
  private readonly RESERVATION_TTL_SECONDS = 120; // 2 minutes

  constructor(
    private cache: CacheProvider,
    private inventoryRepo: InventoryRepository,
    private logger: Logger
  ) {}

  async checkAndReserve(
    productId: string,
    quantity: number,
    reservationId: string
  ): Promise<void> {
    this.logger.info(
      { productId, quantity, reservationId },
      'Attempting atomic reservation'
    );

    // Verify product exists in database
    const product = await this.inventoryRepo.findProductById(productId);
    if (!product) {
      throw new ProductNotFoundError(productId);
    }

    // Execute atomic reservation in Redis
    const success = await this.cache.executeAtomicReservation(
      productId,
      quantity,
      reservationId,
      this.RESERVATION_TTL_SECONDS
    );

    if (!success) {
      const availableStock = await this.getAvailableStock(productId);
      throw new InsufficientInventoryError(productId, quantity, availableStock);
    }

    this.logger.info(
      { productId, quantity, reservationId },
      'Atomic reservation successful'
    );
  }

  async releaseReservation(
    productId: string,
    quantity: number,
    reservationId: string
  ): Promise<void> {
    this.logger.info(
      { productId, quantity, reservationId },
      'Releasing reservation'
    );

    await this.cache.executeAtomicRelease(productId, quantity, reservationId);

    this.logger.info(
      { productId, quantity, reservationId },
      'Reservation released'
    );
  }

  async confirmReservation(
    productId: string,
    quantity: number,
    reservationId: string
  ): Promise<void> {
    this.logger.info(
      { productId, quantity, reservationId },
      'Confirming reservation'
    );

    await this.cache.executeAtomicConfirm(productId, quantity, reservationId);

    this.logger.info(
      { productId, quantity, reservationId },
      'Reservation confirmed'
    );
  }

  async getAvailableStock(productId: string): Promise<number> {
    const stockKey = `inventory:stock:${productId}`;
    const stockStr = await this.cache.get(stockKey);
    
    if (stockStr === null) {
      // If not in cache, check database
      const product = await this.inventoryRepo.findProductById(productId);
      if (!product) {
        return 0;
      }
      
      // Initialize in cache
      await this.initializeProductStock(productId, product.totalStock);
      return product.totalStock;
    }

    return parseInt(stockStr, 10);
  }

  async initializeProductStock(
    productId: string,
    totalStock: number
  ): Promise<void> {
    this.logger.info({ productId, totalStock }, 'Initializing product stock in Redis');

    const stockKey = `inventory:stock:${productId}`;
    await this.cache.set(stockKey, totalStock.toString());

    // Also update in database
    await this.inventoryRepo.initializeStock(productId, totalStock);

    this.logger.info({ productId, totalStock }, 'Product stock initialized');
  }
}