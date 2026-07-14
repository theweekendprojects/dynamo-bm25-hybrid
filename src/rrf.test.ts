import { describe, it, expect } from 'vitest';
import { fuse } from './rrf.js';
import type { RankedEntry } from './types.js';

describe('fuse (Reciprocal Rank Fusion)', () => {
  it('returns empty for empty input', () => {
    expect(fuse([])).toEqual([]);
    expect(fuse([[]])).toEqual([]);
  });

  it('returns single list unchanged (with RRF scores)', () => {
    const list: RankedEntry<string>[] = [
      { key: 'a', value: 'doc-a' },
      { key: 'b', value: 'doc-b' },
    ];
    const results = fuse([list]);
    expect(results).toHaveLength(2);
    expect(results[0].key).toBe('a');
    expect(results[1].key).toBe('b');
    // RRF score: 1/(60+1) > 1/(60+2)
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].hitCount).toBe(1);
  });

  it('boosts entries appearing in multiple lists', () => {
    const list1: RankedEntry<string>[] = [
      { key: 'a', value: 'doc-a' },
      { key: 'b', value: 'doc-b' },
      { key: 'c', value: 'doc-c' },
    ];
    const list2: RankedEntry<string>[] = [
      { key: 'c', value: 'doc-c' },
      { key: 'b', value: 'doc-b' },
      { key: 'd', value: 'doc-d' },
    ];

    const results = fuse([list1, list2]);

    const b = results.find(r => r.key === 'b')!;
    const c = results.find(r => r.key === 'c')!;
    const a = results.find(r => r.key === 'a')!;
    const d = results.find(r => r.key === 'd')!;

    expect(b.hitCount).toBe(2);
    expect(c.hitCount).toBe(2);
    expect(a.hitCount).toBe(1);
    expect(d.hitCount).toBe(1);

    // Entries in both lists should score higher than single-source entries
    expect(b.score).toBeGreaterThan(a.score);
    expect(c.score).toBeGreaterThan(a.score);
    expect(c.score).toBeGreaterThan(d.score);
  });

  it('respects the limit', () => {
    const list: RankedEntry<string>[] = Array.from({ length: 20 }, (_, i) => ({
      key: `doc-${i}`,
      value: `content-${i}`,
    }));

    const results = fuse([list], { limit: 5 });
    expect(results).toHaveLength(5);
    expect(results[0].key).toBe('doc-0');
  });

  it('uses custom k constant', () => {
    const list1: RankedEntry<string>[] = [{ key: 'a', value: 'a' }];
    const list2: RankedEntry<string>[] = [{ key: 'a', value: 'a' }];

    // k=1: score = 1/(1+1) + 1/(1+1) = 1
    const results = fuse([list1, list2], { k: 1 });
    expect(results[0].score).toBeCloseTo(1.0);

    // k=60: score = 1/(60+1) + 1/(60+1) ≈ 0.0328
    const results60 = fuse([list1, list2], { k: 60 });
    expect(results60[0].score).toBeCloseTo(2 / 61);
  });

  it('fuses 3+ lists', () => {
    const list1: RankedEntry<string>[] = [{ key: 'a', value: 'a' }, { key: 'b', value: 'b' }];
    const list2: RankedEntry<string>[] = [{ key: 'b', value: 'b' }, { key: 'c', value: 'c' }];
    const list3: RankedEntry<string>[] = [{ key: 'b', value: 'b' }, { key: 'a', value: 'a' }];

    const results = fuse([list1, list2, list3]);
    // 'b' appears in all 3 lists — should be #1
    expect(results[0].key).toBe('b');
    expect(results[0].hitCount).toBe(3);
  });
});
