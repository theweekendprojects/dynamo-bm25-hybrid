import { describe, it, expect } from 'vitest';
import { fuse } from './rrf.js';
import type { RankedItem } from './types.js';

describe('fuse (Reciprocal Rank Fusion)', () => {
  it('returns empty for empty input', () => {
    expect(fuse([])).toEqual([]);
    expect(fuse([[]])).toEqual([]);
  });

  it('returns single list unchanged (with RRF scores)', () => {
    const list: RankedItem<string>[] = [
      { key: 'a', item: 'doc-a' },
      { key: 'b', item: 'doc-b' },
    ];
    const results = fuse([list]);
    expect(results).toHaveLength(2);
    expect(results[0].key).toBe('a');
    expect(results[1].key).toBe('b');
    // RRF score: 1/(60+1) > 1/(60+2)
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].listCount).toBe(1);
  });

  it('boosts items appearing in multiple lists', () => {
    const list1: RankedItem<string>[] = [
      { key: 'a', item: 'doc-a' },
      { key: 'b', item: 'doc-b' },
      { key: 'c', item: 'doc-c' },
    ];
    const list2: RankedItem<string>[] = [
      { key: 'c', item: 'doc-c' },
      { key: 'b', item: 'doc-b' },
      { key: 'd', item: 'doc-d' },
    ];

    const results = fuse([list1, list2]);

    // 'b' appears in both lists (rank 1 in list1, rank 1 in list2)
    // 'c' appears in both lists (rank 2 in list1, rank 0 in list2)
    // Items in both should have listCount=2
    const b = results.find(r => r.key === 'b')!;
    const c = results.find(r => r.key === 'c')!;
    const a = results.find(r => r.key === 'a')!;
    const d = results.find(r => r.key === 'd')!;

    expect(b.listCount).toBe(2);
    expect(c.listCount).toBe(2);
    expect(a.listCount).toBe(1);
    expect(d.listCount).toBe(1);

    // Both b and c should score higher than single-source items
    expect(b.score).toBeGreaterThan(a.score);
    expect(c.score).toBeGreaterThan(a.score);
    expect(c.score).toBeGreaterThan(d.score);
  });

  it('respects topK limit', () => {
    const list: RankedItem<string>[] = Array.from({ length: 20 }, (_, i) => ({
      key: `doc-${i}`,
      item: `content-${i}`,
    }));

    const results = fuse([list], { topK: 5 });
    expect(results).toHaveLength(5);
    expect(results[0].key).toBe('doc-0');
  });

  it('uses custom k constant', () => {
    const list1: RankedItem<string>[] = [{ key: 'a', item: 'a' }];
    const list2: RankedItem<string>[] = [{ key: 'a', item: 'a' }];

    // k=1: score = 1/(1+1) + 1/(1+1) = 1
    const results = fuse([list1, list2], { k: 1 });
    expect(results[0].score).toBeCloseTo(1.0);

    // k=60: score = 1/(60+1) + 1/(60+1) ≈ 0.0328
    const results60 = fuse([list1, list2], { k: 60 });
    expect(results60[0].score).toBeCloseTo(2 / 61);
  });

  it('fuses 3+ lists', () => {
    const list1: RankedItem<string>[] = [{ key: 'a', item: 'a' }, { key: 'b', item: 'b' }];
    const list2: RankedItem<string>[] = [{ key: 'b', item: 'b' }, { key: 'c', item: 'c' }];
    const list3: RankedItem<string>[] = [{ key: 'b', item: 'b' }, { key: 'a', item: 'a' }];

    const results = fuse([list1, list2, list3]);
    // 'b' appears in all 3 lists — should be #1
    expect(results[0].key).toBe('b');
    expect(results[0].listCount).toBe(3);
  });
});
