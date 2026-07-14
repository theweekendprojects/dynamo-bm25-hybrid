// Core types
export type { Chunk, ScoredChunk, RankedItem } from './types.js';

// RRF — generic fusion, usable standalone without DynamoDB
export { fuse, type RRFOptions, type FusedResult } from './rrf.js';

// BM25 search (query-time)
export { BM25Searcher, type BM25SearcherOptions, type ChunkMeta } from './bm25.js';

// BM25 indexer (ingestion-time)
export { BM25Indexer, type BM25IndexerOptions, type IndexChunkInput, type BuildResult } from './indexer.js';

// Chunk store (DynamoDB storage)
export { ChunkStore, type ChunkStoreOptions, type ChunkInput } from './chunk-store.js';

// Hybrid search (convenience: semantic + BM25 + RRF)
export { HybridSearch, type HybridSearchOptions, type HybridResult, type SemanticSearchFn } from './hybrid.js';
