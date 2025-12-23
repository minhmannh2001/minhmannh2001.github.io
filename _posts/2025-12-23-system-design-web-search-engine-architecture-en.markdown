---
layout: post
title: "System Design: Building a Scalable Distributed Web Search Engine"
date: '2025-12-23 15:00:00 +0700'
permalink: /2025/12/25/system-design-web-search-engine-architecture-en.html
excerpt: >
  Explore the architecture behind a web-scale search engine capable of indexing 100 billion pages. Learn about distributed crawlers, URL frontiers, inverted indexes, sharded databases, and the fascinating engineering challenges of building a system that handles petabytes of data and millions of queries per second.
comments: false
---

# System Design: Building a Scalable Distributed Web Search Engine

Hello there! Welcome back to my system design series. In my previous posts, we explored the architectures behind [Twitter](/2025/12/15/system-design-twitter-architecture-en.html) and [YouTube](/2025/12/19/system-design-youtube-architecture-en.html). Today, we're tackling one of the most fascinating challenges in distributed systems: building a web-scale search engine.

Building a search engine is deceptively simple in concept but incredibly complex in execution. The core function seems straightforward: index the vast, chaotic, and perpetually changing content of the internet and provide users with relevant results almost instantaneously. However, achieving this requires a distributed system of immense scale, capable of storing petabytes of data, handling millions of queries per second, and intelligently navigating the web to keep its information current.

Our goal here is to understand the high-level architecture of such a system. We'll explore how engineers solve the challenges of crawling billions of web pages, storing petabytes of data, and delivering search results in milliseconds. By the end, you'll have a solid grasp of the core concepts that make massive-scale search engines possible.

![Anatomy of a Search Engine](/img/system-design/web-search-engine/web-search-engine-inforgraphic.png)

The infographic above provides a comprehensive visual overview of the entire search engine architecture. It illustrates the two main pipelines—**Data Ingestion** (how the web is indexed) on the left and **Data Retrieval** (how a search is served) on the right—along with the massive scale metrics: 100 billion+ unique web pages, 200 petabytes of raw content storage, and ~2 terabits per second of crawler bandwidth. This visual guide will help orient you as we dive deeper into each component throughout this post.

Every great system design starts with understanding what the system must do. Let's begin with the fundamental user requirements.

## 1. The Blueprint: Core User Requirements

From a user's perspective, a search engine needs to do three things:

1. **Accept Search Queries**: The ability for a user to enter a search query.
2. **Find Relevant Pages**: The ability for the system to find relevant web pages related to that query.
3. **Display Results**: The ability for the user to view a results list containing titles, descriptions, and URLs for each site.

Simple enough, right? But the real challenge lies in achieving this at web scale. Let's explore the architecture that makes this possible.

## 2. High-Level System Overview: A Tale of Two Pipelines

The system's architecture is best understood as two distinct but interconnected data pipelines that operate concurrently:

### 2.1. The Query Processing Pipeline

This is the user-facing portion of the search engine. When you type a search query, your request flows through a load balancer to a horizontally-scaled fleet of API servers. These servers orchestrate a series of lookups against specialized indexes and databases to find relevant pages, retrieve their metadata, and construct a ranked list of results. This entire process is optimized for minimal latency—typically completing in milliseconds to deliver a seamless user experience.

### 2.2. The Data Ingestion Pipeline

This pipeline works in the background to populate the system's databases. It begins with a URL Frontier, which manages a massive list of web addresses to be visited. A distributed fleet of Crawlers fetches pages from the internet, which are then passed through a processing system that de-duplicates, stores, and indexes them. The output of this pipeline—the indexed web data—is what makes the query pipeline's rapid lookups possible.

Think of it like a library: the Query Processing Pipeline is the front desk where you ask for books, while the Data Ingestion Pipeline is the team of librarians constantly acquiring, cataloging, and organizing new books in the back.

![End-to-End Data Flow](/img/system-design/web-search-engine/diagram-6-end-to-end-data-flow.svg)

As illustrated in the diagram above, these two pipelines operate in parallel at massive scale. The Query Processing Pipeline (right side) handles millions of user searches per second, with the Load Balancer distributing requests to API Servers that query the Text Index and Metadata Database. The Data Ingestion Pipeline (left side) shows the URL Frontier managing 100 billion URLs, directing a fleet of 10,000 crawler servers that continuously crawl the web, process pages, and update the storage systems. Notice how the web itself feeds URLs back into the crawler fleet, creating a continuous cycle of data ingestion and indexing. The ingestion pipeline feeds data into the storage systems that the query pipeline relies upon—this is the key to keeping search results fresh and relevant.

Let's dive deeper into each pipeline, starting with the user-facing components.

## 3. The Query Processing Pipeline: From User Request to Results

