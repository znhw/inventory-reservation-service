export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'INTERNAL_ERROR',
    public isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class InsufficientInventoryError extends AppError {
  constructor(productId: string, requested: number, available: number) {
    super(
      `Insufficient inventory for product ${productId}. Requested: ${requested}, Available: ${available}`,
      400,
      'INSUFFICIENT_INVENTORY'
    );
  }
}

export class DuplicateReservationError extends AppError {
  constructor(reservationRequestId: string) {
    super(
      `Reservation request ${reservationRequestId} already exists`,
      409,
      'DUPLICATE_RESERVATION'
    );
  }
}

export class ReservationNotFoundError extends AppError {
  constructor(reservationId: string) {
    super(
      `Reservation ${reservationId} not found`,
      404,
      'RESERVATION_NOT_FOUND'
    );
  }
}

export class InvalidReservationStateError extends AppError {
  constructor(reservationId: string, currentState: string, expectedState: string) {
    super(
      `Invalid reservation state. Reservation ${reservationId} is ${currentState}, expected ${expectedState}`,
      400,
      'INVALID_RESERVATION_STATE'
    );
  }
}

export class ProductNotFoundError extends AppError {
  constructor(productId: string) {
    super(
      `Product ${productId} not found`,
      404,
      'PRODUCT_NOT_FOUND'
    );
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class RedisConnectionError extends AppError {
  constructor(message: string) {
    super(message, 503, 'REDIS_CONNECTION_ERROR');
  }
}

export class QueueError extends AppError {
  constructor(message: string) {
    super(message, 503, 'QUEUE_ERROR');
  }
}