import { Reservation, Product, ReservationStatus } from '../../domain/types';
 
export interface ReservationRepository {
  create(reservation: Omit<Reservation, 'createdAt' | 'updatedAt'> & { id?: string }): Promise<Reservation>;
  findById(id: string): Promise<Reservation | null>;
  findByReservationRequestId(reservationRequestId: string): Promise<Reservation | null>;
  updateStatus(id: string, status: ReservationStatus): Promise<void>;
  findActiveReservationsByProduct(productId: string): Promise<Reservation[]>;
}
 
export interface InventoryRepository {
  findProductById(productId: string): Promise<Product | null>;
  initializeStock(productId: string, stock: number): Promise<void>;
  getAvailableStock(productId: string): Promise<number>;
}