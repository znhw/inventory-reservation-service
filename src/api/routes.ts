import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ReservationService } from '../services/ReservationService';
import { InventoryService } from '../services/InventoryService';
import { AppError } from '../domain/errors';

// Validation schemas
const CreateReservationSchema = z.object({
  reservationRequestId: z.string().uuid(),
  productId: z.string().min(1),
  userId: z.string().min(1),
  quantity: z.number().int().positive(),
});

const ReservationIdSchema = z.object({
  reservationId: z.string().uuid(),
});

const InitializeStockSchema = z.object({
  productId: z.string().min(1),
  totalStock: z.number().int().min(0),
});

const GetStockSchema = z.object({
  productId: z.string().min(1),
});

export async function registerRoutes(
  app: FastifyInstance,
  reservationService: ReservationService,
  inventoryService: InventoryService
): Promise<void> {
  // Health check
  app.get('/health', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  // Create reservation
  app.post(
    '/reservations',
    async (
      request: FastifyRequest<{
        Body: z.infer<typeof CreateReservationSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const data = CreateReservationSchema.parse(request.body);
        const reservation = await reservationService.createReservation(data);

        return reply.code(201).send({
          success: true,
          data: reservation,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            success: false,
            error: 'Validation error',
            details: error.issues,
          });
        }
        throw error;
      }
    }
  );

  // Get reservation
  app.get(
    '/reservations/:reservationId',
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof ReservationIdSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { reservationId } = ReservationIdSchema.parse(request.params);
        const reservation = await reservationService.getReservation(
          reservationId
        );

        return reply.code(200).send({
          success: true,
          data: reservation,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            success: false,
            error: 'Validation error',
            details: error.issues,
          });
        }
        throw error;
      }
    }
  );

  // Confirm reservation
  app.post(
    '/reservations/:reservationId/confirm',
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof ReservationIdSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { reservationId } = ReservationIdSchema.parse(request.params);
        await reservationService.confirmReservation(reservationId);

        return reply.code(200).send({
          success: true,
          message: 'Reservation confirmed successfully',
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            success: false,
            error: 'Validation error',
            details: error.issues,
          });
        }
        throw error;
      }
    }
  );

  // Cancel reservation
  app.post(
    '/reservations/:reservationId/cancel',
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof ReservationIdSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { reservationId } = ReservationIdSchema.parse(request.params);
        await reservationService.cancelReservation(reservationId);

        return reply.code(200).send({
          success: true,
          message: 'Reservation cancelled successfully',
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            success: false,
            error: 'Validation error',
            details: error.issues,
          });
        }
        throw error;
      }
    }
  );

  // Initialize product stock (admin endpoint)
  app.post(
    '/inventory/initialize',
    async (
      request: FastifyRequest<{
        Body: z.infer<typeof InitializeStockSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { productId, totalStock } = InitializeStockSchema.parse(
          request.body
        );
        await inventoryService.initializeProductStock(productId, totalStock);

        return reply.code(200).send({
          success: true,
          message: 'Product stock initialized successfully',
          data: { productId, totalStock },
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            success: false,
            error: 'Validation error',
            details: error.issues,
          });
        }
        throw error;
      }
    }
  );

  // Get available stock
  app.get(
    '/inventory/:productId',
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof GetStockSchema>;
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { productId } = GetStockSchema.parse(request.params);
        const availableStock = await inventoryService.getAvailableStock(
          productId
        );

        return reply.code(200).send({
          success: true,
          data: {
            productId,
            availableStock,
          },
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            success: false,
            error: 'Validation error',
            details: error.issues,
          });
        }
        throw error;
      }
    }
  );

  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      request.log.error(
        {
          err: error,
          code: error.code,
          statusCode: error.statusCode,
        },
        'Application error'
      );

      return reply.code(error.statusCode).send({
        success: false,
        error: error.message,
        code: error.code,
      });
    }

    // Unexpected errors
    request.log.error({ err: error }, 'Unexpected error');

    return reply.code(500).send({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  });
}