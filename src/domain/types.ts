export enum ReservationStatus {
  ACTIVE = 'ACTIVE',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export interface Reservation {
  id: string;
  reservationRequestId: string;
  productId: string;
  userId: string;
  quantity: number;
  status: ReservationStatus;
  createdAt: Date;
  expiresAt: Date;
  updatedAt: Date;
}

export interface CreateReservationRequest {
  reservationRequestId: string;
  productId: string;
  userId: string;
  quantity: number;
}

export interface Product {
  id: string;
  name: string;
  totalStock: number;
}

export interface InventorySnapshot {
  productId: string;
  totalStock: number;
  availableStock: number;
  activeReservations: number;
  confirmedSales: number;
}