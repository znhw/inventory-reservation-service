import { Logger } from 'pino';
import { ReservationRepository } from '../infrastructure/repositories/interfaces';
import { InventoryService } from '../services/InventoryService';
import {
  ReservationJobData,
  ExpiryJobData,
} from '../services/ReservationService';
import { ReservationStatus } from '../domain/types';

export class ReservationWorker {
  constructor(
    private reservationRepo: ReservationRepository,
    private logger: Logger
  ) {}

  async processReservation(jobData: ReservationJobData): Promise<void> {
    this.logger.info({ jobData }, 'Processing reservation job');

    const { reservationId, productId, userId, quantity, reservationRequestId } =
      jobData;

    try {
      // Check if reservation already exists (idempotency)
      const existing = await this.reservationRepo.findById(reservationId);
      if (existing) {
        this.logger.info(
          { reservationId },
          'Reservation already exists, skipping'
        );
        return;
      }

      // Persist reservation to database
      const expiresAt = new Date(Date.now() + 120000); // 2 minutes from now

      await this.reservationRepo.create({
        id: reservationId,
        reservationRequestId,
        productId,
        userId,
        quantity,
        status: ReservationStatus.ACTIVE,
        expiresAt,
      });

      this.logger.info({ reservationId }, 'Reservation persisted to database');
    } catch (error) {
      this.logger.error(
        { err: error, jobData },
        'Failed to process reservation job'
      );
      throw error;
    }
  }
}

export class ExpiryWorker {
  constructor(
    private reservationRepo: ReservationRepository,
    private inventoryService: InventoryService,
    private logger: Logger
  ) {}

  async processExpiry(jobData: ExpiryJobData): Promise<void> {
    this.logger.info({ jobData }, 'Processing expiry job');

    const { reservationId, productId, quantity } = jobData;

    try {
      const reservation = await this.reservationRepo.findById(reservationId);

      // If reservation doesn't exist or already processed, skip
      if (!reservation) {
        this.logger.warn(
          { reservationId },
          'Reservation not found, may have been already processed'
        );
        return;
      }

      // Only expire if still ACTIVE
      if (reservation.status !== ReservationStatus.ACTIVE) {
        this.logger.info(
          { reservationId, status: reservation.status },
          'Reservation already processed, skipping expiry'
        );
        return;
      }

      // Check if actually expired (handle clock drift and delayed jobs)
      const now = new Date();
      if (now < reservation.expiresAt) {
        this.logger.warn(
          { reservationId, expiresAt: reservation.expiresAt, now },
          'Expiry job ran early, skipping'
        );
        return;
      }

      // Release inventory back to Redis
      await this.inventoryService.releaseReservation(
        productId,
        quantity,
        reservationId
      );

      // Update status to EXPIRED
      await this.reservationRepo.updateStatus(
        reservationId,
        ReservationStatus.EXPIRED
      );

      this.logger.info({ reservationId }, 'Reservation expired successfully');
    } catch (error) {
      this.logger.error({ err: error, jobData }, 'Failed to process expiry job');
      throw error;
    }
  }
}