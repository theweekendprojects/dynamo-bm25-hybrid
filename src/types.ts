/**
 * Core types for the hybrid search library.
 */

/** A document chunk with text and metadata. */
export interface Chunk {
  /** Unique chunk identifier */
  id: string;
  /** Full text content */
  text: string;
  /** Source document identifier */
  documentId: string;
  /** Human-readable document name */
  documentName: string;
  /** Page/section number in the source document */
  pageNumber: number;
}

/** A search result with its relevance score. */
export interface ScoredChunk {
  chunk: Chunk;
  /** Relevance score (higher = more relevant). Meaning depends on the source. */
  score: number;
}

/** A ranked result from any retrieval source — only needs an ID and rank position. */
export interface RankedItem<T = unknown> {
  /** Unique key to identify this item across lists (for deduplication/fusion) */
  key: string;
  /** The actual payload */
  item: T;
}
