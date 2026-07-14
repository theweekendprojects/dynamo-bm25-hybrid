/**
 * Segment Store — DynamoDB storage for parsed document segments.
 *
 * Single-table design:
 *   PK: SEG#{namespace}
 *   SK: D#{docId}#S#{sequenceNumber:04d}
 *
 * Enables:
 *   - Per-document segment retrieval (for downstream processing)
 *   - Full namespace segment retrieval (for BM25 index rebuild)
 *   - Clean deletion by document or namespace
 *
 * Cost: pure on-demand DynamoDB — zero at rest, pennies per 1000 writes.
 */

import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

import type { Segment } from './types.js';

/** Options for the SegmentStore. */
export interface SegmentStoreOptions {
  /** DynamoDB Document Client instance. */
  docClient: DynamoDBDocumentClient;
  /** DynamoDB table name. */
  tableName: string;
  /**
   * Partition key prefix.
   * @default 'SEG#'
   */
  keyPrefix?: string;
}

/** Input for writing a segment (text + page; the ID is derived from sequence). */
export interface SegmentInput {
  text: string;
  page: number;
  docName: string;
}

export class SegmentStore {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly keyPrefix: string;

  constructor(options: SegmentStoreOptions) {
    this.docClient = options.docClient;
    this.tableName = options.tableName;
    this.keyPrefix = options.keyPrefix ?? 'SEG#';
  }

  /**
   * Writes all segments for a document. Idempotent (overwrites existing).
   * @returns Number of segments written.
   */
  async putSegments(
    namespace: string,
    docId: string,
    docName: string,
    segments: SegmentInput[],
  ): Promise<number> {
    if (segments.length === 0) return 0;

    const now = new Date().toISOString();
    const items = segments.map((seg, idx) => ({
      PK: `${this.keyPrefix}${namespace}`,
      SK: `D#${docId}#S#${String(idx).padStart(4, '0')}`,
      kind: 'segment',
      namespace,
      doc_id: docId,
      doc_name: docName,
      text: seg.text,
      page: seg.page,
      seg_seq: idx,
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
   * Reads all segments for a specific document.
   */
  async listByDocument(namespace: string, docId: string): Promise<Segment[]> {
    return this.query(
      `${this.keyPrefix}${namespace}`,
      `D#${docId}#S#`,
    );
  }

  /**
   * Reads all segments for an entire namespace.
   * Used for BM25 index rebuild.
   */
  async listByNamespace(namespace: string): Promise<Segment[]> {
    return this.query(`${this.keyPrefix}${namespace}`);
  }

  /**
   * Deletes all segments for a document.
   * @returns Number of segments deleted.
   */
  async deleteByDocument(namespace: string, docId: string): Promise<number> {
    return this.purge(`${this.keyPrefix}${namespace}`, `D#${docId}#S#`);
  }

  /**
   * Deletes all segments for a namespace.
   * @returns Number of segments deleted.
   */
  async deleteByNamespace(namespace: string): Promise<number> {
    return this.purge(`${this.keyPrefix}${namespace}`);
  }

  // ===== Private =====

  private async query(pk: string, skPrefix?: string): Promise<Segment[]> {
    const out: Segment[] = [];
    let lastKey: Record<string, any> | undefined;

    do {
      const result = await this.docClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: skPrefix
          ? 'PK = :pk AND begins_with(SK, :sk)'
          : 'PK = :pk',
        ExpressionAttributeValues: skPrefix
          ? { ':pk': pk, ':sk': skPrefix }
          : { ':pk': pk },
        ExclusiveStartKey: lastKey,
      }));

      for (const item of result.Items ?? []) {
        out.push({
          id: item.SK as string,
          text: item.text as string,
          page: item.page as number,
          docId: item.doc_id as string,
          docName: item.doc_name as string,
        });
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return out;
  }

  private async purge(pk: string, skPrefix?: string): Promise<number> {
    let deleted = 0;
    let lastKey: Record<string, any> | undefined;

    do {
      const result = await this.docClient.send(new QueryCommand({
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
      }));

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
