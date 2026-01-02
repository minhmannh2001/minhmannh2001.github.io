---
layout: post
title: "System Design: A Scalable Architecture for a Music Streaming Service (Spotify-like)"
date: '2026-01-02 09:00:00 +0700'
permalink: /2026/01/02/system-design-music-streaming-service-architecture-en.html
excerpt: >
  How do music streaming services like Spotify handle millions of users streaming billions of songs? In this comprehensive system design deep dive, we'll explore scalable architecture, capacity planning, data storage strategies, and the technologies that power modern music platforms.
comments: false
---

![Designing Spotify: A System Design Blueprint](/img/system-design/music-streaming-architecture/music-streaming-architecture.png)

Have you ever wondered how Spotify delivers millions of songs to hundreds of millions of users worldwide with near-instant playback? Behind that simple "press play" experience lies a complex distributed system that must handle massive scale, low latency, and high availability.

In this post, we'll break down how to architect a music streaming service that can handle **100+ million users**, serve a **30+ million song catalog**, and deliver **low-latency playback globally**—all while maintaining cost efficiency and scalability.

Let's dive in!

---

## What We're Building

Before we jump into the architecture, let's define what our music streaming platform needs to do:

**For Users:**
- Stream music with low latency
- Search and discover songs, artists, and playlists
- Create and manage personal playlists
- Like songs and follow artists
- View trending content

**For Artists:**
- Upload audio files and metadata
- Manage their catalog and profile

**For the System:**
- Handle millions of concurrent streams
- Serve content globally with low latency
- Scale horizontally as user base grows
- Maintain high availability (99.9%+ uptime)

Simple enough, right? But here's where it gets interesting—we need to do all of this at **massive scale**.

---

## System Requirements

A clear definition of requirements is the foundation upon which the entire system is designed. These requirements dictate architectural choices, technology selection, and scalability strategies.

### Functional Requirements

- **Artist Content Upload**: Mechanism for artists to upload audio files and associated metadata
- **User Music Playback**: Allow authenticated users to stream songs with low latency
- **Search and Discovery**: Users can search for music by title, artist, genre, etc.
- **Playlist Management**: Create and manage personal playlists (add, remove, reorder songs)
- **User Profiles**: Manage playlists, liked songs, followed artists, and preferences
- **Trending Content**: Feature trending songs, optionally filtered by region or genre

### Non-Functional Requirements

- **High Availability**: System must be resilient to failures with minimal downtime
- **Scalability**: Architecture must scale horizontally from 50 million to 1+ billion users
- **Low Latency**: Music playback and search must be highly responsive
- **Eventual Consistency**: Acceptable for non-critical operations (e.g., newly uploaded songs appearing in search)
- **Monitoring & Observability**: Basic monitoring including server health, error tracking, and performance metrics

---

## Capacity Planning and Estimation

Strategic capacity planning is critical for architecting a system that can handle the projected load while remaining cost-effective. The following estimations are based on a target scale of **100 million users** and a **30 million song catalog**.

| Metric | Estimation | Rationale / Calculation |
|--------|------------|------------------------|
| **User Base** | 100 Million Users | Baseline assumption for a large-scale service |
| **Song Catalog** | 30 Million Songs | Initial catalog size assumption |
| **Raw Audio Storage** | ~90 TB | Based on 30M songs × ~3MB/song average |
| **Replicated Audio Storage** | ~270 TB | Assuming 3× replication for durability |
| **Song Metadata Storage** | ~3 GB | Based on 30M songs × ~100 bytes/song |
| **User Metadata Storage** | ~100 GB | Based on 100M users × ~1 KB/user |

**Key Insight**: Raw audio files dominate both storage and bandwidth costs. User and song metadata represent a comparatively small fraction of the total data footprint. This justifies a **decoupled storage architecture** that uses separate, specialized solutions for each data type.

---

## High-Level System Architecture

The proposed architecture is a decoupled, service-oriented design built for scalability, maintainability, and fault tolerance. Each component performs a specific function and can be scaled independently.

