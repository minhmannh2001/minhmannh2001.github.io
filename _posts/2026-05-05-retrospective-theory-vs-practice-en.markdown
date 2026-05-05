---
layout: post
title: "I Tried to Build the Distributed Search Engine from My Own Blog Post. Here's What Happened."
date: '2026-05-05 00:00'
excerpt: >-
  A few months ago I wrote a system design post about how to build a 100-billion-page distributed
  search engine. Then I actually tried to build it on AWS. This is the honest account of where the
  theory held up, where it fell apart, and why I eventually stopped.
comments: true
---

# I Tried to Build the Distributed Search Engine from My Own Blog Post. Here's What Happened.

A search engine does three things: crawl the web to collect pages, index those pages so they can be found, and answer queries in milliseconds. Simple in concept. At a billion-page scale, it becomes one of the hardest distributed systems problems in software engineering — you're coordinating thousands of machines, storing petabytes of data, and serving millions of queries per second simultaneously.

A few months ago I wrote [a system design post](https://minhmannh2001.github.io/2025/12/25/system-design-web-search-engine-architecture-en.html) explaining how such a system could be architected. I drew the diagrams. I described each component. The design looked clean on paper.

Then I decided to actually build it — not at 100 billion pages, but using the same architecture running on real AWS services, deployed from real infrastructure code, with real tests and a real search frontend.

Here is what I learned: system design posts describe roughly 20% of the work. The other 80% — the wiring, the deployment configuration, the permission model, the compatibility issues, the things that only surface when components actually talk to each other — that part the diagrams never show.

This post is about the 80%.

---

## 1. The Plan: Follow the Theory Exactly

My original post described a system built around two concurrent pipelines.

![System overview: Data Ingestion Pipeline and Query Pipeline](/img/retrospective-theory-vs-practice/01-system-overview.png)

**Data Ingestion**: A URL Frontier manages a prioritized queue of URLs to crawl. A crawler fleet fetches those pages, checks each site's `robots.txt` rules to know what it's allowed to access, and publishes the raw HTML to a message bus. A processing function then parses each page, checks whether it's a duplicate, stores it, and indexes every word into a searchable database. Any new links found on the page get added back to the queue — keeping the cycle going.

**Data Retrieval**: A user types a query. The request flows through an API layer to a function that looks up matching pages in the word index, fetches their metadata (title, description), and returns ranked results.

I expected the project to feel like filling in the blanks in a coloring book I had already drawn.

It did not feel like that.

---

## 2. What I Actually Built

Let me be specific about what exists in the codebase before talking about what broke.

### 2.1. Infrastructure: 14 CloudFormation Stacks

CloudFormation is AWS's way of defining infrastructure as code — you describe what resources you want (databases, queues, servers) in YAML files, and AWS creates them. The project is defined across 14 such files, each responsible for one layer of the system.

They must be deployed in a specific order because each layer depends on the one before it:

<img src="/img/retrospective-theory-vs-practice/02-cloudformation-stacks.png" alt="CloudFormation stack deployment order" style="max-width: 55%; display: block; margin: 0 auto;">

In plain terms, the stacks build up like this:
- **00–01**: Networking foundations and file storage (S3)
- **02–04**: The three message-passing services — a database (DynamoDB), a notification bus (SNS), and queues (SQS)
- **05–06**: The search index (OpenSearch) and cache (Redis via ElastiCache)
- **08–09**: Configuration store (SSM) and container registry (ECR, where Docker images live)
- **10–12**: The actual application code — the processing Lambda, the crawler (ECS), and the search API
- **13**: Monitoring alarms

> ⚠️ `10-ecs.yaml` deploys the crawler. This is the stack that blocked the project. More on that in section 5.

### 2.2. Source Code

Six Python packages, each tested independently with unit tests and BDD (Behavior-Driven Development) scenarios — a testing style where test cases are written in plain English sentences that describe expected behavior, then backed by code:

| Package | What it does in plain English |
|---------|-------------------------------|
| `src/frontier/` | Decides which URLs to crawl next and in what order; manages the crawl queue |
| `src/crawler/` | Fetches web pages, respects site crawling rules, and hands off raw HTML for processing |
| `src/processing/` | Parses each page, detects duplicates, stores the content, and adds every word to the search index |
| `src/search/` | Takes a user query, finds matching pages in the index, and builds the response |
| `src/observability/` | Structured logging and metrics so the system can be monitored in production |
| `src/shared/` | Shared AWS client setup, reused across all packages |

### 2.3. The React Frontend

A React 18 + Vite + Tailwind CSS frontend — a search bar, result cards with title, green URL, and description snippet, and pagination. It reads `VITE_API_URL` from a `.env.local` file that the `Makefile` updates automatically from the CloudFormation output after each deploy.

---

## 3. Theory vs. Practice: The Comparison

### 3.1. The URL Frontier — The Heap Disappears

**The coordination problem**: When you have thousands of crawlers running in parallel, you need a rule that prevents all of them from hitting the same website at once. Hammering a single host with hundreds of simultaneous requests would overload it (and get you blocked). So before a crawler fetches a URL from `nytimes.com`, it needs to know: is any other crawler already working on `nytimes.com` right now?

**What the theory said**: Build a two-tier queuing system with a **Heap** data structure at the center. The heap tracks the next permissible crawl time for each host and issues exclusive locks — only one crawler at a time gets access to a given host. When it's done, it releases the lock and the heap grants it to the next crawler waiting for that host.

<img src="/img/retrospective-theory-vs-practice/03-frontier-theory-heap.png" alt="Theory: Two-Tier URL Frontier with Heap" style="max-width: 55%; display: block; margin: 0 auto;">

![Practice: SQS FIFO with MessageGroupId](/img/retrospective-theory-vs-practice/04-frontier-practice-sqs.png)

**What I built**: Three SQS FIFO queues (FIFO = First In, First Out — messages are delivered in the order they arrive). The `FrontierClient` classifies each URL by domain and path, then enqueues it using `MessageGroupId = hostname`.

```python
# src/frontier/frontier_client.py
class FrontierClient:
    def enqueue_url(self, url: str):
        priority = self.classifier.classify(url)
        queue_url = self.queue_urls[priority]
        hostname = urlparse(url).hostname

        self.sqs.send_message(
            QueueUrl=queue_url,
            MessageBody=url,
            # SQS FIFO delivers one message per group at a time —
            # the next URL for this host only becomes visible after
            # the crawler deletes the previous one. No heap needed.
            MessageGroupId=hostname,
            # Timestamp suffix allows the same URL to be re-crawled later
            # without SQS deduplicating it as a duplicate send.
            MessageDeduplicationId=f"{url}-{int(time.time())}",
        )
```

The priority classifier is rule-based — a few dozen lines of domain + regex matching:

```python
# src/frontier/priority_classifier.py
class PriorityClassifier:
    def __init__(self):
        self.p1_domains = {"nytimes.com", "bbc.com", "cnn.com"}
        self.p3_domains = {"archive.org"}
        self.p3_patterns = [
            re.compile(r"\.js$"), re.compile(r"\.css$"),
            re.compile(r"\.jpg$"), re.compile(r"cdn\."),
            # ... other static asset patterns
        ]

    def classify(self, url: str) -> int:
        hostname = urlparse(url).hostname or ""
        for domain in self.p1_domains:
            if hostname.endswith(domain):
                return 1          # news sites → P1 (crawl first)
        for domain in self.p3_domains:
            if hostname.endswith(domain):
                return 3          # archives → P3 (crawl last)
        for pattern in self.p3_patterns:
            if pattern.search(urlparse(url).path):
                return 3          # static assets → P3
        return 2                  # everything else → P2
```

**The key insight**: The heap is the most intellectually complex part of the theory. It exists to answer one question: "how do you guarantee that only one crawler works on a given host at any moment?" SQS FIFO `MessageGroupId` answers that question natively — when a message for `nytimes.com` is being processed, SQS automatically holds back any other `nytimes.com` messages until the first one is deleted. No heap. No distributed locks. No custom code at all.

When you find the right primitive, you don't simplify the solution — you eliminate the problem it was solving.

**Simplification I kept**: The crawler only polls the P1 queue. The biased queue selector (50% P1, 30% P2, 20% P3) was planned but not implemented. With a single ECS task, a weighted selector adds complexity without changing throughput.

---

### 3.2. Recrawling — Keeping the Index Fresh

Web pages change over time. An article that was accurate when first crawled may be updated, corrected, or deleted a week later. A search engine needs to revisit pages periodically so its index doesn't go stale.

The theory describes this as a scheduled background process. My implementation handles it with a `RecrawlLambda` that scans the database for pages that haven't been updated recently and re-enqueues them for crawling:

```python
# src/frontier/recrawl_lambda.py
def handler(event, context):
    staleness_threshold = int(time.time()) - (staleness_days * 24 * 60 * 60)

    # Find pages not updated in the last N days
    response = table.scan(
        FilterExpression="#lu < :threshold",
        ExpressionAttributeNames={"#lu": "last_updated"},
        ExpressionAttributeValues={":threshold": staleness_threshold},
    )

    for item in response.get("Items", []):
        client.enqueue_url(item["url"])
```

The logic is identical to what the theory described. The difference is operational: the theory assumes this runs on a fixed schedule automatically; the implementation wires it as a Lambda function you can trigger on demand, or hook up to a scheduler later. Same concept, same data flow.

---

### 3.3. The Crawler — Scale Is a Dial

**What the theory said**: ~10,000 server nodes, each running 20-30 concurrent crawls, 231,000 concurrent crawls total, nearly 2 Tbps of bandwidth.

**What I built**:

```yaml
# infra/10-ecs.yaml
CrawlerService:
  Type: AWS::ECS::Service
  Properties:
    DesiredCount: 1       # The dial. Goes to 10,000 in theory.
    LaunchType: FARGATE
    TaskDefinition: !Ref CrawlerTaskDefinition
```

One Fargate task (a managed container that AWS runs for you, no servers to maintain). One SQS long-poll loop. The consumer receives one message at a time, processes it, then deletes it:

```python
# src/crawler/consumer.py
def run(self):
    logger.info("Starting SQS consumer", extra={"queue_url": self.queue_url})
    while self.running:
        response = self.sqs_client.receive_message(
            QueueUrl=self.queue_url,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=20,   # long poll — blocks up to 20s if queue is empty
        )
        if "Messages" in response:
            for message in response["Messages"]:
                self._process_message(message["Body"])
                self.sqs_client.delete_message(
                    QueueUrl=self.queue_url,
                    ReceiptHandle=message["ReceiptHandle"],
                )
```

And for each message, the full crawl workflow:

```python
def _process_message(self, message_body):
    url = json.loads(message_body)["url"]

    self.politeness.wait(url)                    # enforce per-host delay

    if not self.robots_fetcher.can_fetch(url):   # check robots.txt
        logger.warning("Disallowed by robots.txt", extra={"url": url})
        return

    html_content = self.page_fetcher.fetch(url)  # HTTP GET
    self.sns_publisher.publish(url, html_content) # publish to SNS

    emit_metric("SearchEngine", "PageCrawled", 1, "Count",
                [{"Name": "Domain", "Value": urlparse(url).hostname}])
```

The gap between 1 and 10,000 is not architectural — it's the number in `DesiredCount`. The same code runs in one task or ten thousand. What I didn't implement: concurrency *within* a single task. The consumer loop is synchronous. A real high-throughput crawler would use `asyncio` to keep dozens of HTTP requests in-flight simultaneously per node, rather than waiting for each one to finish before starting the next.

---

### 3.4. The robots.txt Cache

Every website can publish a `robots.txt` file at its root (e.g., `https://example.com/robots.txt`) that tells crawlers which pages they're allowed to access. A well-behaved crawler must check this before fetching any page. But checking it on every single request — by making a network call to the site — would be extremely slow. It needs to be cached.

**What the theory said**: A "dedicated robots.txt cache component" — a named box in the architecture diagram.

**What I built**: Two cache levels in a single Python class, accessed in order:

![robots.txt two-level cache: in-memory → Redis → network](/img/retrospective-theory-vs-practice/05-robots-cache.png)

```python
# src/crawler/robots_fetcher.py
def can_fetch(self, url, user_agent='*'):
    domain = urlparse(url).netloc

    # Level 1: in-memory (per-process, instant)
    if domain in self._parsers:
        parser = self._parsers[domain]
        return parser.can_fetch(user_agent, url) if parser else True

    # Level 2: Redis (shared across tasks, milliseconds)
    cache_key = f"robots:{domain}"
    content = self.redis_client.get(cache_key)

    # Level 3: network fetch (slow, happens once per domain per hour)
    if content is None:
        response = requests.get(f"https://{domain}/robots.txt", timeout=5)
        content = response.text if response.status_code == 200 else "allow_all"
        self.redis_client.setex(cache_key, self.cache_ttl, content)

    # Parse, cache in memory, return result
    if content == "allow_all":
        self._parsers[domain] = None
        return True
    parser = RobotFileParser()
    parser.parse(content.splitlines())
    self._parsers[domain] = parser
    return parser.can_fetch(user_agent, url)
```

The theory's "dedicated component" is this class. The two-level cache isn't a simplification — it's the correct design. In-memory is fastest but lives only inside one process. Redis is shared across all crawler tasks, so if task A already fetched `nytimes.com/robots.txt`, task B doesn't need to make that network call again. The network is the slowest and happens at most once per domain per hour.

---

### 3.5. Processing Pipeline — Seven Steps Instead of "Lambda Processes Pages"

**What the theory said**: "Lambda processes pages: parse → hash → deduplicate → store → index."

**What I built**: A seven-step pipeline where each step is a separate module:

<img src="/img/retrospective-theory-vs-practice/06-processing-pipeline.png" alt="Processing pipeline: 7 steps from SNS event to link re-enqueue" style="max-width: 55%; display: block; margin: 0 auto;">

The deduplication check (step 3) replaces the theory's "Global Hash Index". Instead of a separate database for hashes, this uses a secondary index on the existing pages table — same O(1) lookup speed, one fewer infrastructure component to maintain:

```python
# src/processing/hasher.py
def is_duplicate(dynamodb_client, content_hash: str) -> bool:
    response = dynamodb_client.query(
        TableName='pages',
        IndexName='hash-index',        # GSI on the existing pages table
        KeyConditionExpression='#h = :h',
        ExpressionAttributeNames={'#h': 'hash'},  # 'hash' is a reserved word in DynamoDB
        ExpressionAttributeValues={':h': {'S': content_hash}},
        Select='COUNT'
    )
    return response['Count'] > 0
```

The OpenSearch indexer is where the search ranking logic actually lives. For each page, it creates one document per word — storing how many times that word appears on that page:

```python
# src/processing/opensearch_indexer.py
def _create_bulk_body(url: str, frequencies: dict[str, int]) -> str:
    body = ""
    for word, freq in frequencies.items():
        # One document per (word, url) pair. Using word+url as the ID
        # means re-indexing the same page is safe — it overwrites, not duplicates.
        action = {"index": {"_index": "text-index", "_id": f"{word}-{url}"}}
        body += json.dumps(action) + "\n"
        # freq = how many times this word appears on this page
        document = {"word": word, "url": url, "frequency": freq}
        body += json.dumps(document) + "\n"
    return body
```

This is how ranking works in practice: when someone searches for "python", the query finds every document where `word = "python"` and sorts them by `frequency` descending. The page that mentions "python" most often appears first. Simple, but it works for a first implementation.

---

### 3.6. The Search API — Four Steps to a Search Result

**What the theory said**: Load balancer → API servers → Text Index lookup → Metadata fetch → response.

**What I built**: API Gateway → Lambda → four functions:

![Search API sequence: Browser → API Gateway → Lambda → OpenSearch → DynamoDB](/img/retrospective-theory-vs-practice/07-search-api-sequence.png)

```python
# src/search/handler.py
def handler(event, context):
    params = event.get("queryStringParameters")
    validated_params, error = query_validator.validate_and_normalize_query(params)
    if error:
        return {**error, "headers": CORS_HEADERS}

    query = validated_params["query"]
    sorted_urls = search_lambda.search_by_word(query)       # OpenSearch
    metadata_map = metadata_enricher.fetch_metadata(         # DynamoDB batch
        sorted_urls, pages_table_name
    )
    return {
        "statusCode": 200,
        "headers": CORS_HEADERS,
        "body": json.dumps(response_builder.build_response(
            sorted_urls, metadata_map,
            validated_params["page"], validated_params["page_size"]
        )),
    }
```

One non-obvious detail: when a browser makes a request to an API on a different domain, it requires CORS headers in the response — otherwise it blocks the request for security reasons. With AWS_PROXY integration, API Gateway forwards the Lambda's response directly to the browser without adding anything. This means the CORS headers must come from the Lambda itself. If you configure them only in API Gateway's settings, they never actually reach the browser.

---

### 3.7. Politeness — SSM Instead of a Heap

Even with SQS FIFO guaranteeing that only one crawler works on a given host at a time, you still need to enforce delays between requests to that host. Fetching 100 pages from `nytimes.com` in one second, sequentially, is still too aggressive.

My implementation handles this in the `Politeness` class, with configurable delays stored in SSM Parameter Store (AWS's configuration key-value store):

```python
# src/crawler/politeness.py
def wait(self, url):
    host = urlparse(url).netloc
    # Per-host delay from SSM: /crawler/config/host_crawl_delay/{host}
    # Falls back to /crawler/config/default_crawl_delay
    delay = self._get_delay_for_host(host)

    last_time = self.last_request_time.get(host)
    if last_time:
        elapsed = time.time() - last_time
        if elapsed < delay:
            time.sleep(delay - elapsed)  # wait out the remaining delay

    self.last_request_time[host] = time.time()
```

The theory's heap tracked per-host timestamps and granted locks. Here, the per-host coordination across tasks is already handled by SQS FIFO — and the per-request delay is handled by this simple sleep. Two separate mechanisms, each doing one job.

---

### 3.8. Observability — The Theory Skipped This Entirely

**What the theory said**: Mentioned "monitoring" in passing.

**What I built**: Structured JSON logging injected into every component, custom CloudWatch metrics for events AWS doesn't measure automatically, and three alarms defined in CloudFormation.

Structured logging means every log line is a JSON object rather than plain text — which lets you query logs like a database:

```python
# src/observability/logger.py — every service gets a logger like this
logger = get_logger("crawler", "crawler")
logger.info("Processing URL", extra={"url": url})
# → {"timestamp": "...", "level": "INFO", "message": "Processing URL",
#    "service": "crawler", "url": "https://example.com/page"}
```

```sql
fields @timestamp, service, message, url
| filter level = "ERROR" and service = "crawler"
| stats count(*) by bin(5m)
```

Custom metrics track business events that AWS doesn't measure automatically — like how many pages are being crawled per domain:

```python
# src/crawler/consumer.py — emitted after each successful crawl
emit_metric(
    namespace="SearchEngine",
    metric_name="PageCrawled",
    value=1,
    unit="Count",
    dimensions=[{"Name": "Domain", "Value": urlparse(url).hostname}],
)
```

And the alarms in `infra/13-cloudwatch-alarms.yaml`:

```yaml
P1QueueDepthAlarm:
  # If P1 queue depth exceeds 500, the crawler is falling behind
  # on high-priority content — alert immediately
  Threshold: 500
  Period: 60
  Statistic: Maximum   # peaks matter more than averages for queue depth
  TreatMissingData: notBreaching  # idle overnight is expected, not an alert

ProcessingLambdaErrorAlarm:
  # 5 errors in 5 minutes is a pattern, not a blip
  Threshold: 5
  Period: 300
  Statistic: Sum
```

Observability isn't glamorous. It also doesn't appear in system design diagrams. But without it, you're flying blind — you have no way to know whether the system is working, degrading, or silently broken.

---

## 4. The Full Gap Table

| Aspect | Theory | Implementation | Why different |
|--------|--------|----------------|---------------|
| Politeness mechanism | Heap data structure, distributed lock per host | SQS FIFO `MessageGroupId` | SQS guarantees one in-flight message per host natively — no custom locking needed |
| Biased queue selector | Weighted random: 50% P1, 30% P2, 20% P3 | Crawler polls P1 only | With a single task, a weighted selector adds code without changing throughput |
| Crawler scale | 10,000 nodes, 231K concurrent | 1 ECS Fargate task | Same architecture; `DesiredCount` is the only difference |
| Concurrent crawls per node | 20–30 per node | 1 (synchronous loop) | `asyncio` planned but not implemented; synchronous loop is simpler to reason about |
| Global Hash Index | Separate sharded database | DynamoDB secondary index on `pages` table | Same O(1) lookup speed, one fewer database to manage |
| robots.txt | "Dedicated component" | Redis (shared) + in-memory dict (per-process) | Two-level cache is the correct implementation of that "dedicated component" |
| Observability | Not mentioned | Structured JSON logs + CloudWatch metrics + 3 alarms | Required to know if the system is alive; invisible in theory, mandatory in practice |
| Dedup ID scheme | Not specified | `{url}-{timestamp}` | Allows re-crawling the same URL later without SQS treating it as a duplicate |

---

## 5. Why I Stopped

Here is the honest answer.

Everything I built works individually. The unit tests pass. The BDD scenarios — plain-English test cases like "given a seed URL, when the frontier is seeded, then the URL appears in the priority queue" — pass against simulated AWS services using moto, a Python library that mocks the AWS API locally so you can run tests without a real AWS account.

But the crawler never ran end-to-end. Not because the code was wrong. Because **ECS Fargate resources are only available in LocalStack Pro**, not the free community edition I was using.

LocalStack is a tool that emulates AWS services locally so you can develop and test without paying for real cloud infrastructure. The community edition supports most services — SQS, SNS, DynamoDB, S3, Lambda. But ECS (the service that runs Docker containers) requires the paid Pro tier.

When `make infra-deploy` reaches `10-ecs.yaml`, LocalStack community silently accepts the CloudFormation template, marks the stack `CREATE_COMPLETE`, and then does nothing. No cluster. No task definition. No service. The stack "succeeds" but the resources don't exist. You only discover this when you try to run a task and get an empty response:

```bash
$ aws ecs list-tasks --cluster crawler-cluster
{
    "taskArns": []   # The service exists. The tasks do not.
}
```

This was the most frustrating moment of the project. I'd written weeks of crawler code, integration tests, CloudFormation templates — and the environment that was supposed to run it was silently pretending to work while actually doing nothing. No error. No warning. Just an empty array where the tasks should have been.

Without the crawler running, the entire pipeline collapses:

<img src="/img/retrospective-theory-vs-practice/08-pipeline-status.png" alt="Pipeline status: Crawler blocked at ECS, all downstream components idle" style="max-width: 100%; display: block; margin: 0 auto; min-height: 80px; object-fit: contain;">

I eventually split the ECS stack into a separate `make infra-deploy-pro` target and documented the blocker clearly. But finishing the project from there would have meant either:

1. Paying for LocalStack Pro ($50+/month)
2. Running the full pipeline on real AWS (costs money, requires production credentials)
3. Replacing ECS with Docker Compose for local dev (a significant rearchitecture)

The cost — in time and cognitive overhead — of any of these paths outweighed the remaining learning return. I had already learned the things I set out to learn. The missing piece was operational, not architectural.

So I stopped.

---

## 6. What I Learned

### 6.1. The Right Primitive Eliminates the Problem

The theory's heap solves a real problem: how do you prevent thousands of crawlers from simultaneously hammering the same host? The answer the theory gave was a distributed locking mechanism — the heap.

SQS FIFO with `MessageGroupId` makes the question disappear. No heap. No distributed locks. No in-memory state that needs to survive failures. The queue service itself guarantees that only one message per hostname is in-flight at any time.

This is the biggest gap in the project. The most intellectually complex part of the theory is completely unnecessary when you use the right building block.

### 6.2. Scale Is a Dial, Not a Design Constraint

`DesiredCount: 1` vs `DesiredCount: 10000`. Same code. Same infrastructure templates. Same architecture. The number in the YAML is the only difference.

All the "10,000 nodes" language in system design discussions is, architecturally speaking, a red herring. The interesting question is never the number — it's whether the architecture *allows* the number to change. This one does. Every crawler task independently polls SQS and publishes to SNS. There's no shared mutable state between tasks. You can go from 1 to 10,000 without touching the application code.

### 6.3. The Theory Describes What. Practice Reveals How.

Every system design blog describes components and their contracts — what each box does, what it talks to. Almost none describe the operational reality of connecting those components:

- CloudFormation deployments are asynchronous. When you run `aws cloudformation deploy`, the command returns before the resources are actually ready. You need polling loops to know when it's safe to deploy the next stack.
- IAM (Identity and Access Management) — AWS's permission system — requires you to explicitly grant every service permission to call every other service. Every Lambda function needs a role that allows it to read from SQS, write to DynamoDB, publish to SNS. Getting this wrong produces cryptic "Access Denied" errors at runtime.
- The OpenSearch client inside a Lambda function can't resolve the cluster's domain name the same way your laptop can — the DNS configuration is different inside the AWS network.
- CORS headers must come from your Lambda, not from API Gateway's configuration layer.

That operational layer — the glue between components — is where the real engineering lives. In this project, the data pipeline logic took maybe 20% of the total effort. The other 80% was deployment configuration, permission policies, async handling, test infrastructure, and compatibility issues.

System design blogs talk about the 20%. The 80% is what building actually teaches you.

### 6.4. A Correct Implementation Is Not a Running System

All 78 unit tests pass. Every BDD scenario passes against mocked AWS services. The code is correct by every measure I could apply without running the full pipeline.

And yet: the search API returns empty results, because the crawler never ran to populate the index.

The gap between "tests passing" and "system working" is the integration gap — the part that only closes when you run all components together against real infrastructure. For a distributed system with six components across two pipelines, that gap is wide. Unit tests give you confidence in each component in isolation. They give you no confidence that the components connect correctly in practice.

---

## 7. What I Would Do Differently

**Use AWS CDK instead of raw CloudFormation.** CDK (Cloud Development Kit) lets you define infrastructure in real programming languages — Python, TypeScript — instead of YAML. You get typed references between resources, automatic dependency ordering, and real code reuse. The shell-script polling loop in the Makefile that waits for each stack to complete before starting the next is a poor substitute for what CDK handles automatically.

**Use Docker Compose for local dev instead of LocalStack for the crawler.** LocalStack Community has gaps. A Docker Compose setup — with a real Redis container, a real OpenSearch container, LocalStack for SQS/SNS/DynamoDB/S3, and the crawler container — would have given a complete local environment where the full pipeline could actually run end-to-end, without needing ECS at all.

**Write the end-to-end test first.** I wrote unit tests for each component before moving to the next. But the first test I should have written was: "seed one URL, wait 30 seconds, search for a word that appears on that page, assert at least one result comes back." That single integration test would have surfaced the ECS/LocalStack incompatibility on day one, before I'd built an entire implementation around an environment that couldn't run it.

**Accept the cloud earlier.** Running the full pipeline against real AWS for a few hours of testing costs a few dollars. The instinct to keep everything local is understandable — it's faster, it's free, it's reproducible. But sometimes that instinct creates more friction than it removes.

---

## 8. Conclusion

I wrote a system design post about a distributed search engine. Then I implemented it — 14 infrastructure stacks, six Python packages, 78 unit tests, a React frontend. I ran into every operational problem the original post never mentioned.

The theory was mostly right. The architecture held up. SQS FIFO turned out to be a more elegant frontier than the heap I'd designed. DynamoDB's secondary index turned out to be a more practical deduplication store than a separate sharded database. One container can become ten thousand with a single YAML change.

What the theory couldn't tell me was everything in the gap between design and deployment. The permission model. The async timing. The local emulator that silently pretended to work. The difference between code that is correct and a system that actually runs.

The code is all here. The unit tests pass. The architecture is sound.

The crawler never ran.

That's also worth knowing.

---

*The full source code, CloudFormation templates, and test suite are available on
[GitHub](https://github.com/minhmannh2001/distributed-search). The original theory post that
this project was based on is [here](https://minhmannh2001.github.io/2025/12/25/system-design-web-search-engine-architecture-en.html).*
