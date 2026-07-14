/**
 * Reciprocal Rank Fusion (RRF) — merges N ranked lists into one.
 *
 * Formula: score(d) = Σ 1 / (k + rank_i(d))
 *   where k is a constant (default 60) that prevents top-ranked entries from dominating,
 *   and rank_i(d) is the 1-based position of entry d in list i.
 *
 * If an entry appears in multiple lists, its scores are summed — this is the
 * "hybrid boost" that surfaces entries relevant to multiple retrieval strategies.
 *
 * Reference: Cormack, Clarke & Buettcher (2009) "Reciprocal Rank Fusion outperforms
 * Condorcet and individual Rank Learning Methods"
 *
 * Generic: works with any value type, any number of ranked lists.
 */

import type { RankedEntry } from './types.js';

/** Options for RRF fusion. */
export interface FuseOptions {
  /**
   * The k constant. Higher values flatten score differences between ranks.
   * Standard value: 60 (used by most IR research and popular search engines).
   * @default 60
   */
  k?: number;
  /**
   * Maximum number of results to return.
   * @default Infinity (return all)
   */
  limit?: number;
}

/** A fused result with its combined RRF score. */
export interface FusedEntry<T> {
  key: string;
  value: T;
  /** Combined RRF score (sum across all lists where this entry appeared). */
  score: number;
  /** How many of the input lists contained this entry. */
  hitCount: number;
}

/**
 * Fuses multiple ranked result lists using Reciprocal Rank Fusion.
 *
 * @param lists - Array of ranked lists. Each list is an array of RankedEntry in rank order (best first).
 * @param options - Fusion parameters.
 * @returns Fused results sorted by combined RRF score (descending).
 *
 * @example
 * ```ts
 * import { fuse } from 'dynamo-bm25-hybrid';
 *
 * const semantic = [{ key: 'doc-1', value: seg1 }, { key: 'doc-2', value: seg2 }];
 * const keyword  = [{ key: 'doc-2', value: seg2 }, { key: 'doc-3', value: seg3 }];
 *
 * const results = fuse([semantic, keyword], { limit: 5 });
 * // doc-2 ranks highest (appeared in both lists)
 * ```
 */
export function fuse<T>(lists: RankedEntry<T>[][], options: FuseOptions = {}): FusedEntry<T>[] {
  const { k = 60, limit = Infinity } = options;

  const tally = new Map<string, FusedEntry<T>>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const { key, value } = list[rank];
      const contribution = 1 / (k + rank + 1); // rank is 0-based, formula uses 1-based

      const existing = tally.get(key);
      if (existing) {
        existing.score += contribution;
        existing.hitCount += 1;
      } else {
        tally.set(key, { key, value, score: contribution, hitCount: 1 });
      }
    }
  }

  const ordered = Array.from(tally.values()).sort((a, b) => b.score - a.score);

  return limit === Infinity ? ordered : ordered.slice(0, limit);
}
