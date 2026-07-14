/**
 * Lexical Index Builder — builds and persists a full-text BM25 index to DynamoDB.
 *
 * Uses wink-bm25-text-search to build an inverted index from document segments,
 * then serializes it to a single DynamoDB item via exportJSON().
 *
 * The index is rebuilt after each document ingestion (full namespace rebuild).
 * This is fast at typical RAG scale:
 *   - 500 segments: ~30ms to build, ~50KB serialized
 *   - 2000 segments: ~100ms to build, ~200KB serialized
 *   - 4000 segments: ~200ms to build, ~380KB serialized (approaching DynamoDB 400KB limit)
 */

import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
// @ts-ignore — wink-bm25-text-search doesn't ship TS types
import bm25 from 'wink-bm25-text-search';
// @ts-ignore — wink-nlp-utils doesn't ship TS types
import nlp from 'wink-nlp-utils';

import type { SegmentMeta } from './bm25.js';

/** Input segment for index building. */
export interface IndexInput {
  /** Unique segment ID */
  id: string;
  /** Full text content to index */
  text: string;
  /** Source document identifier */
  docId: string;
  /** Human-readable document name */
  docName: string;
  /** Page/section number */
  page: number;
}

/** Options for the lexical indexer. */
export interface LexicalIndexerOptions {
  /** DynamoDB Document Client instance. */
  docClient: DynamoDBDocumentClient;
  /** DynamoDB table name. */
  tableName: string;
  /**
   * Partition key prefix for the index item.
   * @default 'LEXIDX#'
   */
  keyPrefix?: string;
  /**
   * Sort key for the index item.
   * @default 'BLOB'
   */
  sortKey?: string;
  /**
   * Number of characters to store as preview text per segment.
   * Used at query time to show a snippet without loading the full segment.
   * @default 200
   */
  previewLength?: number;
}

/** Result of a build operation. */
export interface BuildStats {
  segmentCount: number;
  bytesKB: number;
  buildMs: number;
}

export class LexicalIndexer {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly keyPrefix: string;
  private readonly sortKey: string;
  private readonly previewLength: number;

  constructor(options: LexicalIndexerOptions) {
    this.docClient = options.docClient;
    this.tableName = options.tableName;
    this.keyPrefix = options.keyPrefix ?? 'LEXIDX#';
    this.sortKey = options.sortKey ?? 'BLOB';
    this.previewLength = options.previewLength ?? 200;
  }

  /**
   * Builds a BM25 index from all segments and persists it to DynamoDB.
   * Overwrites any existing index for the namespace (idempotent).
   *
   * @param namespace - Logical grouping (e.g. tenant ID, project ID)
   * @param segments - All segments to index for this namespace
   * @returns Build statistics
   */
  async build(namespace: string, segments: IndexInput[]): Promise<BuildStats> {
    if (segments.length === 0) {
      await this.drop(namespace);
      return { segmentCount: 0, bytesKB: 0, buildMs: 0 };
    }

    const started = Date.now();

    // Build wink BM25 engine
    const engine = bm25();
    engine.defineConfig({ fldWeights: { text: 1 } });
    engine.definePrepTasks([
      nlp.string.lowerCase,
      nlp.string.tokenize0,
      nlp.tokens.removeWords,
      nlp.tokens.stem,
      nlp.tokens.propagateNegations,
    ]);

    for (let i = 0; i < segments.length; i++) {
      engine.addDoc({ text: segments[i].text }, i);
    }
    engine.consolidate();

    const indexJSON = engine.exportJSON();

    // Segment metadata for result enrichment at query time
    const meta: SegmentMeta[] = segments.map(s => ({
      id: s.id,
      docId: s.docId,
      docName: s.docName,
      page: s.page,
      preview: s.text.slice(0, this.previewLength),
    }));

    const buildMs = Date.now() - started;
    const serialized = JSON.stringify({ index: indexJSON, meta });
    const bytesKB = Buffer.byteLength(serialized, 'utf8') / 1024;

    if (bytesKB > 380) {
      console.warn(
        `[LexicalIndexer] Index for namespace "${namespace}" is ${bytesKB.toFixed(0)}KB — ` +
        `approaching DynamoDB 400KB item limit. Consider S3 storage for large namespaces.`,
      );
    }

    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        PK: `${this.keyPrefix}${namespace}`,
        SK: this.sortKey,
        kind: 'lexical_index',
        payload: serialized,
        segment_count: segments.length,
        bytes_kb: Math.round(bytesKB),
        updated_at: new Date().toISOString(),
      },
    }));

    return { segmentCount: segments.length, bytesKB: Math.round(bytesKB), buildMs };
  }

  /**
   * Deletes the BM25 index for a namespace.
   * Called during namespace teardown.
   */
  async drop(namespace: string): Promise<void> {
    await this.docClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { PK: `${this.keyPrefix}${namespace}`, SK: this.sortKey },
    })).catch(() => {
      // Non-critical — index may not exist
    });
  }
}