The strategic success of a search engine is primarily measured by its ability to provide a fast, scalable, and responsive user experience. The Query Processing Pipeline is therefore critical, as it directly handles every user interaction.

![Query Processing Pipeline Detail](/img/system-design/web-search-engine/diagram-2-query-processing-pipeline-detail.svg)

### 3.1. API Gateway and Load Balancer

The front-end API serves as the single, unified entry point for all user search queries. It exposes a simple, well-defined endpoint:

- **Endpoint**: Accepts a `search_query` string and an optional `page_number` integer for paginating through extensive result sets.

To handle massive concurrent user traffic, a **Load Balancer** sits in front of the API. Its role is to distribute incoming requests evenly across a horizontally-scaled set of stateless API servers. This distribution prevents any single server from becoming a bottleneck, ensuring high availability and consistent performance even under peak load.

Think of the load balancer as a traffic cop directing cars (requests) to different lanes (servers) to prevent congestion.

### 3.2. Data Retrieval and Ranking Mechanism

Upon receiving a validated request from the load balancer, an API server initiates a three-step process to look up, retrieve, and assemble the search results. The diagram above shows this complete flow: a user query flows through the load balancer to an API server, which then performs three sequential operations to construct the search results.

#### Step 1: Text Index Lookup

The API server first queries the **Text Index**, a specialized, sharded database designed for fast, relevance-based lookups. It uses the user's search term (e.g., "cats") as the shard key to instantly locate the correct data partition. As shown in the diagram, the Text Index (sharded by word) returns URLs sorted by relevance.

This index is structured as an **inverted index**—think of it like the index at the back of a book, but instead of pointing to pages, it points to URLs. For any given word, the index contains a list of all URLs where that word appears. Crucially, this list is pre-sorted by the frequency of the term's appearance on each page, providing an initial layer of relevance ranking.

#### Step 2: Metadata Retrieval

With the list of relevant URLs from the Text Index, the API server then queries the primary distributed database. Using the URLs as lookup keys, it retrieves the essential metadata for each page, including its **Title** and **Description**, which are required to construct the user-facing results snippet. The diagram illustrates how the Metadata Database (sharded by URL) provides titles, descriptions, and content references.

#### Step 3: Content Reference

The metadata record in the database also contains a **Content_Reference** pointer. While not typically used during a standard search query, this reference points to the location of the full, raw HTML content stored in a separate blob store, making it available for more complex processing if needed. As shown in the diagram, Blob Storage is only accessed when the full raw content is required.

This entire process happens in milliseconds, thanks to the pre-sorted relevance data in the Text Index and efficient sharding strategies. This high-speed retrieval process is entirely dependent on an underlying data architecture designed to manage petabytes of web data, which we will now explore.

## 4. The Data Storage Architecture: Managing Petabytes of Web Data

The data storage strategy is founded on a critical architectural decision: **the separation of structured metadata from raw page content**. This is a direct response to the enormous difference in scale between the two data types.

### 4.1. The Scale Challenge

The system must manage approximately **30 terabytes** of relatively small, structured metadata records, but this is dwarfed by the **200 petabytes** of raw HTML content from the web pages themselves. Storing these distinct data types in separate, optimized systems is essential for performance and cost-effectiveness.

Think of it like a library: you don't store the entire book collection at the front desk. Instead, you keep a card catalog (metadata) at the desk for quick lookups, while the actual books (raw content) are stored in the warehouse (blob storage).

![Data Storage Architecture](/img/system-design/web-search-engine/diagram-3-data-storage-architecture.svg)

The diagram above illustrates the three-layer storage architecture. At the top is the **Primary Storage** layer: the Metadata Database (30 TB, sharded by URL). Below that are the **Specialized Indexes**: the Hash Index (sharded by hash) for de-duplication and the Text Index (sharded by word) for inverted indexing. At the bottom is the **Content Storage** layer: Blob Storage (200 PB) for raw HTML content. Notice how the diagram shows two key flows: the crawler process (left side) that checks for duplicates, stores metadata, updates indexes, and stores content; and the API server process (right side) that queries the Text Index, fetches metadata, and optionally accesses blob storage. This separation of concerns allows each storage layer to be optimized for its specific use case.

### 4.2. Core Data Schema

The primary metadata database stores structured information about each unique web page. The schema is defined as follows:

| Field | Purpose |
|-------|---------|
| **URL** | The unique identifier and primary lookup key for a web page. |
| **Title** | The page title, displayed to the user in search results. |
| **Description** | A summary of the page, displayed to the user. |
| **Content_Reference** | A pointer to the full page content in the external blob store. |
| **Hash** | A hash of the page content used for de-duplication. |
| **Last_Updated** | A timestamp indicating when the page was last crawled. |
| **Priority** | A value used by the URL Frontier to determine crawl frequency. |

### 4.3. Distributed Storage Layers

