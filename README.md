<div align="center">

# ⚡ dynamo-bm25-hybrid

### Hybrid search for RAG that costs **$0 when nobody's searching.**

BM25 keyword search on **DynamoDB** + your vector DB, fused with **Reciprocal Rank Fusion**.
No OpenSearch. No Elasticsearch. No always-on clusters. No surprise bills.

[![npm](https://img.shields.io/npm/v/dynamo-bm25-hybrid?color=cb3837&logo=npm)](https://www.npmjs.com/package/dynamo-bm25-hybrid)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Serverless](https://img.shields.io/badge/serverless-scales%20to%20zero-232f3e?logo=amazon-aws&logoColor=white)](https://aws.amazon.com/dynamodb/)

</div>

---

## 🤔 The problem

Vector search alone **misses the obvious.** Ask a RAG app "what's the error code for `ERR_CONN_REFUSED`?" and embeddings happily return a paragraph about *connection handling in general* while the chunk literally containing `ERR_CONN_REFUSED` sits in 7th place. Embeddings are great at *vibes*, terrible at *exact terms* — error codes, product IDs, section references, config keys.

The fix is **hybrid search**: run keyword search *and* vector search, then merge. Every serious RAG system does this. But the standard way to get keyword search is OpenSearch or Elasticsearch, and those come with a bill:

| Approach | Cost at rest | Scales to zero? |
| :--- | :--- | :---: |
| OpenSearch Serverless | **~$175 / mo** minimum | ❌ |
| OpenSearch / Elastic managed | **~$700 / mo** minimum | ❌ |
| **`dynamo-bm25-hybrid`** | **$0 / mo** | ✅ |

For an internal tool, a side project, or anything with sporadic traffic, you're paying hundreds of dollars a month for a search cluster that sits idle 95% of the time.

## 💡 The idea

BM25 is just an inverted index with some clever term-frequency math. You don't need a cluster for that — you can **build the index once, serialize it, and stash it in a single DynamoDB item.** At query time you load it (~10ms), search it in memory (~1ms), and fuse the results with your vector search using **Reciprocal Rank Fusion**.

```
                         ┌──────────────────────────┐
   "error code           │  BM25 (DynamoDB, ~10ms)   │──┐
    ERR_CONN_REFUSED" ──►│  finds exact term match   │  │
                         └──────────────────────────┘  │
                                                        ├──► 🔀 RRF fusion ──► 🎯 top-K
                         ┌──────────────────────────┐  │        (< 1ms)
                    ────►│  Your vector DB (~200ms)  │──┘
                         │  finds "connection",       │
                         │  "refused", "timeout"…     │
                         └──────────────────────────┘
```

Runs both in **parallel**, so hybrid search adds ~0ms over a single vector query. The result: the chunk that matches on *both* the exact term and the meaning rockets to the top.

## ✨ Features

- 🪶 **Serverless & scale-to-zero** — pure DynamoDB on-demand. Pennies per thousand queries, nothing at rest.
- 🔀 **Generic Reciprocal Rank Fusion** — fuse 2, 3, or N ranked lists of *any* type. Not locked to BM25 + vectors.
- 🧩 **Bring your own vector DB** — Bedrock KB, Pinecone, pgvector, Qdrant, Weaviate… it's just a function you pass in.
- 🏢 **Multi-tenant by design** — namespace every index and chunk set (per workspace, per tenant, per user).
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
import { ChunkStore, BM25Indexer } from 'dynamo-bm25-hybrid';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const chunks  = new ChunkStore({ docClient: db, tableName: 'rag' });
const indexer = new BM25Indexer({ docClient: db, tableName: 'rag' });

// Store the chunks of a document
await chunks.writeChunks('tenant-42', 'doc-abc', 'api-reference.pdf', [
  { text: 'Error ERR_CONN_REFUSED is thrown when the target host refuses the TCP connection.', pageNumber: 1 },
  { text: 'Retry logic should use exponential backoff with a max of 3 attempts.',              pageNumber: 2 },
]);

// (Re)build the keyword index for the whole tenant
const all = await chunks.getChunksForNamespace('tenant-42');
const { chunkCount, sizeKB, buildTimeMs } = await indexer.build('tenant-42',
  all.map(c => ({ id: c.id, text: c.text, documentId: c.documentId,
                  documentName: c.documentName, pageNumber: c.pageNumber })));

console.log(`indexed ${chunkCount} chunks · ${sizeKB}KB · ${buildTimeMs}ms`);
```

### 2️⃣ Query — hybrid search in one call

```ts
import { BM25Searcher, HybridSearch } from 'dynamo-bm25-hybrid';

const hybrid = new HybridSearch({
  bm25: new BM25Searcher({ docClient: db, tableName: 'rag' }),

  // Plug in ANY vector search — this is the only glue you write
  semanticSearch: async (query, namespace, topK) => {
    const hits = await myVectorDB.search(query, { namespace, limit: topK });
    return hits.map(h => ({
      chunk: { id: h.id, text: h.text, documentId: h.docId,
               documentName: h.docName, pageNumber: h.page },
      score: h.similarity,
    }));
  },
});

const results = await hybrid.search('what does ERR_CONN_REFUSED mean?', 'tenant-42', 5);
//                                                    ↑ chunks found by BOTH paths rank first
```

That's it. No cluster to provision, no index lifecycle to babysit.

## 🧬 Use the RRF fusion on its own

The fusion engine is completely standalone — no DynamoDB, no BM25 required. Merge results from *any* sources: vector + keyword + graph + a reranker, whatever you've got.

```ts
import { fuse } from 'dynamo-bm25-hybrid';

const semantic = [{ key: 'a', item: docA }, { key: 'b', item: docB }];
const keyword  = [{ key: 'b', item: docB }, { key: 'c', item: docC }];
const graph    = [{ key: 'b', item: docB }, { key: 'd', item: docD }];

const merged = fuse([semantic, keyword, graph], { topK: 5 });
// → docB is #1: it's the only result all three strategies agreed on
```

**How RRF works** — each list contributes `1 / (k + rank)` to every item it contains (`k = 60` by default). Items appearing in multiple lists accumulate score across them, so *agreement between retrievers wins*. No score normalization, no tuning, no training. It just works, and it [beat learned rank-fusion methods in the original 2009 paper](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf).

## 🗄️ DynamoDB table

Single-table friendly — share it with your existing data via configurable prefixes.

| PK | SK | Holds |
| :--- | :--- | :--- |
| `CHUNKS#{namespace}` | `DOC#{docId}#C#{0001}` | chunk text + metadata |
| `BM25_INDEX#{namespace}` | `INDEX` | serialized BM25 index |

Just needs:
- Partition key `PK` (String) + sort key `SK` (String)
- **On-demand** billing (pay-per-request)

```bash
aws dynamodb create-table \
  --table-name rag \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

## 📚 API at a glance

| Export | What it does |
| :--- | :--- |
| `fuse(lists, opts?)` | Generic Reciprocal Rank Fusion over N ranked lists |
| `BM25Indexer` | Builds & serializes the keyword index into DynamoDB (ingestion time) |
| `BM25Searcher` | Loads the index and runs keyword search (query time, ~10ms) |
| `ChunkStore` | Store / read / delete chunks by document or namespace |
| `HybridSearch` | Convenience: parallel vector + BM25, fused with RRF |

## ⚖️ Good to know

- **400 KB per index.** The serialized BM25 index lives in a single DynamoDB item, so it caps at ~3–4k chunks per namespace. The library warns at 380 KB. Bigger corpus? Store the blob in S3 instead — same code, swap the persistence line.
- **Full rebuild per namespace.** Adding a document rebuilds that namespace's index. This is milliseconds at typical scale and keeps the design dead simple. If you have huge, high-churn namespaces, batch your rebuilds.
- **Language.** Ships with English stemming/stop-words out of the box (via `wink-nlp-utils`). Swap the prep-task pipeline for other languages.

## 🤝 Contributing

Issues and PRs welcome. Keep it small, keep it typed, keep it serverless.

## 📄 License

[MIT](./LICENSE) — do whatever you want, no warranty.

<div align="center">
<sub>Built for people who want great RAG search without renting a search cluster by the hour.</sub>
</div>
