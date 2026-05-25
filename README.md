# Inventory Reservation System

A high-concurrency inventory reservation system built with Node.js, Redis, and asynchronous queue processing to prevent overselling during flash sale events.

This project uses Redis atomic operations and BullMQ-based background processing to coordinate reservations safely under load, while PostgreSQL remains the durable source of truth.

---

# Table of Contents

* [Overview](#overview)
* [Problem Statement](#problem-statement)
* [Objectives](#objectives)
* [Tech Stack](#tech-stack)
* [Architecture](#architecture)
* [Reservation Flow](#reservation-flow)
* [Lifecycle](#lifecycle)
* [Expiry Handling](#expiry-handling)
* [Overselling Prevention](#overselling-prevention)
* [Available Stock](#available-stock)
* [Example Scenario](#example-scenario)
* [Idempotency](#idempotency)
* [Redis Responsibilities](#redis-responsibilities)
* [PostgreSQL Responsibilities](#postgresql-responsibilities)
* [BullMQ Usage](#bullmq-usage)
* [Scalability](#scalability)
* [Hot Product Strategy](#hot-product-strategy)
* [Testing Strategy](#testing-strategy)
* [Design Principles](#design-principles)
* [Future Enhancements](#future-enhancements)
* [Conclusion](#conclusion)

---

# Overview

Flash sales create extreme concurrency when many users attempt to reserve the same limited stock at once.

This system is designed to:

* Prevent overselling
* Handle reservation spikes
* Support temporary holds
* Release expired reservations automatically
* Keep inventory state consistent
* Scale through asynchronous processing

---

# Problem Statement

Flash sales generate extremely high traffic where hundreds or thousands of users may attempt to reserve the same limited-stock product simultaneously.

## Example

* Stock Available: `1`
* Concurrent Requests: `500`
* Expected Successful Reservations: `1`
* Expected Failures: `499`

Without proper concurrency handling, multiple users may reserve the same inventory at the same time, causing overselling and inconsistent inventory states.

The goal of this system is to strongly reduce the risk of inventory inconsistency under high concurrency while remaining scalable and production-oriented.

---

# Objectives

* Prevent overselling
* Handle high-concurrency reservation requests
* Support temporary inventory reservations
* Automatically release expired reservations
* Maintain consistent inventory state
* Support scalable asynchronous processing

---

# Tech Stack

## Backend

* Node.js
* TypeScript
* Fastify

## Cache / Atomic Coordination

* Redis

## Queue System

* BullMQ

## Database

* PostgreSQL

## Testing

* Vitest / Jest
* Supertest
* Concurrent load testing

---

# Architecture

```text
Client
  ↓
Fastify API
  ↓
Redis Atomic Reservation Check
  ↓
BullMQ Queue
  ↓
Reservation Worker
  ↓
PostgreSQL
```

## Why This Architecture Works

Traditional mutex locking approaches work well in single-process applications but become harder to scale in distributed systems.

This project intentionally uses:

* Redis atomic operations
* Asynchronous queue processing
* Event-driven architecture

Instead of depending on in-process locks for distributed coordination.

## Benefits

* Improved scalability
* Reduced contention
* Better handling of traffic spikes
* Simplified distributed processing
* Resilient asynchronous workflows

---

# Reservation Flow

1. User sends reservation request
2. API validates request
3. Redis atomically checks inventory availability
4. Stock is temporarily deducted
5. Reservation job is pushed into BullMQ
6. Worker processes reservation asynchronously
7. Reservation is stored in PostgreSQL
8. Expiry job is scheduled

> Important: the Redis stock deduction and reservation claim must happen atomically in one Redis operation or Lua script, otherwise a crash between steps can leak stock.

---

# Lifecycle

Reservations move through the following states:

* `ACTIVE`
* `CONFIRMED`
* `CANCELLED`
* `EXPIRED`

## ACTIVE

* Inventory is temporarily reserved
* Stock becomes unavailable
* Reservation expiration timer starts

## CONFIRMED

* Purchase completed successfully
* Inventory is permanently deducted
* Reservation finalized

## CANCELLED

* Reservation manually cancelled
* Inventory restored

## EXPIRED

* Reservation exceeded hold duration
* Inventory automatically released
* Reservation invalidated

---

# Expiry Handling

Reservation hold duration: `2 minutes`

BullMQ delayed jobs are used to schedule expiry processing, but delayed jobs are not guaranteed to run at the exact target time, so expiry handling should also be protected by Redis TTLs or a reconciliation sweep.

When a reservation expires:

* Reservation status becomes `EXPIRED`
* Inventory is restored back into Redis
* Database state is updated

---

# Overselling Prevention

The system prevents overselling through two core mechanisms.

## 1. Redis Atomic Inventory Operations

Inventory validation and stock deduction happen atomically inside Redis.

### Example Logic

```text
IF available_stock > 0
    decrement stock
    accept reservation
ELSE
    reject reservation
```

This ensures only valid reservations can succeed even under extreme concurrency.

---

## 2. Queue-Based Reservation Processing

Instead of allowing all requests to directly modify inventory simultaneously:

* Requests are queued
* Workers process reservations asynchronously
* Traffic spikes are buffered safely

This significantly reduces race conditions during flash sale events.

---

# Available Stock

```text
Available Stock =
Total Stock
− Confirmed Sales
− Active Reservations
```

This is the business rule used for inventory visibility, but the actual reservation decision should come from a single atomic write path rather than recomputing from loosely synchronized reads across systems.

---

# Example Scenario

## Initial State

```text
Stock = 1
```

## Incoming Requests

```text
500 simultaneous reservation attempts
```

## Expected Result

* `1` successful reservation
* `499` failures

The system is designed so inventory never becomes negative.

---

# Idempotency

Reservation requests should be idempotent.

## Why?

* Queues may retry jobs
* Network failures may duplicate requests
* Workers may restart

Each reservation request should include:

```text
reservation_request_id
```

Duplicate requests with the same identifier should not create multiple reservations.

---

# Redis Responsibilities

Redis acts as:

* Real-time inventory coordinator
* Temporary reservation store
* Atomic inventory validator
* Queue backend for BullMQ

---

# PostgreSQL Responsibilities

PostgreSQL acts as the durable source of truth for:

* Reservations
* Purchases
* Inventory history
* Auditing

---

# BullMQ Usage

BullMQ is used for:

* Reservation processing
* Delayed expiry jobs
* Retry handling
* Background workers
* Traffic buffering

---

# Scalability

The architecture supports horizontal scaling.

## Possible Future Improvements

* Redis Cluster
* Kafka-based event streaming
* Queue partitioning by product ID
* Multiple worker instances
* Rate limiting
* Dead-letter queues
* Distributed tracing
* Monitoring dashboards

---

# Hot Product Strategy

Products experiencing extreme demand may be routed into dedicated queue partitions.

## Benefits

* Isolates high-contention products
* Improves queue fairness
* Reduces bottlenecks

---

# Testing Strategy

## Unit Tests

Validate:

* Reservation lifecycle
* Inventory calculations
* Expiry behavior

---

## Integration Tests

Validate:

* Redis integration
* BullMQ processing
* Database consistency

---

## Concurrency Tests

Simulate:

```text
500 concurrent reservation attempts
```

### Assertions

* No overselling
* Inventory never negative
* Only valid reservations succeed

---

## Failure-Mode Tests

Validate:

* Duplicate request handling with the same `reservation_request_id`
* Expiry lag when delayed jobs run late
* Worker restart recovery after Redis reservation succeeds but PostgreSQL write fails

---

# Design Principles

The system follows:

* SOLID principles
* Clean architecture
* Event-driven architecture
* Domain-oriented design
* Asynchronous processing patterns

---

# SOLID Principles

## Single Responsibility Principle

Each component has one responsibility.

### Examples

* `ReservationService`
* `InventoryService`
* `QueuePublisher`
* `ReservationWorker`
* `ExpiryProcessor`

---

## Open / Closed Principle

Reservation flows can be extended without modifying core business logic.

### Examples

* New reservation policies
* Dynamic expiry durations
* Priority reservation flows

---

## Dependency Inversion Principle

Core business logic depends on abstractions instead of infrastructure implementations.

### Examples

* `InventoryRepository`
* `ReservationRepository`
* `QueueProvider`
* `CacheProvider`

---

# Future Enhancements

Potential production improvements:

* Distributed tracing
* Event sourcing
* CQRS
* Real-time inventory analytics
* Redis Streams
* Kafka integration
* Multi-region deployment

---

# Conclusion

This project demonstrates a scalable, event-driven inventory reservation architecture capable of handling flash-sale traffic while preventing overselling through:

* Redis atomic operations
* Asynchronous queue processing
* Reservation lifecycle management
* Automatic expiration handling
* Scalable worker-based processing

The system prioritizes consistency, scalability, and resiliency under high concurrency conditions, with explicit safeguards for:

* Idempotency
* Delayed-expiry drift
* Worker recovery