```mermaid
graph TB
    subgraph Clients
        WA[Web App]
        MA[Mobile App]
    end
    
    subgraph Entry Point
        LB[Load Balancer<br/>Health Checks, SSL]
    end
    
    subgraph Application Layer
        API1[API Server 1<br/>Stateless]
        API2[API Server 2<br/>Stateless]
        API3[API Server N<br/>Stateless]
    end
    
    subgraph Data Layer
        DB[(PostgreSQL<br/>Metadata Database)]
        S3[(S3 Bucket<br/>Audio Files)]
        CACHE[(Redis<br/>Cache Layer)]
    end
    
    subgraph CDN Layer
        CDN[CloudFront CDN<br/>Global Edge Network]
    end
    
    WA --> LB
    MA --> LB
    LB --> API1
    LB --> API2
    LB --> API3
    
    API1 --> DB
    API2 --> DB
    API3 --> DB
    
    API1 --> CACHE
    API2 --> CACHE
    API3 --> CACHE
    
    WA --> CDN
    MA --> CDN
    CDN --> S3
    
    style CDN fill:#FFD700,stroke:#333,stroke-width:3px
    style S3 fill:#87CEEB,stroke:#333,stroke-width:2px
    style DB fill:#90EE90,stroke:#333,stroke-width:2px
```

### Component Breakdown

1. **Client Applications (Web/Mobile)**: User-facing interface for UI, playback controls, search, and playlist management. Communicates via HTTP REST APIs.

2. **Load Balancer**: Entry point that distributes API requests across application servers using algorithms like Round Robin or Least Connections. Performs health checks to route traffic only to healthy instances.

3. **Stateless API Servers**: Horizontally scalable layer containing core business logic. Processes user requests, validates authentication tokens (JWT), and interacts with data stores. Stateless nature means any server can handle any request.

4. **Metadata Database (Relational)**: SQL database (PostgreSQL, MySQL, or AWS RDS) for structured data including user profiles, song metadata (title, artist, duration), and playlist information. Chosen for relational nature of data, complex queries, joins, and transactional integrity.

5. **Object Storage (Blob Store)**: Highly scalable and durable object storage (AWS S3) for large, immutable audio files. Cost-effective for petabyte-scale data with virtually unlimited scalability and high durability.

6. **Content Delivery Network (CDN)**: Global network of edge servers (AWS CloudFront) that cache copies of popular songs geographically closer to users. Reduces playback latency, improves user experience, and significantly offloads traffic from origin storage.

---

## Audio Streaming: HLS and CDN Overview

Before diving into detailed workflows, let's briefly understand how audio streaming works in our architecture.

### HLS (HTTP Live Streaming)

**HLS** is a streaming protocol that breaks large audio files into small segments (typically 2-6 seconds each). Instead of downloading an entire 3-5 MB file, the client downloads small chunks sequentially.

**Pre-processing workflow:**
1. Original audio file (e.g., `song.mp3`) is uploaded to S3
2. File is segmented into small chunks (`.ts` or `.aac` files)
3. Playlist file (`.m3u8`) is generated with references to all segments
4. All files stored in S3, with CDN in front for global delivery

### CDN Caching Strategy

| File Type | Cache TTL | Reason |
|-----------|-----------|--------|
| `.m3u8` playlists | 10-30 seconds | Playlists may change (adaptive bitrate) |
| `.ts` segments | 24 hours | Segments are immutable once created |

**Key insight**: CDN is **pull-based**. You only upload to S3; CDN automatically fetches and caches content on cache misses. Popular songs get cached at edge locations globally, reducing latency and origin load.

### Secure Streaming with Signed Cookies

For authenticated users, we use **CloudFront signed cookies** instead of signing every segment URL:

1. User logs in and backend validates subscription
2. Backend sets CloudFront signed cookies (grants access to path prefix like `/hls/song123/*`)
3. User can now fetch playlists and segments freely
4. CDN validates cookies and serves content

