/**
 * BM25 Index Builder — builds and persists a full-text search index to DynamoDB.
 *
 * Uses wink-bm25-text-search to build an inverted index from document chunks,
 * then serializes it to a single DynamoDB item via exportJSON().
 *
 * The index is rebuilt after each document ingestion (full namespace rebuild).
 * This is fast at typical RAG scale:
 *   - 500 chunks: ~30ms to build, ~50KB serialized
 *   - 2000 chunks: ~100ms to build, ~200KB serialized
 *   - 4000 chunks: ~200ms to build, ~380KB serialized (approaching DynamoDB 400KB limit)
 */

import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
// @ts-ignore — wink-bm25-text-search doesn't ship TS types
import bm25 from 'wink-bm25-text-search';
// @ts-ignore — wink-nlp-utils doesn't ship TS types
import nlp from 'wink-nlp-utils';

import type { ChunkMeta } from './bm25.js';

/** Input chunk for index building. */
export interface IndexChunkInput {
  /** Unique chunk ID */
  id: string;
  /** Full text content to index */
  text: string;
  /** Source document identifier */
  documentId: string;
  /** Human-readable document name */
  documentName: string;
  /** Page/section number */
  pageNumber: number;
}

/** Options for the BM25 indexer. */
export interface BM25IndexerOptions {
  /** DynamoDB Document Client instance. */
  docClient: DynamoDBDocumentClient;
  /** DynamoDB table name. */
  tableName: string;
  /**
   * Partition key prefix for the index item.
   * @default 'BM25_INDEX#'
   */
  pkPrefix?: string;
  /**
   * Sort key for the index item.
   * @default 'INDEX'
   */
  sk?: string;
  /**
   * Number of characters to store as preview text per chunk.
   * Used at query time to show snippet without loading full chunk.
   * @default 200
   */
  previewLength?: number;
}

/** Result of a build operation. */
export interface BuildResult {
  chunkCount: number;
  sizeKB: number;
  buildTimeMs: number;
}

export class BM25Indexer {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly pkPrefix: string;
  private readonly sk: string;
  private readonly previewLength: number;

  constructor(options: BM25IndexerOptions) {
    this.docClient = options.docClient;
    this.tableName = options.tableName;
    this.pkPrefix = options.pkPrefix ?? 'BM25_INDEX#';
    this.sk = options.sk ?? 'INDEX';
    this.previewLength = options.previewLength ?? 200;
  }

  /**
   * Builds a BM25 index from all chunks and persists it to DynamoDB.
   * Overwrites any existing index for the namespace (idempotent).
   *
   * @param namespace - Logical grouping (e.g. workspace ID, tenant ID)
   * @param chunks - All chunks to index for this namespace
   * @returns Build statistics
   */
  async build(namespace: string, chunks: IndexChunkInput[]): Promise<BuildResult> {
    if (chunks.length === 0) {
      await this.delete(namespace);
      return { chunkCount: 0, sizeKB: 0, buildTimeMs: 0 };
    }

    const startTime = Date.now();

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

    for (let i = 0; i < chunks.length; i++) {
      engine.addDoc({ text: chunks[i].text }, i);
    }
    engine.consolidate();

    const indexJSON = engine.exportJSON();

    // Chunk metadata for result enrichment at query time
    const meta: ChunkMeta[] = chunks.map(c => ({
      id: c.id,
      document_id: c.documentId,
      document_name: c.documentName,
      page_number: c.pageNumber,
      preview: c.text.slice(0, this.previewLength),
    }));

    const buildTimeMs = Date.now() - startTime;
    const serialized = JSON.stringify({ index: indexJSON, meta });
    const sizeKB = Buffer.byteLength(serialized, 'utf8') / 1024;

    if (sizeKB > 380) {
      console.warn(
        `[BM25Indexer] Index for namespace "${namespace}" is ${sizeKB.toFixed(0)}KB — ` +
        `approaching DynamoDB 400KB item limit. Consider S3 storage for large namespaces.`,
      );
    }

    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        PK: `${this.pkPrefix}${namespace}`,
        SK: this.sk,
        entity_type: 'bm25_index',
        data: serialized,
        chunk_count: chunks.length,
        size_kb: Math.round(sizeKB),
        updated_at: new Date().toISOString(),
      },
    }));

    return { chunkCount: chunks.length, sizeKB: Math.round(sizeKB), buildTimeMs };
  }

  /**
   * Deletes the BM25 index for a namespace.
   * Called during namespace deletion.
   */
  async delete(namespace: string): Promise<void> {
    await this.docClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { PK: `${this.pkPrefix}${namespace}`, SK: this.sk },
    })).catch(() => {
      // Non-critical — index may not exist
    });
  }
}
