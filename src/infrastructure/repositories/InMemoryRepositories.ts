import { v4 as uuidv4 } from 'uuid';
import { Reservation, Product, ReservationStatus } from '../../domain/types';
import { ReservationRepository, InventoryRepository } from './interfaces';

export class InMemoryReservationRepository implements ReservationRepository {
  private reservations: Map<string, Reservation> = new Map();
  private reservationRequestIndex: Map<string, string> = new Map();

  async create(
    data: Omit<Reservation, 'createdAt' | 'updatedAt'> & { id?: string }
  ): Promise<Reservation> {
    // Enforce unique constraint on reservationRequestId (mirrors DB behaviour)
    if (this.reservationRequestIndex.has(data.reservationRequestId)) {
      const existingId = this.reservationRequestIndex.get(data.reservationRequestId)!;
      return this.reservations.get(existingId)!;
    }

    const now = new Date();
    const reservation: Reservation = {
      ...data,
      id: data.id ?? uuidv4(),
      createdAt: now,
      updatedAt: now,
    };

    this.reservations.set(reservation.id, reservation);
    this.reservationRequestIndex.set(
      reservation.reservationRequestId,
      reservation.id
    );

    return reservation;
  }

  async findById(id: string): Promise<Reservation | null> {
    return this.reservations.get(id) || null;
  }

  async findByReservationRequestId(
    reservationRequestId: string
  ): Promise<Reservation | null> {
    const id = this.reservationRequestIndex.get(reservationRequestId);
    if (!id) return null;
    return this.findById(id);
  }

  async updateStatus(id: string, status: ReservationStatus): Promise<void> {
    const reservation = this.reservations.get(id);
    if (!reservation) {
      throw new Error(`Reservation ${id} not found`);
    }

    reservation.status = status;
    reservation.updatedAt = new Date();
    this.reservations.set(id, reservation);
  }

  async findActiveReservationsByProduct(
    productId: string
  ): Promise<Reservation[]> {
    return Array.from(this.reservations.values()).filter(
      (r) => r.productId === productId && r.status === ReservationStatus.ACTIVE
    );
  }

  // Utility methods for testing
  clear(): void {
    this.reservations.clear();
    this.reservationRequestIndex.clear();
  }

  getAll(): Reservation[] {
    return Array.from(this.reservations.values());
  }
}

export class InMemoryInventoryRepository implements InventoryRepository {
  private products: Map<string, Product> = new Map();

  async findProductById(productId: string): Promise<Product | null> {
    return this.products.get(productId) || null;
  }

  async initializeStock(productId: string, stock: number): Promise<void> {
    const existing = this.products.get(productId);
    if (existing) {
      existing.totalStock = stock;
      this.products.set(productId, existing);
    } else {
      this.products.set(productId, {
        id: productId,
        name: `Product ${productId}`,
        totalStock: stock,
      });
    }
  }

  async getAvailableStock(productId: string): Promise<number> {
    const product = this.products.get(productId);
    return product?.totalStock || 0;
  }

  // Utility methods for testing
  clear(): void {
    this.products.clear();
  }

  addProduct(product: Product): void {
    this.products.set(product.id, product);
  }
}