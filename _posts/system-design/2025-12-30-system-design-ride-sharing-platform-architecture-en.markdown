---
layout: post
title: "System Design: A Scalable Architecture for a Modern Ride-Sharing Platform"
date: '2025-12-30 09:00:00 +0700'
permalink: /2025/12/30/system-design-ride-sharing-platform-architecture-en.html
excerpt: >
  Ever wondered how ride-sharing platforms like Uber handle millions of users, match riders with drivers in seconds, and track locations in real-time? In this deep dive, we'll explore a scalable architecture built with microservices, event-driven communication, and cutting-edge technologies like H3 geospatial indexing.
comments: false
---

![Anatomy of a Search Engine](/img/system-design/ride-sharing-platform/ride-sharing-platform.png)

Have you ever opened a ride-sharing app, requested a ride, and watched as the system magically finds a nearby driver, calculates your fare, and shows you their location moving in real-time on your map? It feels seamless, but behind that simple user experience lies one of the most complex distributed systems challenges in modern software engineering.

In this post, we'll break down how to architect a ride-sharing platform that can handle **100+ million daily active users**, match rides in **under a minute**, and process **millions of location updates per second**—all while maintaining low latency and high availability.

Let's dive in!

---

## What We're Building

Before we jump into the architecture, let's define what our platform needs to do. At its core, a ride-sharing platform has two main user types with different needs:

**For Riders:**
- Request rides with pickup and destination locations
- See real-time fare and ETA estimates
- Track their assigned driver's location in real-time
- Complete payment seamlessly

**For Drivers:**
- Receive ride requests and accept/decline them
- Update their availability status
- Update ride status throughout the journey (picked up, in transit, completed)

Simple enough, right? But here's where it gets interesting—we need to do all of this at **massive scale**.

## The Scale Challenge

Let's talk numbers. Our system needs to handle:

- **100+ million daily active users** across the globe
- **100,000+ concurrent ride requests** from a single location during peak events (think concerts, sports games)
- **Millions of location updates per second** from drivers
- **Sub-one-minute ride matching** to keep users happy
- **24/7 availability** with minimal downtime (users will switch to competitors in seconds)

These aren't just nice-to-haves—they're business-critical requirements. A slow or unreliable platform means lost users and revenue.

---

## Core Entities and API Design

Before diving into the architecture, let's define the core entities our system needs:

