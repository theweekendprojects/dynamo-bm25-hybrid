/**
 * Chunk Store — DynamoDB storage for parsed document chunks.
 *
 * Single-table design:
 *   PK: CHUNKS#{namespace}
 *   SK: DOC#{documentId}#C#{sequenceNumber:04d}
 *
 * Enables:
 *   - Per-document chunk retrieval (for downstream processing)
 *   - Full namespace chunk retrieval (for BM25 index rebuild)
 *   - Clean deletion by document or namespace
 *
 * Cost: pure on-demand DynamoDB — zero at rest, pennies per 1000 writes.
 */

import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

import type { Chunk } from './types.js';

/** Options for the ChunkStore. */
export interface ChunkStoreOptions {
  /** DynamoDB Document Client instance. */
  docClient: DynamoDBDocumentClient;
  /** DynamoDB table name. */
  tableName: string;
  /**
   * Partition key prefix.
   * @default 'CHUNKS#'
   */
  pkPrefix?: string;
}

/** Input for writing a chunk (text + page, no ID needed — generated from sequence). */
export interface ChunkInput {
  text: string;
  pageNumber: number;
  documentName: string;
}

export class ChunkStore {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly pkPrefix: string;

  constructor(options: ChunkStoreOptions) {
    this.docClient = options.docClient;
    this.tableName = options.tableName;
    this.pkPrefix = options.pkPrefix ?? 'CHUNKS#';
  }

  /**
   * Writes all chunks for a document. Idempotent (overwrites existing).
   * @returns Number of chunks written.
   */
  async writeChunks(
    namespace: string,
    documentId: string,
    documentName: string,
    chunks: ChunkInput[],
  ): Promise<number> {
    if (chunks.length === 0) return 0;

    const now = new Date().toISOString();
    const items = chunks.map((chunk, idx) => ({
      PK: `${this.pkPrefix}${namespace}`,
      SK: `DOC#${documentId}#C#${String(idx).padStart(4, '0')}`,
      entity_type: 'chunk',
      namespace,
      document_id: documentId,
      document_name: documentName,
      text: chunk.text,
      page_number: chunk.pageNumber,
      chunk_sequence: idx,
      created_at: now,
    }));

    let written = 0;
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      await this.docClient.send(new BatchWriteCommand({
        RequestItems: {
          [this.tableName]: batch.map(item => ({ PutRequest: { Item: item } })),
        },
      }));
      written += batch.length;
    }

    return written;
  }

  /**
   * Reads all chunks for a specific document.
   */
  async getChunksForDocument(namespace: string, documentId: string): Promise<Chunk[]> {
    const items: Chunk[] = [];
    let lastKey: Record<string, any> | undefined;

    do {
      const result = await this.docClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `${this.pkPrefix}${namespace}`,
          ':sk': `DOC#${documentId}#C#`,
        },
        ExclusiveStartKey: lastKey,
      }));

      for (const item of result.Items ?? []) {
        items.push({
          id: item.SK as string,
          text: item.text as string,
          pageNumber: item.page_number as number,
          documentId: item.document_id as string,
          documentName: item.document_name as string,
        });
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return items;
  }

  /**
   * Reads all chunks for an entire namespace.
   * Used for BM25 index rebuild.
   */
  async getChunksForNamespace(namespace: string): Promise<Chunk[]> {
    const items: Chunk[] = [];
    let lastKey: Record<string, any> | undefined;

    do {
      const result = await this.docClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `${this.pkPrefix}${namespace}`,
        },
        ExclusiveStartKey: lastKey,
      }));

      for (const item of result.Items ?? []) {
        items.push({
          id: item.SK as string,
          text: item.text as string,
          pageNumber: item.page_number as number,
          documentId: item.document_id as string,
          documentName: item.document_name as string,
        });
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return items;
  }

  /**
   * Deletes all chunks for a document.
   * @returns Number of chunks deleted.
   */
  async deleteChunksForDocument(namespace: string, documentId: string): Promise<number> {
    return this.deleteByQuery(
      `${this.pkPrefix}${namespace}`,
      `DOC#${documentId}#C#`,
    );
  }

  /**
   * Deletes all chunks for a namespace.
   * @returns Number of chunks deleted.
   */
  async deleteChunksForNamespace(namespace: string): Promise<number> {
    return this.deleteByQuery(`${this.pkPrefix}${namespace}`);
  }

  private async deleteByQuery(pk: string, skPrefix?: string): Promise<number> {
    let deleted = 0;
    let lastKey: Record<string, any> | undefined;

    do {
      const params: any = {
        TableName: this.tableName,
        KeyConditionExpression: skPrefix
          ? 'PK = :pk AND begins_with(SK, :sk)'
          : 'PK = :pk',
        ExpressionAttributeValues: skPrefix
          ? { ':pk': pk, ':sk': skPrefix }
          : { ':pk': pk },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: lastKey,
        Limit: 250,
      };

      const result = await this.docClient.send(new QueryCommand(params));
      const items = result.Items ?? [];
      lastKey = result.LastEvaluatedKey;

      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        await this.docClient.send(new BatchWriteCommand({
          RequestItems: {
            [this.tableName]: batch.map(item => ({
              DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
            })),
          },
        }));
        deleted += batch.length;
      }
    } while (lastKey);

    return deleted;
  }
}
