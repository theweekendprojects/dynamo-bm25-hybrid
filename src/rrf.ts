/**
 * Reciprocal Rank Fusion (RRF) — merges N ranked lists into one.
 *
 * Formula: score(d) = Σ 1 / (k + rank_i(d))
 *   where k is a constant (default 60) that prevents top-ranked items from dominating,
 *   and rank_i(d) is the 1-based position of document d in list i.
 *
 * If a document appears in multiple lists, its scores are summed — this is the
 * "hybrid boost" that surfaces documents relevant to multiple retrieval strategies.
 *
 * Reference: Cormack, Clarke & Buettcher (2009) "Reciprocal Rank Fusion outperforms
 * Condorcet and individual Rank Learning Methods"
 *
 * Generic: works with any item type, any number of ranked lists.
 */

import type { RankedItem } from './types.js';

/** Options for RRF fusion. */
export interface RRFOptions {
  /**
   * The k constant. Higher values flatten score differences between ranks.
   * Standard value: 60 (used by most IR research and Elasticsearch/OpenSearch).
   * @default 60
   */
  k?: number;
  /**
   * Maximum number of results to return.
   * @default Infinity (return all)
   */
  topK?: number;
}

/** A fused result with its combined RRF score. */
export interface FusedResult<T> {
  key: string;
  item: T;
  /** Combined RRF score (sum across all lists where this item appeared). */
  score: number;
  /** How many of the input lists contained this item. */
  listCount: number;
}

/**
 * Fuses multiple ranked result lists using Reciprocal Rank Fusion.
 *
 * @param lists - Array of ranked lists. Each list is an array of RankedItem in rank order (best first).
 * @param options - RRF parameters.
 * @returns Fused results sorted by combined RRF score (descending).
 *
 * @example
 * ```ts
 * import { fuse } from 'dynamo-bm25-hybrid';
 *
 * const semantic = [{ key: 'doc-1', item: chunk1 }, { key: 'doc-2', item: chunk2 }];
 * const keyword  = [{ key: 'doc-2', item: chunk2 }, { key: 'doc-3', item: chunk3 }];
 *
 * const results = fuse([semantic, keyword], { topK: 5 });
 * // doc-2 ranks highest (appeared in both lists)
 * ```
 */
export function fuse<T>(lists: RankedItem<T>[][], options: RRFOptions = {}): FusedResult<T>[] {
  const { k = 60, topK = Infinity } = options;

  const scoreMap = new Map<string, FusedResult<T>>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const { key, item } = list[rank];
      const rrfScore = 1 / (k + rank + 1); // rank is 0-based, formula uses 1-based

      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
        existing.listCount += 1;
      } else {
        scoreMap.set(key, { key, item, score: rrfScore, listCount: 1 });
      }
    }
  }

  const sorted = Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);

  return topK === Infinity ? sorted : sorted.slice(0, topK);
}