To manage this data at scale, the architecture employs multiple, specialized distributed storage systems.

#### Blob Storage

The 200 petabytes of raw page content are housed in a dedicated blob store (e.g., Amazon S3). This design choice optimizes query latency on the hot metadata path by offloading I/O for large, cold objects to a more cost-effective and specialized system designed for managing massive binary data.

#### Sharded Metadata Database

The 30 terabytes of metadata are managed in a sharded database. To ensure efficient lookups and horizontal scalability, the **URL is used as the shard key**. A URL's high cardinality (uniqueness) guarantees that when hashed, it produces an even data distribution across all nodes. This prevents hot spots, ensuring that no single node becomes overloaded, which is critical for maintaining predictable latency.

### 4.4. Specialized Indexing Systems

In addition to the primary storage layers, two other globally sharded databases serve as specialized indexes to support critical system functions.

#### Global Hash Index

The purpose of this index is to enable efficient duplicate detection across the entire dataset. Before storing a newly crawled page, the system computes its hash and queries this index using the page hash as the shard key. This allows the system to instantly determine if identical content already exists, preventing the costly storage and processing of redundant data.

#### Global Text Index

This is the core inverted index that powers search queries. In this sharded database, **the word itself serves as the shard key**. For any given word, the corresponding record contains a list of all URLs where that word appears, sorted by the frequency of its appearance on the page. This pre-sorted structure is the key design choice that allows the query API to rapidly retrieve a relevance-ranked list of pages for any search term.

With the data storage architecture defined, we now turn our attention to the system responsible for acquiring this data from the web.

## 5. The Data Ingestion Pipeline: The Web Crawler System

The data ingestion process represents a logistical and technical challenge of immense proportions. The crawler system is a massive, distributed fleet of servers whose sole purpose is to systematically and respectfully download the web.

![Crawler System Architecture](/img/system-design/web-search-engine/diagram-4-crawler-system-architecture.svg)

### 5.1. Scale of the Crawler Fleet

The operational scale of the crawler fleet is defined by several key metrics:

| Metric | Value |
|--------|-------|
| **Target** | Index 100 billion unique pages |
| **Recrawl Frequency** | Once every 10 days on average |
| **Daily Throughput** | 10 billion crawls per day |
| **Average Page Load Time** | 2 seconds |
| **Required Concurrency** | 231,000 concurrent crawls |
| **Fleet Size** | ~10,000 server nodes (20-30 crawls each) |
| **Bandwidth** | Nearly 2 terabits per second |

This incredible scale necessitates that the crawlers be distributed geographically. This strategy allows the system to leverage diverse internet infrastructure and ensures crawlers are physically close to the servers they are crawling, optimizing for lower latency.

### 5.2. The robots.txt Caching Strategy

Web standards require crawlers to respect a site's `robots.txt` file, which specifies crawl restrictions. A naive implementation would require fetching this file before every page crawl from a given host, introducing unacceptable overhead.

To solve this, the architecture implements a dedicated **robots.txt cache**. This component is a critical optimization designed to mitigate redundant network I/O and reduce the latency overhead inherent in respecting crawl policies on a per-request basis.

As shown in the diagram above, the crawler system operates as follows: The URL Frontier feeds URLs to a Crawler Selector, which distributes work across a massive fleet of crawlers. Each crawler follows a consistent process: first, it checks the robots.txt cache to see if it has the crawl restrictions for the target host. If there's a cache hit, it proceeds directly to crawling. If there's a cache miss, it fetches the robots.txt file from the internet, updates the cache, and then proceeds to crawl the page. After crawling, the crawler processes and stores the data, updating both the Database (for metadata) and Blob Storage (for raw content). This robots.txt caching strategy is crucial for efficiency—without it, crawlers would need to fetch the same robots.txt file repeatedly, creating massive overhead.

This fleet of crawlers, however, does not operate randomly; its actions are carefully directed by the URL Frontier.

## 6. The URL Frontier: Orchestrating the Crawl at Scale

The URL Frontier is the central nervous system of the entire data ingestion pipeline. It is far more than a simple list of URLs; it is a sophisticated, large-scale orchestration layer designed to manage what to crawl, when to crawl it, and how to do so without negatively impacting the web.

![URL Frontier System](/img/system-design/web-search-engine/diagram-5-url-frontier-system.svg)

### 6.1. Core Design Requirements

The URL Frontier must balance two primary and often competing requirements:

1. **Priority**: The system must crawl high-change-rate sites (e.g., news outlets like CNN.com) more frequently than static sites to ensure index freshness.

2. **Politeness**: With over 200,000 concurrent crawls, the system must prevent its crawlers from overwhelming any single host with a barrage of simultaneous requests, which could degrade or crash the target site.

### 6.2. The Two-Tier Queuing Architecture

To satisfy these requirements, the URL Frontier implements a sophisticated two-tier queuing system. The diagram above visualizes this architecture in detail.

