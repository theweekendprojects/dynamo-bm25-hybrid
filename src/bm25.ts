/**
 * BM25 Search — query-time keyword search using a pre-built index stored in DynamoDB.
 *
 * Architecture:
 *   - At ingestion time, BM25Indexer builds a wink-bm25-text-search index and
 *     serializes it to a single DynamoDB item (JSON blob).
 *   - At query time, BM25Searcher loads the serialized index, imports it into
 *     a fresh wink engine, and runs the search.
 *
 * Performance:
 *   - DynamoDB GetItem: ~5-10ms (single item read, on-demand)
 *   - Index import: ~5ms (JSON parse + wink importJSON)
 *   - Search: ~1ms
 *   - Total: ~10-15ms per query
 *
 * Cost:
 *   - Storage: ~50-200KB per namespace (fits in one DynamoDB item up to 400KB)
 *   - Reads: 1 RCU per query (or 0.5 with eventual consistency)
 *   - Zero cost at rest — no servers, no clusters
 *
 * Limitations:
 *   - DynamoDB item size limit is 400KB — supports ~3000-4000 chunks per namespace
 *   - For larger corpora, store the index in S3 instead (see README)
 */

import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
// @ts-ignore — wink-bm25-text-search doesn't ship TS types
import bm25 from 'wink-bm25-text-search';
// @ts-ignore — wink-nlp-utils doesn't ship TS types
import nlp from 'wink-nlp-utils';

import type { ScoredChunk, Chunk } from './types.js';

/** Options for the BM25 searcher. */
export interface BM25SearcherOptions {
  /** DynamoDB Document Client instance. */
  docClient: DynamoDBDocumentClient;
  /** DynamoDB table name. */
  tableName: string;
  /**
   * Partition key prefix for the index item.
   * Full PK will be: `${pkPrefix}${namespace}`
   * @default 'BM25_INDEX#'
   */
  pkPrefix?: string;
  /**
   * Sort key for the index item.
   * @default 'INDEX'
   */
  sk?: string;
}

/** Metadata stored alongside each chunk in the serialized index. */
export interface ChunkMeta {
  id: string;
  document_id: string;
  document_name: string;
  page_number: number;
  preview: string;
}

export class BM25Searcher {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly pkPrefix: string;
  private readonly sk: string;

  constructor(options: BM25SearcherOptions) {
    this.docClient = options.docClient;
    this.tableName = options.tableName;
    this.pkPrefix = options.pkPrefix ?? 'BM25_INDEX#';
    this.sk = options.sk ?? 'INDEX';
  }

  /**
   * Searches a namespace's pre-built BM25 index.
   *
   * @param namespace - Logical grouping (e.g. tenant ID, project ID)
   * @param query - User's search query
   * @param topK - Number of top results (default: 8)
   * @returns Ranked results with metadata, or empty array if no index exists
   */
  async search(namespace: string, query: string, topK = 8): Promise<ScoredChunk[]> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: `${this.pkPrefix}${namespace}`, SK: this.sk },
      ProjectionExpression: '#d',
      ExpressionAttributeNames: { '#d': 'data' },
    }));

    if (!result.Item?.data) {
      return [];
    }

    const { index: indexJSON, meta: chunkMeta } = JSON.parse(result.Item.data as string) as {
      index: string;
      meta: ChunkMeta[];
    };

    const engine = bm25();
    engine.defineConfig({ fldWeights: { text: 1 } });
    engine.definePrepTasks([
      nlp.string.lowerCase,
      nlp.string.tokenize0,
      nlp.tokens.removeWords,
      nlp.tokens.stem,
      nlp.tokens.propagateNegations,
    ]);
    engine.importJSON(indexJSON);

    const searchResults = engine.search(query, topK) as Array<[number, number]>;

    return searchResults.map(([chunkIdx, score]) => {
      const meta = chunkMeta[chunkIdx] ?? {};
      const chunk: Chunk = {
        id: meta.id ?? `chunk-${chunkIdx}`,
        text: meta.preview ?? '',
        documentId: meta.document_id ?? '',
        documentName: meta.document_name ?? '',
        pageNumber: meta.page_number ?? 1,
      };
      return { chunk, score };
    });
  }
}
