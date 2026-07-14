/**
 * Hybrid Search — combines any semantic/vector search with DynamoDB BM25
 * using Reciprocal Rank Fusion.
 *
 * This is the high-level convenience class. For full control, use `fuse()` directly.
 */

import type { ScoredChunk, Chunk, RankedItem } from './types.js';
import type { BM25Searcher } from './bm25.js';
import { fuse, type FusedResult } from './rrf.js';

/**
 * Any function that performs semantic/vector search and returns scored chunks.
 * This keeps the library decoupled from any specific vector DB or embedding provider.
 */
export type SemanticSearchFn = (query: string, namespace: string, topK: number) => Promise<ScoredChunk[]>;

/** Options for hybrid search. */
export interface HybridSearchOptions {
  /** The BM25 searcher instance (DynamoDB-backed). */
  bm25: BM25Searcher;
  /** Your semantic search function (wraps any vector DB). */
  semanticSearch: SemanticSearchFn;
  /**
   * RRF k constant.
   * @default 60
   */
  k?: number;
}

/** A hybrid search result with fusion metadata. */
export interface HybridResult {
  chunk: Chunk;
  /** Combined RRF score. */
  score: number;
  /** How many retrieval paths found this chunk (1 = single source, 2 = both). */
  sources: number;
}

export class HybridSearch {
  private readonly bm25: BM25Searcher;
  private readonly semanticSearch: SemanticSearchFn;
  private readonly k: number;

  constructor(options: HybridSearchOptions) {
    this.bm25 = options.bm25;
    this.semanticSearch = options.semanticSearch;
    this.k = options.k ?? 60;
  }

  /**
   * Performs hybrid retrieval: runs semantic + BM25 in parallel, fuses with RRF.
   *
   * @param query - User's search query
   * @param namespace - Namespace to search (e.g. tenant ID)
   * @param topK - Number of final results after fusion
   */
  async search(query: string, namespace: string, topK = 8): Promise<HybridResult[]> {
    // Run both in parallel — total latency = max(semantic, bm25), not sum
    const [semanticResults, bm25Results] = await Promise.all([
      this.semanticSearch(query, namespace, topK * 2),
      this.bm25.search(namespace, query, topK * 2),
    ]);

    // If one path returns nothing, return the other directly
    if (bm25Results.length === 0 && semanticResults.length === 0) return [];
    if (bm25Results.length === 0) return this.toHybridResults(semanticResults.slice(0, topK), 1);
    if (semanticResults.length === 0) return this.toHybridResults(bm25Results.slice(0, topK), 1);

    // Build ranked lists with dedup keys
    const semanticList: RankedItem<Chunk>[] = semanticResults.map(r => ({
      key: this.chunkKey(r.chunk),
      item: r.chunk,
    }));

    const bm25List: RankedItem<Chunk>[] = bm25Results.map(r => ({
      key: this.chunkKey(r.chunk),
      item: r.chunk,
    }));

    // Fuse with RRF
    const fused: FusedResult<Chunk>[] = fuse([semanticList, bm25List], {
      k: this.k,
      topK,
    });

    return fused.map(f => ({
      chunk: f.item,
      score: f.score,
      sources: f.listCount,
    }));
  }

  private chunkKey(chunk: Chunk): string {
    // Dedup by document + page + first 100 chars of text
    return `${chunk.documentName}::${chunk.pageNumber}::${chunk.text.slice(0, 100)}`;
  }

  private toHybridResults(results: ScoredChunk[], sources: number): HybridResult[] {
    return results.map(r => ({ chunk: r.chunk, score: r.score, sources }));
  }
}
