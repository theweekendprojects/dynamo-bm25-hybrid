// Core types
export type { Segment, ScoredSegment, RankedEntry } from './types.js';

// RRF — generic fusion, usable standalone without DynamoDB
export { fuse, type FuseOptions, type FusedEntry } from './rrf.js';

// Lexical (BM25) search — query-time
export { LexicalSearcher, type LexicalSearcherOptions, type SegmentMeta } from './bm25.js';

// Lexical index builder — ingestion-time
export { LexicalIndexer, type LexicalIndexerOptions, type IndexInput, type BuildStats } from './indexer.js';

// Segment store — DynamoDB storage
export { SegmentStore, type SegmentStoreOptions, type SegmentInput } from './segment-store.js';

// Hybrid search — convenience: vector + BM25 + RRF
export { HybridSearch, type HybridSearchOptions, type HybridHit, type VectorSearchFn } from './hybrid.js';
