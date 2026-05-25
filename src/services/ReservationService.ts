import { v4 as uuidv4 } from 'uuid';
import { Logger } from 'pino';
import {
  CreateReservationRequest,
  Reservation,
  ReservationStatus,
} from '../domain/types';
import {
  DuplicateReservationError,
  InvalidReservationStateError,
  ReservationNotFoundError,
} from '../domain/errors';
import { ReservationRepository } from '../infrastructure/repositories/interfaces';
import { QueueProvider } from '../infrastructure/queue/QueueProvider';
import { InventoryService } from './InventoryService';

export interface ReservationService {
  createReservation(request: CreateReservationRequest): Promise<Reservation>;
  confirmReservation(reservationId: string): Promise<void>;
  cancelReservation(reservationId: string): Promise<void>;
  getReservation(reservationId: string): Promise<Reservation>;
}

export interface ReservationJobData {
  reservationId: string;
  productId: string;
  userId: string;
  quantity: number;
  reservationRequestId: string;
}

export interface ExpiryJobData {
  reservationId: string;
  productId: string;
  quantity: number;
}

export class ReservationServiceImpl implements ReservationService {
  private readonly RESERVATION_QUEUE = 'reservations';
  private readonly EXPIRY_QUEUE = 'reservation-expiry';
  private readonly RESERVATION_HOLD_MS = 120000; // 2 minutes

  constructor(
    private reservationRepo: ReservationRepository,
    private inventoryService: InventoryService,
    private queueProvider: QueueProvider,
    private logger: Logger
  ) {}

  async createReservation(
    request: CreateReservationRequest
  ): Promise<Reservation> {
    this.logger.info({ request }, 'Creating reservation');

    // Check for duplicate reservation request (idempotency)
    const existing = await this.reservationRepo.findByReservationRequestId(
      request.reservationRequestId
    );

    if (existing) {
      this.logger.info(
        { reservationRequestId: request.reservationRequestId },
        'Duplicate reservation request detected'
      );
      throw new DuplicateReservationError(request.reservationRequestId);
    }

    const reservationId = uuidv4();

    // Atomically check inventory and reserve in Redis
    await this.inventoryService.checkAndReserve(
      request.productId,
      request.quantity,
      reservationId
    );

    // Enqueue reservation processing job
    await this.queueProvider.addJob(this.RESERVATION_QUEUE, {
      id: reservationId,
      data: {
        reservationId,
        productId: request.productId,
        userId: request.userId,
        quantity: request.quantity,
        reservationRequestId: request.reservationRequestId,
      } as ReservationJobData,
    });

    // Schedule expiry job
    await this.queueProvider.addJob(this.EXPIRY_QUEUE, {
      id: `expiry-${reservationId}`,
      data: {
        reservationId,
        productId: request.productId,
        quantity: request.quantity,
      } as ExpiryJobData,
      opts: {
        delay: this.RESERVATION_HOLD_MS,
      },
    });

    this.logger.info(
      { reservationId, request },
      'Reservation created and queued'
    );

    // Return a pending reservation object
    // Note: Actual persistence happens in the worker
    const now = new Date();
    return {
      id: reservationId,
      reservationRequestId: request.reservationRequestId,
      productId: request.productId,
      userId: request.userId,
      quantity: request.quantity,
      status: ReservationStatus.ACTIVE,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.RESERVATION_HOLD_MS),
      updatedAt: now,
    };
  }

  async confirmReservation(reservationId: string): Promise<void> {
    this.logger.info({ reservationId }, 'Confirming reservation');

    const reservation = await this.reservationRepo.findById(reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(reservationId);
    }

    if (reservation.status !== ReservationStatus.ACTIVE) {
      throw new InvalidReservationStateError(
        reservationId,
        reservation.status,
        ReservationStatus.ACTIVE
      );
    }

    // Confirm in Redis (removes temporary hold)
    await this.inventoryService.confirmReservation(
      reservation.productId,
      reservation.quantity,
      reservationId
    );

    // Update status in database
    await this.reservationRepo.updateStatus(
      reservationId,
      ReservationStatus.CONFIRMED
    );

    this.logger.info({ reservationId }, 'Reservation confirmed');
  }

  async cancelReservation(reservationId: string): Promise<void> {
    this.logger.info({ reservationId }, 'Cancelling reservation');

    const reservation = await this.reservationRepo.findById(reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(reservationId);
    }

    if (reservation.status !== ReservationStatus.ACTIVE) {
      throw new InvalidReservationStateError(
        reservationId,
        reservation.status,
        ReservationStatus.ACTIVE
      );
    }

    // Release inventory back to Redis
    await this.inventoryService.releaseReservation(
      reservation.productId,
      reservation.quantity,
      reservationId
    );

    // Update status in database
    await this.reservationRepo.updateStatus(
      reservationId,
      ReservationStatus.CANCELLED
    );

    this.logger.info({ reservationId }, 'Reservation cancelled');
  }

  async getReservation(reservationId: string): Promise<Reservation> {
    const reservation = await this.reservationRepo.findById(reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(reservationId);
    }
    return reservation;
  }
}