#### Tier 1: Priority Queues

First, URLs are assigned a priority and fed into one of several queues (e.g., P1 for high, P2 for medium, P3 for low). As shown in the diagram, incoming URLs are prioritized and fed into **Tier 1: Priority Queues**. A biased queue selector mechanism pulls URLs for further processing. This selector chooses a queue at random, but the selection is weighted to favor higher-priority queues (e.g., a 50% chance of pulling from P1, 30% from P2, and 20% from P3). The diagram illustrates how the biased selector pulls URLs from these queues with weighted probabilities, ensuring high-priority sites are crawled more frequently.

#### Tier 2: Per-Host Politeness Queues

A Router component takes URLs selected from the priority queues and distributes them into a vast set of per-host queues. Every URL for a given host (e.g., example.com) is placed into the same dedicated queue. The diagram shows how URLs flow through the Router into **Tier 2: Per-Host Politeness Queues**, where URLs are organized by host (example1.com, example2.com, etc.).

#### Orchestration with a Heap

Politeness is enforced by a central **Heap** data structure, which functions as a distributed locking and rate-limiting system. The heap stores a reference to each per-host queue, ordered by the next permissible crawl time for that host. As illustrated in the diagram, the Heap manages these per-host queues, ordering them by the next permissible crawl time.

When a crawler is ready, it acquires an exclusive lock on the host queue by taking the top item from the heap. The crawler processes one URL from that host's queue and, upon completion, releases the queue back into the heap with an updated timestamp for the next valid crawl time (e.g., current time plus 10x the page load duration). This mechanism guarantees that only one crawler can work on a given host at any moment. The diagram shows how crawlers acquire locks from the heap, crawl one URL, and then release the queue back with an updated timestamp.

Think of it like a restaurant reservation system: the heap is the host stand that ensures only one party (crawler) is seated at each table (host) at a time, preventing overcrowding.

### 6.3. Implementation and Scalability

The URL Frontier must manage 100 billion URLs, translating to a storage requirement of approximately **5 terabytes**.

#### Storage Strategy

To manage the required 116,000 IOPS (I/O Operations Per Second), the bulk of the queue data is stored on high-speed SSDs. For maximum performance, the active ends of the queues are kept in RAM.

#### Heap Scalability

A heap is notoriously difficult to scale horizontally. This architecture makes a pragmatic compromise. By storing only pointers and timestamps, the heap is small enough to be held entirely in RAM. Critically, its state is not the source of truth; it can be completely reconstructed from the on-disk per-host queues. This design makes a single-node heap implementation both performant and resilient, mitigating the risk of data loss and making it an acceptable architectural trade-off.

## 7. Conclusion and Future Directions

The architecture described in this post outlines a robust, scalable, and distributed system capable of powering a web-scale search engine. Its design is rooted in a set of core principles that are essential for managing data and traffic of this magnitude.

### Key Architectural Themes

**Separation of Concerns**: The system clearly separates processing (query pipeline) from ingestion (crawler pipeline), and metadata from content. This separation allows each component to be optimized independently.

**Aggressive Distribution**: All databases and indexes are sharded to ensure horizontal scalability. This prevents any single component from becoming a bottleneck.

**Sophisticated Queueing**: The URL Frontier's two-tier queuing system balances the competing needs for index freshness and polite web citizenship.

**Pre-computation**: The Text Index pre-sorts results by relevance, allowing the query API to return ranked results almost instantly.

### Areas for Further Exploration

While this document covers the foundational architecture, building a truly competitive search engine involves continuous innovation. Several areas for further exploration could enhance the system's efficiency and functionality:

1. **Fault Tolerance**: Implementing robust recovery mechanisms is crucial. For example, a process could be designed to ensure that if a crawler selector fails after acquiring a lock on a host queue, that queue is automatically returned to the heap to prevent it from being permanently locked.

2. **Near-Duplicate Detection**: The current hash-based de-duplication method only catches identical content. Employing advanced techniques like "shingles" would allow the system to identify and intelligently handle pages with only minor differences, further optimizing storage and improving result quality.

3. **Advanced Ranking Algorithms**: The current relevance model is based on word frequency. Integrating more sophisticated signals, such as the famous PageRank algorithm which analyzes the web's link structure, would significantly improve the relevance of search results.

4. **Personalization**: To deliver a superior user experience, search results could be customized for individual users based on their search history, location, and other preferences. This represents a complex but valuable extension to the core ranking system.

---

**Reference**: This post is based on architectural concepts for building a scalable distributed web search engine. The design principles discussed here are fundamental to understanding how modern search engines like Google, Bing, and others operate at scale.

If you're also preparing for system design interviews or working on building scalable systems, I'd love to hear about your experiences and learnings. Feel free to share your thoughts in the comments or reach out!