- **Rider**: User profile, payment methods, ride history
- **Driver**: Personal details, vehicle information (make, model, year), availability status
- **Ride**: Complete trip record linking rider, driver, locations, fare, and state transitions
- **Fare**: Estimated fare and ETA for a ride (can be part of Ride, but we'll keep it separate)
- **Location**: Real-time driver coordinates (lat/long) with timestamps

### API Design and Security

Here are the key endpoints:

**POST /fare** → Returns fare estimate and ETA
- Body: `{ pickupLocation, destination }`
- Creates a Fare entity in the database

**POST /rides** → Initiates ride request
- Body: `{ fareId }` (the fare estimate the rider accepted)
- Creates a Ride with status "requested" and triggers matching

**POST /drivers/location** → Updates driver's real-time location
- Body: `{ lat, long }`
- **Critical**: `driverId` comes from JWT/session, **never** from the request body

**PATCH /rides/:rideId** → Driver accepts/declines ride
- Body: `{ accept/deny }`
- Returns Ride object with pickup/destination coordinates

**Security Best Practices:**

⚠️ **Never trust client data!** Common mistakes:
- ❌ Passing `userId` or `driverId` in request body (easily manipulated)
- ❌ Client-provided timestamps (should be server-generated)
- ❌ Client-provided `fareEstimate` (should be retrieved from database)

✅ **Always**:
- Extract user identity from JWT/session tokens
- Generate timestamps server-side
- Validate and retrieve data from the database, never trust client input

This might seem obvious, but it's a red flag in system design interviews—it shows understanding of security fundamentals.

---

## The Architecture: Microservices and Event-Driven Design

So, how do we build a system that can handle this scale? The answer: **microservices architecture with event-driven communication**.

### Why Not a Monolith?

You might wonder: "Why not just build one big application?" The problem with a monolithic architecture is that everything is tightly coupled. If one part fails, the whole system can go down. Scaling becomes a nightmare—you can't scale just the ride-matching logic independently from payment processing. And good luck trying to deploy updates without taking the entire system offline.

Instead, we'll decompose our system into **independent, specialized microservices** that can be developed, deployed, and scaled autonomously.

### The High-Level Architecture

Here's how our system is organized:

**API Gateway** → The single entry point for all client requests. It handles authentication, rate limiting, and routes traffic to the right services.

**Apache Kafka Event Bus** → The durable, high-throughput messaging backbone that enables asynchronous communication between services. Think of it as the nervous system of our platform.

**Microservices:**
- **Ride Service**: Manages the entire ride lifecycle (creation, state transitions, fare estimation)
- **Location Service**: Handles the firehose of real-time location data from drivers
- **Ride Matching Service**: The brain that finds and assigns the best driver for each ride
- **Pricing Service**: Calculates dynamic fares based on real-time demand (surge pricing)
- **Notification Service**: Sends push notifications and WebSocket updates
- **Payment Service**: Integrates with payment gateways like Stripe

**Data Stores:**
- **PostgreSQL**: For structured, transactional data (users, rides, payments)
- **Redis**: For high-frequency, ephemeral data (driver locations, demand cache)

Here's a visual representation of the complete architecture:

```mermaid
graph TB
    subgraph Clients
        RA[Rider App]
        DA[Driver App]
    end
    
    subgraph Entry Point
        AG[API Gateway<br/>Auth, Rate Limiting, TLS]
        WS[WebSocket Servers]
    end
    
    subgraph Microservices
        RS[Ride Service]
        LS[Location Service]
        RMS[Ride Matching Service]
        PS[Pricing Service]
        NS[Notification Service]
        PYS[Payment Service]
    end
    
    subgraph Event Bus
        K[Apache Kafka<br/>Event Streaming]
    end
    
    subgraph Data Layer
        PG[(PostgreSQL<br/>Transactional Data)]
        RD[(Redis<br/>Cache & Real-time Data)]
    end
    
    subgraph External Services
        GM[Google Maps/Mapbox]
        ST[Stripe]
        APN[APN/FCM]
    end
    
    RA -.WebSocket.-> AG
    DA -.WebSocket.-> AG
    RA -.HTTP.-> AG
    DA -.HTTP.-> AG
    
    AG --> WS
    AG --> RS
    AG --> LS
    
    RS <--> K
    LS <--> K
    RMS <--> K
    PS <--> K
    NS <--> K
    PYS <--> K
    
    RS --> PG
    RS --> RD
    LS --> RD
    RMS --> RD
    PS --> RD
    
    WS --> NS
    NS --> APN
    
    RS --> GM
    PYS --> ST
    
    style K fill:#f9f,stroke:#333,stroke-width:3px
    style AG fill:#bbf,stroke:#333,stroke-width:2px
```

This architecture gives us the flexibility to scale each component independently and handle failures gracefully. If the payment service goes down, ride matching can still work. If one service instance crashes, others pick up the load.

---

## Real-Time Communication: Why WebSockets?

One of the most critical features is real-time driver tracking. When you open the app and see your driver's car moving on the map, that's happening in real-time. How do we achieve this?

### The Communication Protocol Decision

We evaluated several options:

**HTTP Polling** ❌
- Simple but terribly inefficient
- Millions of clients constantly asking "any updates?" creates massive server load
- High latency—updates are delayed by polling intervals

**Server-Sent Events (SSE)** ⚠️
- Better than polling, provides one-way server-to-client streaming
- But we need bidirectional communication (drivers need to send location updates)
- Not suitable for our use case

**WebSockets** ✅
- Persistent, full-duplex (bidirectional) connection
- Server can push data instantly with minimal latency
- Reduces server load compared to polling
- Mature, well-supported technology

**QUIC (HTTP/3)** 🤔
- Modern protocol with lower latency
- Used by Uber in production
- But relatively new, adds implementation complexity

**We chose WebSockets** for the perfect balance of performance, bidirectional communication, and implementation maturity.

### How It Works

Here's the connection flow:

1. Client (rider or driver app) initiates a secure WebSocket (WSS) connection to the API Gateway
2. Gateway routes to a dedicated WebSocket Server
3. Client authenticates using JWT (JSON Web Token)
4. Server validates the token and maps the connection to a user ID
5. Server can now push targeted updates directly to that specific user's device

This enables instant updates: when a driver's location changes, the server immediately pushes it to the rider's app over the persistent WebSocket connection.

---

## Data Storage: The Polyglot Persistence Strategy

Here's a key insight: **one database can't do everything well**. We need different storage systems optimized for different access patterns.

### PostgreSQL: The Source of Truth

PostgreSQL handles our structured, transactional data that requires strong ACID compliance:

- **Users**: Profile data for riders and drivers
- **Drivers**: Vehicle information, status, credentials
- **Ride**: The primary record for each trip (rider, driver, locations, fare)
- **Ride Updates**: An append-only audit log of every state transition (requested → assigned → in_transit → completed)

This is our "source of truth" for financial records and core business entities. PostgreSQL's strong consistency guarantees ensure we never lose a ride record or have payment discrepancies.

### Redis: The Speed Layer

But here's the problem: PostgreSQL would **crash under the load** of millions of location updates per second. That's where Redis comes in.

Redis is our high-performance, in-memory cache for ephemeral, high-frequency data:

- **Real-time driver locations** indexed by H3 cell ID (we'll talk about H3 in a moment)
- **Aggregated demand data** for rapid surge pricing calculations

By storing driver locations in Redis, we achieve **P99 latencies under 10ms** for proximity queries. That's the difference between a snappy user experience and a frustrating wait.

### Handling the Location Update Firehose

Here's a critical challenge: with **10 million drivers** sending location updates every **5 seconds**, we're looking at approximately **2 million writes per second**. Even Redis would struggle with this raw write load if we wrote each update individually.

**Solution: Batch Processing**

Instead of writing each location update immediately, we aggregate updates over a short interval (e.g., 1-2 seconds) and then batch-write them to Redis. This dramatically reduces the number of write operations while maintaining acceptable freshness.

**Trade-off:** There's a small delay (1-2 seconds) between when a driver's location changes and when it's reflected in our database. For ride matching, this is acceptable—a driver moving 50 meters in 2 seconds won't significantly impact match quality, but it reduces our write load by 10-20x.

**Alternative: Adaptive Update Intervals**

We can further optimize by implementing **adaptive location update intervals** on the client side:

- **Stationary or slow-moving**: Update every 10-15 seconds (reduces unnecessary updates)
- **Fast-moving or changing direction**: Update every 2-3 seconds (maintains accuracy)
- **Near pending ride requests**: Update more frequently (improves match quality)
- **Driver status changes**: Immediate update (availability changes are critical)

The driver's app uses on-device sensors and algorithms to determine the optimal update frequency. This client-side intelligence can reduce total location updates by 30-50% while maintaining accuracy where it matters most.

**Why this matters:** Reducing location updates doesn't just save bandwidth—it reduces server CPU, database load, and costs. At scale, these optimizations can save thousands of dollars per day in infrastructure costs.

### Scaling the Data Layer

As we grow, we need to scale horizontally. Here's our strategy:

- **PostgreSQL Sharding**: Partition data across multiple nodes using `ride_id` as the shard key
- **Global Index**: A separate sharded table that maps secondary keys (like `driver_id`) to the primary shard key, enabling efficient queries like "find all trips for driver X"

This allows us to distribute write and read loads across an entire database cluster.

**Geographic Sharding for Latency**

Beyond sharding by `ride_id`, we can also shard **geographically** to reduce latency:

- **Regional Shards**: Partition data by geographic regions (e.g., North America, Europe, Asia)
- **Proximity Benefits**: Users query their local shard, reducing network latency
- **Scatter-Gather for Boundaries**: When a ride request is near a shard boundary, we query multiple shards and merge results

Geographic sharding applies to everything: services, Kafka topics, and databases. The only time we need to query multiple shards is during proximity searches near boundaries—which is rare. This approach not only improves scalability but also reduces latency by keeping data closer to users.

**Consistent Hashing**: We use consistent hashing to distribute data across shards evenly. This ensures that when we add or remove shards, only a minimal amount of data needs to be rebalanced.

---

## The Magic: Ride Matching with H3 Geospatial Indexing

This is where things get really interesting. The core challenge: **how do you find the nearest available driver from millions of constantly updating locations?**

The answer: **geospatial indexing with H3**.

### Why H3?

H3 is a hexagonal geospatial indexing system developed by Uber. Why hexagons? Compared to alternatives like geohashing (which uses rectangles), hexagons provide superior spatial uniformity. They minimize distance distortion at cell edges, which is critical for finding the nearest neighbors accurately.

Think of H3 as dividing the world into a grid of hexagonal cells. Each cell has a unique ID, and we can quickly find all drivers within a cell and its neighbors.

**Alternative Approaches:**

- **Geohashing**: Uses rectangular cells, which can cause distance distortion at cell boundaries. Simpler but less accurate for proximity searches.
- **PostGIS (PostgreSQL extension)**: Provides geospatial data types and functions. Great for complex queries but not optimized for the high-frequency write load of location updates.
- **Quad-trees**: Recursively partitions space into quadrants. Excellent for 2D spatial data but requires more complex query logic.

H3 strikes the perfect balance: hexagonal cells provide uniform distance properties, the indexing is simple to query (just get the cell and its neighbors), and it integrates seamlessly with Redis for high-performance lookups.

### The Matching Flow

Here's the step-by-step process when a rider requests a ride:

1. **Ride Service** publishes a `ride_requested` event to Kafka
2. **Ride Matching Service** consumes the event and converts the pickup location to an H3 cell ID
3. Query Redis for all available drivers in that H3 cell **and its adjacent neighbors**
4. Score and rank drivers based on proximity and other factors
5. Acquire a **Redis distributed lock** on the top-ranked driver (ensures strong consistency—no double-booking!)
6. Publish `driver_assigned` event → **Notification Service** sends the offer to that driver
7. Driver has **10-15 seconds** to respond
8. If declined or timeout: release lock, repeat with next driver
9. If accepted: lock remains, ride is confirmed

This entire process completes in **under one minute**, meeting our non-functional requirement.

### Distributed Locking: Preventing Double-Booking

The distributed lock in step 5 is **absolutely critical**. Here's why:

Imagine what happens without it: Two ride requests come in simultaneously for the same area. Both matching services query Redis, find the same "best" driver, and both try to assign rides to that driver. Without a lock, that driver could receive two ride requests at once—a race condition that breaks our consistency requirement.

**How the lock works:**
- When we identify the top driver, we immediately acquire a Redis distributed lock with a unique key (e.g., `driver:{driverId}:lock`)
- The lock has a TTL (time-to-live) of 15-20 seconds, matching our driver response window
- Only **one** matching service instance can hold this lock at a time
- If another instance tries to lock the same driver, it fails and moves to the next driver in the ranked list
- When the driver accepts, the lock is extended for the ride duration
- If the driver declines or times out, the lock is released, allowing the next driver to be tried

This is similar to the problem Ticketmaster solves when ensuring a ticket is only sold once—we need to reserve the driver for a specific time window while preventing concurrent assignments.

**Why Redis for locking?**
Redis provides atomic operations (`SETNX` with expiration) that make distributed locking straightforward. Alternatives like database row locks would add significant latency and contention. Redis's in-memory nature gives us sub-millisecond lock acquisition, which is essential for our sub-one-minute matching SLA.

### The Complete Ride Lifecycle

While the matching process is critical, it's just one part of the journey. Here's the complete state machine that shows how a ride progresses from initial request to final completion:

```mermaid
stateDiagram-v2
    [*] --> RideRequested: Rider inputs pickup & destination
    
    RideRequested --> FareEstimation: Calculate fare & ETA
    FareEstimation --> RideRequested: Show estimate to rider
    RideRequested --> Matching: Rider confirms request
    
    Matching --> DriverAssigned: Driver found & notified
    DriverAssigned --> Matching: Driver declines/timeout
    DriverAssigned --> RideAccepted: Driver accepts
    
    RideAccepted --> EnRouteToPickup: Driver navigates to rider
    note right of EnRouteToPickup
        Real-time tracking active
        Location updates via WebSocket
    end note
    
    EnRouteToPickup --> ArrivedAtPickup: Driver reaches pickup
    ArrivedAtPickup --> InTransit: Rider boards, trip starts
    
    InTransit --> ArrivedAtDestination: Driver reaches destination
    note right of InTransit
        Live tracking continues
        Route updates in real-time
    end note
    
    ArrivedAtDestination --> PaymentProcessing: Trip completed
    PaymentProcessing --> RideCompleted: Payment successful
    PaymentProcessing --> PaymentFailed: Payment error
    PaymentFailed --> PaymentProcessing: Retry payment
    
    RideCompleted --> [*]: Trip finalized
    
    note left of Matching
        Ride Matching Service
        H3 geospatial lookup
        Driver scoring algorithm
        Distributed locking
    end note
    
    note right of PaymentProcessing
        Stripe integration
        Webhook events
        Async reconciliation
    end note
```

This state diagram illustrates the complete journey of a ride from start to finish. Key highlights:

- **Fare Estimation**: Before confirming, riders see real-time fare and ETA estimates calculated using current demand data
- **Matching Loop**: If a driver declines or times out, the system automatically tries the next best driver—this loop continues until a match is found
- **Real-Time Tracking**: Once a driver is assigned, WebSocket connections enable live location updates throughout the journey
- **State Transitions**: Each state change (like "arrived at pickup" or "in transit") is tracked and stored in our `Ride Updates` audit log
- **Payment Handling**: The system gracefully handles payment failures with retry logic, ensuring riders aren't stuck if a payment temporarily fails

Notice how the matching process (shown in the left note) uses H3 geospatial indexing and distributed locking—the same techniques we discussed earlier. The payment processing (right note) leverages Stripe's webhook system for asynchronous reconciliation, keeping our system responsive even during payment processing.

This end-to-end flow demonstrates how all our architectural components work together: microservices communicate via Kafka events, real-time updates flow through WebSockets, and state changes are persisted in PostgreSQL while location data lives in Redis for fast access.

---

## Event-Driven Architecture with Kafka

Apache Kafka is the **event-driven backbone** of our entire system. It's a durable, high-throughput message broker that decouples our microservices.

### Why Events?

Instead of services directly calling each other (which creates tight coupling), services publish events to Kafka topics. Other services consume these events asynchronously. This means:

- Services can scale independently
- If one service is slow, others aren't blocked
- Events are durably stored—if a service crashes, it can resume processing from where it left off
- Zero data loss for critical events

### Key Kafka Topics

- **`ride_requests`**: Published when a user requests a ride (triggers matching workflow)
- **`driver_updates`**: High-frequency stream of driver status changes (location, availability)
- **`ride_status_changes`**: Lifecycle events (`driver_assigned`, `ride_accepted`, `in_transit`, `completed`)
- **`payment_events`**: Events from payment provider webhooks (`payment_processed`, `payment_failed`)

Each service publishes to topics and consumes from topics, creating a loosely coupled, resilient system.

---

## Third-Party Integrations: Focus on What Matters

A key strategic decision: **don't rebuild what others do better**. We integrate with specialized third-party services for non-differentiating functionality:

| Service | Provider | Why |
|---------|----------|-----|
| **Mapping & Routing** | Google Maps / Mapbox | Robust solutions for maps, geocoding, directions, ETA. Building this in-house would be a massive undertaking. |
| **Payments** | Stripe | Handles payment processing, security, PCI compliance. Their webhook system notifies us of payment status changes. |

This allows our engineering team to focus on our core differentiators: ride matching, pricing algorithms, and real-time logistics.

---

## Meeting Non-Functional Requirements

Let's see how our architecture addresses the critical non-functional requirements:

### Scalability ✅

- **Horizontal Scaling**: All microservices are stateless—just add more instances behind a load balancer
- **Database Sharding**: Partition data across multiple nodes to distribute load
- **Asynchronous Decoupling**: Kafka allows services to scale independently. During demand spikes, Kafka buffers requests, preventing downstream services from being overwhelmed

### High Availability ✅

- **Microservice Redundancy**: Multiple instances across different availability zones. If one fails, traffic automatically routes to healthy instances
- **Data Replication**: PostgreSQL read replicas for automatic failover. Redis cluster for redundancy
- **Fault Tolerance**: Events are durably stored in Kafka. If a service crashes, it resumes from the last committed offset—**zero data loss**

Here's how scalability and high availability work together in practice:

```mermaid
graph TB
    subgraph Load Balancing
        LB[Load Balancer]
    end
    
    subgraph Availability Zone 1
        MS1A[Microservice<br/>Instance 1]
        MS2A[Microservice<br/>Instance 2]
        MS3A[Microservice<br/>Instance 3]
    end
    
    subgraph Availability Zone 2
        MS1B[Microservice<br/>Instance 4]
        MS2B[Microservice<br/>Instance 5]
        MS3B[Microservice<br/>Instance 6]
    end
    
    subgraph Kafka Buffering
        K[Kafka<br/>Durable Event Log<br/>Acts as Buffer]
    end
    
    subgraph Auto-Scaling
        AS[Auto-Scaler<br/>Monitors Load<br/>Adds/Removes Instances]
    end
    
    subgraph Data Redundancy
        PGP[(PostgreSQL<br/>Primary)]
        PGR1[(Read Replica 1)]
        PGR2[(Read Replica 2)]
        RC[(Redis Cluster<br/>Multi-node<br/>Replication)]
    end
    
    LB --> MS1A
    LB --> MS2A
    LB --> MS3A
    LB --> MS1B
    LB --> MS2B
    LB --> MS3B
    
    MS1A --> K
    MS2A --> K
    MS3A --> K
    MS1B --> K
    MS2B --> K
    MS3B --> K
    
    AS -.monitors.-> LB
    AS -.scales.-> MS1A
    AS -.scales.-> MS1B
    
    MS1A --> PGP
    MS2A --> PGR1
    MS3A --> PGR2
    MS1B --> RC
    
    PGP -.replicates.-> PGR1
    PGP -.replicates.-> PGR2
    
    style K fill:#FFD700,stroke:#333,stroke-width:3px
    style LB fill:#87CEEB,stroke:#333,stroke-width:2px
    style AS fill:#90EE90,stroke:#333,stroke-width:2px
```

### Low Latency ✅

- **WebSockets**: Persistent connections eliminate polling latency
- **Redis Caching**: In-memory storage enables P99 latencies under 10ms
- **H3 Indexing**: Efficient geospatial queries avoid slow full-database scans

### Resilience ✅

- **Durable Event Processing**: Ride requests are persisted in Kafka immediately. Even if the matching service fails, the request isn't lost
- **Managed Timeouts**: 10-15 second driver response window prevents indefinite blocking

### Preventing Dropped Requests During Peak Demand

During peak events (concerts, sports games), we might receive **100,000+ concurrent requests** from a single location. How do we ensure no requests are dropped?

**Kafka as a Durable Buffer:**

- Ride requests are **immediately persisted** to Kafka upon receipt
- Kafka's durable log ensures zero data loss—even if all matching service instances crash
- During demand spikes, Kafka acts as a buffer, absorbing bursts that would overwhelm downstream services
- Services consume events at their own pace, preventing cascading failures

**Service Recovery:**

If the Ride Matching Service crashes or is restarted:
- It resumes consumption from its last committed Kafka offset
- All events since the last commit are reprocessed
- No ride requests are lost—they're just processed slightly later

**Multi-Step Process Pattern:**

The ride matching flow is a **human-in-the-loop** process: we need to wait for driver responses. This is a perfect use case for durable execution frameworks like **Temporal** (originally Cadence, created by Uber for exactly this problem).

These frameworks handle:
- **State management**: Tracking which driver we're waiting on
- **Timeouts**: Automatically moving to the next driver after 10-15 seconds
- **Retries**: Handling transient failures gracefully
- **Durability**: Surviving service restarts without losing progress

While we can implement this with Kafka and Redis locks, frameworks like Temporal provide battle-tested solutions for these complex, multi-step workflows.

---

## Wrapping Up

Building a ride-sharing platform at scale is a fascinating challenge that requires careful architectural decisions. By leveraging:

- **Microservices** for independent scaling and deployment
- **Event-driven communication** with Kafka for decoupling and fault tolerance
- **WebSockets** for real-time bidirectional communication
- **Polyglot persistence** (PostgreSQL + Redis) optimized for different access patterns
- **H3 geospatial indexing** for efficient driver discovery
- **Strategic third-party integrations** to focus on core differentiators

We can build a system that handles millions of users, processes millions of location updates per second, and matches rides in under a minute—all while maintaining low latency and high availability.

The architecture we've outlined provides a robust foundation not just for the immediate requirements, but also for future feature expansion and long-term business growth.

If you're preparing for system design interviews or working on building scalable systems, I hope this deep dive has been helpful. The principles here—microservices, event-driven architecture, polyglot persistence, and strategic technology choices—apply to many large-scale distributed systems beyond just ride-sharing.

Feel free to share your thoughts or questions in the comments!
