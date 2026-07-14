/**
 * BM25 Search — query-time keyword search using a pre-built index stored in DynamoDB.
 *
 * Architecture:
 *   - At ingestion time, LexicalIndexer builds a wink-bm25-text-search index and
 *     serializes it to a single DynamoDB item (JSON blob).
 *   - At query time, LexicalSearcher loads the serialized index, imports it into
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
 *   - DynamoDB item size limit is 400KB — supports ~3000-4000 segments per namespace
 *   - For larger corpora, store the index in S3 instead (see README)
 */

import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
// @ts-ignore — wink-bm25-text-search doesn't ship TS types
import bm25 from 'wink-bm25-text-search';
// @ts-ignore — wink-nlp-utils doesn't ship TS types
import nlp from 'wink-nlp-utils';

import type { ScoredSegment, Segment } from './types.js';

/** Options for the lexical searcher. */
export interface LexicalSearcherOptions {
  /** DynamoDB Document Client instance. */
  docClient: DynamoDBDocumentClient;
  /** DynamoDB table name. */
  tableName: string;
  /**
   * Partition key prefix for the index item.
   * Full PK will be: `${keyPrefix}${namespace}`
   * @default 'LEXIDX#'
   */
  keyPrefix?: string;
  /**
   * Sort key for the index item.
   * @default 'BLOB'
   */
  sortKey?: string;
}

/** Metadata stored alongside each segment in the serialized index. */
export interface SegmentMeta {
  id: string;
  docId: string;
  docName: string;
  page: number;
  preview: string;
}

export class LexicalSearcher {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly keyPrefix: string;
  private readonly sortKey: string;

  constructor(options: LexicalSearcherOptions) {
    this.docClient = options.docClient;
    this.tableName = options.tableName;
    this.keyPrefix = options.keyPrefix ?? 'LEXIDX#';
    this.sortKey = options.sortKey ?? 'BLOB';
  }

  /**
   * Searches a namespace's pre-built BM25 index.
   *
   * @param namespace - Logical grouping (e.g. tenant ID, project ID)
   * @param query - User's search query
   * @param limit - Number of top results (default: 8)
   * @returns Ranked results with metadata, or empty array if no index exists
   */
  async search(namespace: string, query: string, limit = 8): Promise<ScoredSegment[]> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK: `${this.keyPrefix}${namespace}`, SK: this.sortKey },
      ProjectionExpression: '#p',
      ExpressionAttributeNames: { '#p': 'payload' },
    }));

    if (!result.Item?.payload) {
      return [];
    }

    const { index: indexJSON, meta } = JSON.parse(result.Item.payload as string) as {
      index: string;
      meta: SegmentMeta[];
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

    const hits = engine.search(query, limit) as Array<[number, number]>;

    return hits.map(([idx, score]) => {
      const m = meta[idx] ?? ({} as SegmentMeta);
      const segment: Segment = {
        id: m.id ?? `seg-${idx}`,
        text: m.preview ?? '',
        docId: m.docId ?? '',
        docName: m.docName ?? '',
        page: m.page ?? 1,
      };
      return { segment, score };
    });
  }
}
