/**
 * Example: Lambda API for hybrid search.
 *
 * Two endpoints:
 *   POST /ingest  — store document segments + rebuild BM25 index
 *   POST /search  — hybrid search (keyword + vector, fused with RRF)
 *
 * Deploy this as a Lambda behind API Gateway or a Function URL.
 * Requires: DynamoDB table with PK/SK string keys, on-demand billing.
 *
 * Environment variables:
 *   TABLE_NAME — DynamoDB table name
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  SegmentStore,
  LexicalIndexer,
  LexicalSearcher,
  HybridSearch,
  type VectorSearchFn,
} from 'dynamo-bm25-hybrid';

// --- Setup (runs once per Lambda cold start) ---

const TABLE = process.env.TABLE_NAME ?? 'rag-table';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const segments = new SegmentStore({ docClient: db, tableName: TABLE });
const indexer = new LexicalIndexer({ docClient: db, tableName: TABLE });
const searcher = new LexicalSearcher({ docClient: db, tableName: TABLE });

// Plug in your own vector search here.
// This example uses a stub — replace with Bedrock KB, Pinecone, pgvector, etc.
const vectorSearch: VectorSearchFn = async (_query, _namespace, _limit) => {
  // TODO: Replace with your actual vector DB call
  // Example with Bedrock KB:
  //   const { retrievalResults } = await bedrockAgent.send(new RetrieveCommand({
  //     knowledgeBaseId: 'YOUR_KB_ID',
  //     retrievalQuery: { text: query },
  //     retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: limit } },
  //   }));
  //   return retrievalResults.map(r => ({ segment: { ... }, score: r.score }));
  return [];
};

const hybrid = new HybridSearch({ lexical: searcher, vectorSearch });

// --- Handler ---

interface LambdaEvent {
  httpMethod?: string;
  requestContext?: { http?: { method?: string; path?: string } };
  path?: string;
  body?: string;
}

export async function handler(event: LambdaEvent) {
  const method = event.httpMethod ?? event.requestContext?.http?.method ?? 'GET';
  const path = event.path ?? event.requestContext?.http?.path ?? '/';

  try {
    if (method === 'POST' && path.includes('/ingest')) {
      return await handleIngest(JSON.parse(event.body ?? '{}'));
    }
    if (method === 'POST' && path.includes('/search')) {
      return await handleSearch(JSON.parse(event.body ?? '{}'));
    }
    return respond(404, { error: 'Not found. Use POST /ingest or POST /search' });
  } catch (err: any) {
    console.error(err);
    return respond(500, { error: err.message });
  }
}

// --- Ingest ---

interface IngestBody {
  namespace: string;
  docId: string;
  docName: string;
  segments: Array<{ text: string; page: number }>;
}

async function handleIngest(body: IngestBody) {
  const { namespace, docId, docName, segments: segs } = body;

  if (!namespace || !docId || !segs?.length) {
    return respond(400, { error: 'Required: namespace, docId, segments[]' });
  }

  // 1. Store segments
  const written = await segments.putSegments(
    namespace,
    docId,
    docName ?? docId,
    segs.map(s => ({ text: s.text, page: s.page ?? 1, docName: docName ?? docId })),
  );

  // 2. Rebuild BM25 index for this namespace
  const all = await segments.listByNamespace(namespace);
  const stats = await indexer.build(
    namespace,
    all.map(s => ({ id: s.id, text: s.text, docId: s.docId, docName: s.docName, page: s.page })),
  );

  return respond(200, {
    message: `Ingested ${written} segments, rebuilt index (${stats.segmentCount} total, ${stats.bytesKB}KB, ${stats.buildMs}ms)`,
  });
}

// --- Search ---

interface SearchBody {
  namespace: string;
  query: string;
  limit?: number;
}

async function handleSearch(body: SearchBody) {
  const { namespace, query, limit = 5 } = body;

  if (!namespace || !query) {
    return respond(400, { error: 'Required: namespace, query' });
  }

  const results = await hybrid.search(query, namespace, limit);

  return respond(200, {
    results: results.map(r => ({
      text: r.segment.text,
      docName: r.segment.docName,
      page: r.segment.page,
      score: r.score,
      strategies: r.strategies,
    })),
  });
}

// --- Utility ---

function respond(statusCode: number, body: object) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