**Why this approach?**
- ✅ One-time authentication (set cookies once, stream freely)
- ✅ CDN caching works perfectly (segments aren't signed, so they cache normally)
- ✅ No URL regeneration needed
- ✅ Smooth playback without interruptions

This is much more efficient than generating signed URLs for hundreds of segments per song!

---

## Detailed System Workflows

This section details the step-by-step processes for the system's primary functions: uploading new music and playing existing tracks.

### Write Path: Artist Song Upload

```mermaid
sequenceDiagram
    participant Artist
    participant Client
    participant API
    participant S3
    participant DB
    participant Queue as Message Queue
    participant Worker as Worker Service
    
    Artist->>Client: Upload song + metadata
    Client->>API: POST /songs (with auth token)
    API->>API: Validate artist authentication
    API->>API: Validate file format & size
    
    alt Direct Upload
        Client->>S3: Upload audio file directly
        S3-->>Client: Upload complete
    else Server Upload
        Client->>API: Upload file to API
        API->>S3: Store audio file
    end
    
    API->>DB: Insert song metadata record
    API->>Queue: Publish transcoding job (optional)
    
    Note over Queue,Worker: Asynchronous Processing
    Queue->>Worker: Consume transcoding job
    Worker->>S3: Fetch original file
    Worker->>Worker: Transcode to multiple bitrates<br/>(64kbps, 128kbps, 320kbps)
    Worker->>Worker: Generate HLS segments
    Worker->>S3: Store segments & playlists
    
    API-->>Client: Success response
    Note over Client: Song available for streaming
```

**Steps:**
1. Artist initiates upload via client, sending POST request with audio file and metadata
2. API server validates request (file format, size limits, authentication)
3. Raw audio file uploaded to S3 (directly from client or via server)
4. API server extracts metadata (duration, bitrate) and inserts record into SQL database
5. **(Optional)** Upload triggers message in queue (RabbitMQ, SQS) for asynchronous transcoding
6. Worker services consume messages to perform offline tasks:
   - Transcode audio into multiple bitrates (64kbps, 128kbps, 320kbps) for adaptive streaming
   - Chunk files into HLS segments
   - Generate playlist files (`.m3u8`)
7. Success response returned to artist

### Read Path: User Song Playback

```mermaid
sequenceDiagram
    participant User
    participant Client
    participant API
    participant CDN
    participant S3
    participant DB
    
    User->>Client: Press Play
    Client->>API: GET /songs/{id} (with JWT)
    API->>API: Validate JWT token
    API->>API: Check subscription level
    API->>DB: Query song metadata
    DB-->>API: Return song info
    API->>API: Set CloudFront signed cookies
    API-->>Client: Return metadata + cookies
    
    Client->>CDN: Request master.m3u8 (with cookies)
    CDN->>CDN: Validate cookies
    alt Cache Hit
        CDN-->>Client: Return cached playlist
    else Cache Miss
        CDN->>S3: Fetch playlist
        S3-->>CDN: Return playlist
        CDN->>CDN: Cache playlist
        CDN-->>Client: Return playlist
    end
    
    Client->>CDN: Request variant playlist (e.g., audio_128k.m3u8)
    CDN-->>Client: Return variant playlist
    
    loop Streaming Segments
        Client->>CDN: Request segment_001.ts
        alt Cache Hit
            CDN-->>Client: Return cached segment
        else Cache Miss
            CDN->>S3: Fetch segment
            S3-->>CDN: Return segment
            CDN->>CDN: Cache segment (24h TTL)
            CDN-->>Client: Return segment
        end
        Note over Client: Player buffers and plays
    end
```

**Steps:**
1. User presses play button in client application
2. Client sends GET request for song metadata (`/songs/{id}`) to API server via load balancer
3. API server validates JWT token to verify identity and subscription level (free vs. premium)
4. Server queries SQL database for song metadata (title, artist, duration, file path)
5. Server sets CloudFront signed cookies (grants access to song's HLS path)
6. Server returns song metadata and cookie information to client
7. Client's media player requests HLS playlist from CDN (with cookies)
8. CDN validates cookies and serves playlist (from cache or fetches from S3)
9. Client requests segments sequentially as needed
10. CDN serves segments (cached or fetches from S3, then caches for future requests)

---

## Data Storage Architecture

This proposal advocates for a **dual-database strategy**, a critical design decision that optimizes performance, cost, and scalability. By separating transactional metadata from large, immutable media files, we use the best storage technology for each data type.

### Metadata Storage: Relational Database (SQL)

A relational database is ideal for managing metadata due to strong support for transactional integrity (ACID properties), complex queries, and native ability to handle joins between entities.

#### Core Schema

**users table**

| Column | Type | Description |
|--------|------|-------------|
| `user_id` | PK | Unique user identifier |
| `email` | VARCHAR | User's email address |
| `password_hash` | VARCHAR | Hashed user password |
| `subscription_type` | ENUM | e.g., 'free', 'premium' |
| `created_at` | TIMESTAMP | Account creation timestamp |

**artists table**

| Column | Type | Description |
|--------|------|-------------|
| `artist_id` | PK | Unique artist identifier |
| `name` | VARCHAR | Artist's name |
| `country` | VARCHAR | Artist's country of origin |

**songs table**

| Column | Type | Description |
|--------|------|-------------|
| `song_id` | PK | Unique song identifier |
| `title` | VARCHAR | Song title |
| `duration` | INT | Duration in seconds |
| `file_url` | VARCHAR | Path to HLS playlist in object storage |
| `genre` | VARCHAR | Song genre |

**artist_songs (Join Table)**

| Column | Type | Description |
|--------|------|-------------|
| `artist_id` | FK (artists) | Composite primary key |
| `song_id` | FK (songs) | Composite primary key |

**playlists table**

| Column | Type | Description |
|--------|------|-------------|
| `playlist_id` | PK | Unique playlist identifier |
| `owner_id` | FK (users) | Foreign key to playlist owner |
| `name` | VARCHAR | Playlist name |
| `created_at` | TIMESTAMP | Creation timestamp |

**playlist_items (Join Table)**

| Column | Type | Description |
|--------|------|-------------|
| `playlist_id` | FK (playlists) | Composite primary key |
| `song_id` | FK (songs) | Composite primary key |
| `position` | INT | Order of song in playlist |

**user_likes table**

| Column | Type | Description |
|--------|------|-------------|
| `user_id` | FK (users) | Composite primary key |
| `song_id` | FK (songs) | Composite primary key |
| `liked_at` | TIMESTAMP | When song was liked |

### Audio File Storage: Object Storage

An object storage solution like **AWS S3** is recommended for audio files. Its suitability stems from:
- Virtually unlimited scalability
- High durability (99.999999999% durability by design)
- Cost-effectiveness for storing large, immutable files

**File organization structure:**
```
s3://music-streaming-bucket/
  artists/
    {artist_id}/
      albums/
        {album_id}/
          {song_id}/
            master.m3u8
            audio_64k.m3u8
            audio_128k.m3u8
            audio_320k.m3u8
            segments/
              segment_001.ts
              segment_002.ts
              ...
```

This hierarchical structure provides clarity and easy management while keeping related files together.

---

## API Endpoint Design

The RESTful API serves as the formal contract between client applications and backend services. The following endpoints are designed to be intuitive, resource-oriented, and follow standard web conventions.

### Search and Discovery

**GET /search?q={query}&type={song\|artist}&limit={20}&offset={0}**
- Searches for content across different types with pagination support

**GET /songs/trending?genre={genre}**
- Retrieves a list of trending songs, with optional genre filter

**GET /artists/{id}/songs**
- Fetches a paginated list of all songs by a specific artist

### Content Access & Playback

**GET /songs/{id}**
- Retrieves specific song's metadata
- Returns CloudFront signed cookies for secure streaming
- Response includes: title, artist, duration, album art, streaming URL

### Playlist Management

**POST /playlists**
- Creates a new playlist for the authenticated user
- Body: `{ name: "My Playlist" }`

**PUT /playlists/{id}/songs**
- Adds one or more songs to a specified playlist
- Body: `{ song_ids: [1, 2, 3] }`

**DELETE /playlists/{id}/songs/{song_id}**
- Removes a specific song from a user's playlist

**GET /playlists/{id}**
- Retrieves playlist details and all songs in the playlist

### User Management

**GET /users/me/playlists**
- Fetches all playlists created by the currently authenticated user

**POST /songs/{id}/like**
- Adds a song to the current user's list of liked songs

**DELETE /songs/{id}/like**
- Removes a song from the user's liked songs

**POST /artists/{id}/follow**
- Allows the current user to follow an artist

**DELETE /artists/{id}/follow**
- Unfollows an artist

### Artist Endpoints

**POST /songs**
- Uploads a new song (artist only)
- Body: multipart form data with audio file and metadata

**GET /artists/me/songs**
- Retrieves all songs uploaded by the authenticated artist

---

## Scalability and Availability Strategy

To meet critical non-functional requirements of scalability and high availability, the architecture incorporates several strategies designed to ensure reliable performance as the user base grows.

### Stateless API Servers

API servers do not store any user session state locally. This fundamental design choice allows for seamless horizontal scaling. New server instances can be added behind the load balancer during traffic spikes and removed during quiet periods, with no impact on users.

### Intelligent Load Balancing

While simple Round Robin load balancing is a valid start, a production-grade streaming service requires a more sophisticated approach. The load balancer should monitor:
- CPU utilization
- Network bandwidth
- Number of active streams per API server

This prevents routing new stream requests to a server that has available CPU but has saturated its network interface—a common bottleneck in media-heavy applications.

### Database Read Replicas

The architecture employs a **leader-follower (master-slave)** database configuration:

```mermaid
graph TB
    subgraph Write Operations
        API1[API Server] --> PRIMARY[(PostgreSQL<br/>Primary/Leader)]
    end
    
    subgraph Read Operations
        API2[API Server] --> REPLICA1[(Read Replica 1)]
        API3[API Server] --> REPLICA2[(Read Replica 2)]
        API4[API Server] --> REPLICA3[(Read Replica 3)]
    end
    
    PRIMARY -.replication.-> REPLICA1
    PRIMARY -.replication.-> REPLICA2
    PRIMARY -.replication.-> REPLICA3
    
    style PRIMARY fill:#FF6B6B
    style REPLICA1 fill:#90EE90
    style REPLICA2 fill:#90EE90
    style REPLICA3 fill:#90EE90
```

- **Write operations** (creating playlists, uploading songs) → directed to leader
- **Read operations** (fetching song metadata, user profiles) → distributed across read-only follower replicas

This pattern dramatically increases the system's overall read capacity since reads are far more frequent than writes.

### Database Sharding

To achieve near-limitless write scalability for a massive global user base, the metadata database can be **sharded**. This involves partitioning data horizontally across multiple independent database instances.

**Sharding strategies:**
- **By user geography**: North American users → Shard 1, European users → Shard 2, etc.
- **By user_id hash**: Consistent hashing distributes users evenly across shards
- **By artist_id ranges**: For artist-related queries

**Global Index**: A separate sharded table maps secondary keys (like `user_id`) to the primary shard key, enabling efficient queries like "find all playlists for user X" across shards.

### Multi-Layer Caching

An aggressive, multi-tiered caching strategy is essential for both performance and cost-efficiency:

```mermaid
graph TB
    A[User Request] --> B{Client Cache?}
    B -->|Hit| C[Return from Device]
    B -->|Miss| D{CDN Cache?}
    D -->|Hit| E[Return from Edge]
    D -->|Miss| F{Redis Cache?}
    F -->|Hit| G[Return from Redis]
    F -->|Miss| H[Query Database]
    H --> I[Cache in Redis]
    I --> J[Return to User]
    
    style C fill:#FFD700
    style E fill:#87CEEB
    style G fill:#90EE90
```

1. **Client-Side Cache**: Mobile and web applications cache recently and frequently played songs locally on the user's device. Provides instantaneous playback for repeat plays and works offline.

2. **Content Delivery Network (CDN)**: Global CDN (AWS CloudFront) serves as the primary edge cache. Stores copies of popular songs in locations geographically close to users. Uses LRU (Least Recently Used) eviction policy to keep cache relevant.

3. **Service-Level Cache**: In-memory cache (Redis, Memcached) at the service layer stores "hot" data:
   - Frequently accessed song metadata
   - User session data
   - Trending song lists
   - Search query results

This reduces redundant database queries and protects the backend from overload.

### Geo-Replicated Object Storage

For a global service, object storage buckets containing audio files are replicated across different geographic regions. This allows:
- Users to upload to and stream from a data center physically closer to them
- Reduced latency
- Improved data durability and availability in the event of regional outages

---

## Meeting Non-Functional Requirements

Let's see how our architecture addresses the critical non-functional requirements:

### Scalability ✅

- **Horizontal Scaling**: All microservices are stateless—just add more instances behind a load balancer
- **Database Sharding**: Partition data across multiple nodes to distribute load
- **CDN Edge Caching**: Absorbs massive traffic at edge locations globally
- **Asynchronous Processing**: Transcoding and heavy processing happen offline via worker queues

### High Availability ✅

- **Service Redundancy**: Multiple API server instances across different availability zones
- **Data Replication**: PostgreSQL read replicas for automatic failover, S3 with 3× replication
- **CDN Redundancy**: Multiple edge locations ensure content is always available
- **Health Checks**: Load balancer routes traffic only to healthy instances

### Low Latency ✅

- **CDN Edge Delivery**: Content served from locations close to users (typically <50ms)
- **Client-Side Caching**: Instant playback for cached songs
- **Database Read Replicas**: Distribute read load for faster query response
- **Redis Caching**: Sub-millisecond access to hot data

### Eventual Consistency ✅

- **Search Index Updates**: Newly uploaded songs appear in search results within minutes (acceptable trade-off)
- **Trending Lists**: Updated periodically (e.g., every hour) rather than real-time
- **Playlist Updates**: Immediate consistency for user's own playlists, eventual for shared playlists

---

## Complete System Architecture Diagram

Here's the complete end-to-end architecture showing all components working together:

```mermaid
graph TB
    subgraph Clients
        WA[Web App]
        MA[Mobile App]
    end
    
    subgraph Entry Point
        LB[Load Balancer<br/>Health Checks, SSL Termination]
    end
    
    subgraph Application Layer
        API1[API Server 1]
        API2[API Server 2]
        API3[API Server N]
    end
    
    subgraph Caching Layer
        REDIS[(Redis<br/>Hot Data Cache)]
    end
    
    subgraph Data Layer
        PG_PRIMARY[(PostgreSQL<br/>Primary)]
        PG_REPLICA1[(Read Replica 1)]
        PG_REPLICA2[(Read Replica 2)]
        S3[(S3 Bucket<br/>Audio Files & HLS)]
    end
    
    subgraph CDN Layer
        CDN[CloudFront CDN<br/>Global Edge Network]
    end
    
    subgraph Processing
        QUEUE[Message Queue<br/>SQS/RabbitMQ]
        WORKER[Worker Services<br/>Transcoding, HLS Generation]
    end
    
    WA --> LB
    MA --> LB
    LB --> API1
    LB --> API2
    LB --> API3
    
    API1 --> PG_PRIMARY
    API2 --> PG_REPLICA1
    API3 --> PG_REPLICA2
    
    API1 --> REDIS
    API2 --> REDIS
    API3 --> REDIS
    
    PG_PRIMARY -.replication.-> PG_REPLICA1
    PG_PRIMARY -.replication.-> PG_REPLICA2
    
    WA --> CDN
    MA --> CDN
    CDN --> S3
    
    API1 --> QUEUE
    QUEUE --> WORKER
    WORKER --> S3
    
    style CDN fill:#FFD700,stroke:#333,stroke-width:3px
    style S3 fill:#87CEEB,stroke:#333,stroke-width:2px
    style PG_PRIMARY fill:#FF6B6B,stroke:#333,stroke-width:2px
    style REDIS fill:#90EE90,stroke:#333,stroke-width:2px
```

---

## Wrapping Up

Building a music streaming service at scale is a fascinating challenge that requires careful architectural decisions. By leveraging:

- **Stateless API servers** for independent horizontal scaling
- **Dual-database strategy** (SQL for metadata, object storage for media)
- **CDN with HLS streaming** for low-latency global delivery
- **Multi-layer caching** (client, CDN, Redis) for performance
- **Database read replicas and sharding** for scalability
- **Asynchronous processing** for heavy workloads

We can build a system that handles millions of users, serves millions of songs, and delivers low-latency playback globally—all while maintaining cost efficiency and high availability.

The architecture we've outlined provides a robust foundation not just for the immediate requirements, but also for future feature expansion and long-term business growth.

If you're preparing for system design interviews or working on building scalable systems, I hope this deep dive has been helpful. The principles here—stateless services, polyglot persistence, CDN caching, and strategic technology choices—apply to many large-scale distributed systems beyond just music streaming.

Feel free to share your thoughts or questions in the comments!
