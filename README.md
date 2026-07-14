<div align="center">

# ⚡ dynamo-bm25-hybrid

### The retrieval tool your AI agent is missing — hybrid search that costs **$0 when idle.**

BM25 keyword search on **DynamoDB** + your vector DB, fused with **Reciprocal Rank Fusion**.
No OpenSearch. No Elasticsearch. No always-on clusters. No surprise bills.

[![npm](https://img.shields.io/npm/v/dynamo-bm25-hybrid?color=cb3837&logo=npm)](https://www.npmjs.com/package/dynamo-bm25-hybrid)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Serverless](https://img.shields.io/badge/serverless-scales%20to%20zero-232f3e?logo=amazon-aws&logoColor=white)](https://aws.amazon.com/dynamodb/)

</div>

---

## 🤖 Built for the age of agents

Your LLM agent is only as good as what it can retrieve. Give it a `search` tool backed by pure vector similarity and it will confidently miss the exact thing the user asked for — the error code, the SKU, the config key, the API name. Embeddings are brilliant at *meaning* and clumsy at *literals*.

`dynamo-bm25-hybrid` is a drop-in **retrieval tool for agentic RAG**: one function your agent calls, which fans out to keyword *and* semantic search in parallel and fuses the results. It plugs straight into the Vercel AI SDK, LangChain, LlamaIndex, an MCP server, or a raw tool-calling loop.

> 📊 In keyword-heavy retrieval, BM25 alone lands around **72% recall**; adding semantic search and fusing pushes it to roughly **91%** — a ~25-point jump that decides whether your agent answers or hallucinates. *(Figures reported by [tianpan.co](https://tianpan.co/blog/2025-10-02-beyond-rag-hybrid-search-and-agentic-retrieval); rephrased for compliance.)*

## 🤔 The problem

Vector search alone **misses the obvious.** Ask a RAG agent "what's the error code for `ERR_CONN_REFUSED`?" and embeddings happily return a paragraph about *connection handling in general* while the chunk literally containing `ERR_CONN_REFUSED` sits in 7th place. Embeddings are great at *vibes*, terrible at *exact terms* — error codes, product IDs, section references, config keys.

The fix is **hybrid search**: run keyword search *and* vector search, then merge. Every serious RAG system does this. But the usual way to get keyword search is OpenSearch or Elasticsearch, and those come with a bill:

| Approach | Cost at rest | Scales to zero? |
| :--- | :--- | :---: |
| OpenSearch Serverless | **~$175 / mo** minimum | ❌ |
| OpenSearch / Elastic managed | **~$700 / mo** minimum | ❌ |
| **`dynamo-bm25-hybrid`** | **$0 / mo** | ✅ |

For an internal tool, a side project, or an agent with sporadic traffic, you're paying hundreds a month for a search cluster that sits idle 95% of the time.

## 💡 The idea

BM25 is just an inverted index with some clever term-frequency math. You don't need a cluster for that — you can **build the index once, serialize it, and stash it in a single DynamoDB item.** At query time you load it (~10ms), search it in memory (~1ms), and fuse with your vector search using **Reciprocal Rank Fusion**.

```
                         ┌──────────────────────────┐
   agent calls           │  BM25 (DynamoDB, ~10ms)   │──┐
   search("ERR_CONN…") ─►│  finds exact term match   │  │
                         └──────────────────────────┘  │
                                                        ├──► 🔀 RRF fusion ──► 🎯 top-K ──► agent context
                         ┌──────────────────────────┐  │        (< 1ms)
                    ────►│  Your vector DB (~200ms)  │──┘
                         │  finds "connection",       │
                         │  "refused", "timeout"…     │
                         └──────────────────────────┘
```

Both retrievals run in **parallel**, so hybrid search adds ~0ms over a single vector query. The chunk that matches on *both* the exact term and the meaning rockets to the top.

## ✨ Features

- 🤖 **Agent-ready** — expose it as a single tool; works with any tool-calling framework or MCP server.
- 🪶 **Serverless & scale-to-zero** — pure DynamoDB on-demand. Pennies per thousand queries, nothing at rest.
- 🔀 **Generic Reciprocal Rank Fusion** — fuse 2, 3, or N ranked lists of *any* type. Not locked to BM25 + vectors.
- 🧩 **Bring your own vector DB** — Bedrock KB, Pinecone, pgvector, Qdrant, Weaviate… it's just a function you pass in.
- 🏢 **Multi-tenant by design** — namespace every index and chunk set (per user, per tenant, per project).
- 🧠 **Real BM25** — stemming, stop-word removal, negation handling via `wink-bm25-text-search`.
- 📦 **Single-table design** — drops into your existing DynamoDB table with configurable key prefixes.
- 🔒 **Fully typed** — strict TypeScript, ESM, zero `any` in the public API.
- 🐣 **Tiny** — a handful of files, two small dependencies. Read the whole thing in 10 minutes.

## 📦 Install

```bash
npm install dynamo-bm25-hybrid
```

You'll also want the AWS SDK v3 clients (most projects already have them):

```bash
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

## 🚀 60-second quickstart

### 1️⃣ Ingest — store chunks & build the index

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SegmentStore, LexicalIndexer } from 'dynamo-bm25-hybrid';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const segments = new SegmentStore({ docClient: db, tableName: 'rag' });
const indexer  = new LexicalIndexer({ docClient: db, tableName: 'rag' });

// Store the segments of a document
await segments.putSegments('tenant-42', 'doc-abc', 'api-reference.pdf', [
  { text: 'Error ERR_CONN_REFUSED is thrown when the target host refuses the TCP connection.', page: 1 },
  { text: 'Retry logic should use exponential backoff with a max of 3 attempts.',              page: 2 },
]);

// (Re)build the keyword index for the whole tenant
const all = await segments.listByNamespace('tenant-42');
const { segmentCount, bytesKB, buildMs } = await indexer.build('tenant-42',
  all.map(s => ({ id: s.id, text: s.text, docId: s.docId, docName: s.docName, page: s.page })));

console.log(`indexed ${segmentCount} segments · ${bytesKB}KB · ${buildMs}ms`);
```

### 2️⃣ Query — hybrid search in one call

```ts
import { LexicalSearcher, HybridSearch } from 'dynamo-bm25-hybrid';

const hybrid = new HybridSearch({
  lexical: new LexicalSearcher({ docClient: db, tableName: 'rag' }),

  // Plug in ANY vector search — this is the only glue you write
  vectorSearch: async (query, namespace, limit) => {
    const hits = await myVectorDB.search(query, { namespace, limit });
    return hits.map(h => ({
      segment: { id: h.id, text: h.text, docId: h.docId, docName: h.docName, page: h.page },
      score: h.similarity,
    }));
  },
});

const results = await hybrid.search('what does ERR_CONN_REFUSED mean?', 'tenant-42', 5);
//                                                    ↑ segments found by BOTH strategies rank first
```

That's it. No cluster to provision, no index lifecycle to babysit.

## 🛠️ Wire it as an agent tool

The whole point: give your agent **one retrieval tool** that just works. Here it is with the Vercel AI SDK — but the pattern is identical for LangChain, LlamaIndex, OpenAI function calling, or an MCP server.

```ts
import { tool } from 'ai';
import { z } from 'zod';

const searchKnowledge = tool({
  description: 'Search the knowledge base. Handles both exact terms (error codes, IDs, ' +
               'config keys) and conceptual questions. Always use this before answering.',
  parameters: z.object({
    query: z.string().describe('The search query — can be keywords or a natural question'),
  }),
  execute: async ({ query }) => {
    const results = await hybrid.search(query, currentTenant, 5);
    return results.map(r => ({
      text: r.segment.text,
      source: `${r.segment.docName} (p.${r.segment.page})`,
      matchedBy: r.strategies === 2 ? 'keyword + semantic' : 'single strategy',
    }));
  },
});

// The agent now decides when to search, and gets exact + semantic hits fused.
```

**Why agents love this tool:**
- **One tool, both strategies** — the agent doesn't have to reason about "should I keyword-search or vector-search?" It asks once; fusion handles the rest.
- **Grounded citations** — every result carries its document + page, so the agent can attribute claims and you can verify them.
- **`matchedBy` signal** — results found by both strategies (`strategies: 2`) are the strongest; agents can weight them or surface them first.
- **Cheap enough to over-call** — at DynamoDB on-demand prices, an agent hammering the search tool during a reasoning loop costs pennies, not a cluster.

## 🧬 Use the RRF fusion on its own

The fusion engine is completely standalone — no DynamoDB, no BM25 required. Merge results from *any* sources: vector + keyword + graph + a reranker, whatever your agent pipeline produces.

```ts
import { fuse } from 'dynamo-bm25-hybrid';

const semantic = [{ key: 'a', value: docA }, { key: 'b', value: docB }];
const keyword  = [{ key: 'b', value: docB }, { key: 'c', value: docC }];
const graph    = [{ key: 'b', value: docB }, { key: 'd', value: docD }];

const merged = fuse([semantic, keyword, graph], { limit: 5 });
// → docB is #1: it's the only result all three strategies agreed on
```

**How RRF works** — each list contributes `1 / (k + rank)` to every entry it contains (`k = 60` by default). Entries appearing in multiple lists accumulate score across them, so *agreement between retrievers wins*. No score normalization, no tuning, no training. It just works, and it [beat learned rank-fusion methods in the original 2009 paper](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf).

## 🎯 When to reach for this

| You're building… | Why this fits |
| :--- | :--- |
| A **RAG agent** over docs/wikis/tickets | Exact-term recall + semantics in one tool call |
| An **internal copilot** with bursty traffic | Scale-to-zero cost, no idle cluster bill |
| A **multi-tenant SaaS** with per-customer knowledge | Namespace isolation baked into the keys |
| An **MCP server** exposing search to Claude/others | One clean `search(query)` surface |
| A **prototype** you don't want to pay for yet | `$0/mo` until someone actually queries |

## 🗄️ DynamoDB Table Design

This library uses **single-table design**. You can share the table with your existing data:

| PK | SK | Purpose |
|----|-----|---------|
| `SEG#{namespace}` | `D#{docId}#S#{0001}` | Segment text + metadata |
| `LEXIDX#{namespace}` | `BLOB` | Serialized BM25 index (JSON blob) |

**Required table schema:**
- Partition key: `PK` (String)
- Sort key: `SK` (String)
- Billing: On-demand (pay-per-request)

```bash
aws dynamodb create-table \
  --table-name rag \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

The PK/SK prefixes are configurable via `keyPrefix` and `sortKey` options.

## 📚 API at a glance

| Export | What it does |
| :--- | :--- |
| `fuse(lists, opts?)` | Generic Reciprocal Rank Fusion over N ranked lists |
| `LexicalIndexer` | Builds & serializes the keyword index into DynamoDB (ingestion time) |
| `LexicalSearcher` | Loads the index and runs keyword search (query time, ~10ms) |
| `SegmentStore` | Store / read / delete segments by document or namespace |
| `HybridSearch` | Convenience: parallel vector + BM25, fused with RRF |

## ⚖️ Good to know

- **400 KB per index.** The serialized BM25 index lives in a single DynamoDB item, so it caps at ~3–4k segments per namespace. The library warns at 380 KB. Bigger corpus? Store the blob in S3 instead — same code, swap the persistence line.
- **Full rebuild per namespace.** Adding a document rebuilds that namespace's index. This is milliseconds at typical scale and keeps the design dead simple. If you have huge, high-churn namespaces, batch your rebuilds.
- **Language.** Ships with English stemming/stop-words out of the box (via `wink-nlp-utils`). Swap the prep-task pipeline for other languages.

## 🤝 Contributing

Issues and PRs welcome. Keep it small, keep it typed, keep it serverless.

## 📄 License

[MIT](./LICENSE) — do whatever you want, no warranty.

<div align="center">
<sub>Give your agent a retrieval tool that catches the exact word <em>and</em> the meaning — without renting a search cluster by the hour.</sub>
</div>
