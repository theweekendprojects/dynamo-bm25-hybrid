/**
 * Core types for the hybrid search library.
 */

/** A text segment (a piece of a document) with its metadata. */
export interface Segment {
  /** Unique segment identifier */
  id: string;
  /** Full text content */
  text: string;
  /** Source document identifier */
  docId: string;
  /** Human-readable document name */
  docName: string;
  /** Page/section number in the source document */
  page: number;
}

/** A search hit — a segment paired with its relevance score. */
export interface ScoredSegment {
  segment: Segment;
  /** Relevance score (higher = more relevant). Meaning depends on the source. */
  score: number;
}

/** A ranked entry from any retrieval source — only needs a key and rank position. */
export interface RankedEntry<T = unknown> {
  /** Unique key to identify this entry across lists (for deduplication/fusion) */
  key: string;
  /** The actual payload */
  value: T;
}
