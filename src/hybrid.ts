/**
 * Hybrid Search — combines any semantic/vector search with DynamoDB BM25
 * using Reciprocal Rank Fusion.
 *
 * This is the high-level convenience class. For full control, use `fuse()` directly.
 */

import type { ScoredSegment, Segment, RankedEntry } from './types.js';
import type { LexicalSearcher } from './bm25.js';
import { fuse, type FusedEntry } from './rrf.js';

/**
 * Any function that performs semantic/vector search and returns scored segments.
 * This keeps the library decoupled from any specific vector DB or embedding provider.
 */
export type VectorSearchFn = (query: string, namespace: string, limit: number) => Promise<ScoredSegment[]>;

/** Options for hybrid search. */
export interface HybridSearchOptions {
  /** The lexical (BM25) searcher instance (DynamoDB-backed). */
  lexical: LexicalSearcher;
  /** Your vector search function (wraps any vector DB). */
  vectorSearch: VectorSearchFn;
  /**
   * RRF k constant.
   * @default 60
   */
  k?: number;
}

/** A hybrid search result with fusion metadata. */
export interface HybridHit {
  segment: Segment;
  /** Combined RRF score. */
  score: number;
  /** How many retrieval strategies found this segment (1 = single source, 2 = both). */
  strategies: number;
}

export class HybridSearch {
  private readonly lexical: LexicalSearcher;
  private readonly vectorSearch: VectorSearchFn;
  private readonly k: number;

  constructor(options: HybridSearchOptions) {
    this.lexical = options.lexical;
    this.vectorSearch = options.vectorSearch;
    this.k = options.k ?? 60;
  }

  /**
   * Performs hybrid retrieval: runs vector + BM25 in parallel, fuses with RRF.
   *
   * @param query - User's search query
   * @param namespace - Namespace to search (e.g. tenant ID)
   * @param limit - Number of final results after fusion
   */
  async search(query: string, namespace: string, limit = 8): Promise<HybridHit[]> {
    // Run both in parallel — total latency = max(vector, lexical), not sum
    const [vectorHits, lexicalHits] = await Promise.all([
      this.vectorSearch(query, namespace, limit * 2),
      this.lexical.search(namespace, query, limit * 2),
    ]);

    // If one strategy returns nothing, return the other directly
    if (lexicalHits.length === 0 && vectorHits.length === 0) return [];
    if (lexicalHits.length === 0) return this.wrap(vectorHits.slice(0, limit), 1);
    if (vectorHits.length === 0) return this.wrap(lexicalHits.slice(0, limit), 1);

    // Build ranked lists with dedup keys
    const vectorList: RankedEntry<Segment>[] = vectorHits.map(h => ({
      key: this.dedupKey(h.segment),
      value: h.segment,
    }));

    const lexicalList: RankedEntry<Segment>[] = lexicalHits.map(h => ({
      key: this.dedupKey(h.segment),
      value: h.segment,
    }));

    // Fuse with RRF
    const fused: FusedEntry<Segment>[] = fuse([vectorList, lexicalList], {
      k: this.k,
      limit,
    });

    return fused.map(f => ({
      segment: f.value,
      score: f.score,
      strategies: f.hitCount,
    }));
  }

  private dedupKey(segment: Segment): string {
    // Dedup by document + page + first 100 chars of text
    return `${segment.docName}::${segment.page}::${segment.text.slice(0, 100)}`;
  }

  private wrap(hits: ScoredSegment[], strategies: number): HybridHit[] {
    return hits.map(h => ({ segment: h.segment, score: h.score, strategies }));
  }
}
