import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoard } from '../src/lib/game/ai/board.ts';
import { scanLine, classifyLine, countPatterns, patternAt } from '../src/lib/game/ai/patterns.ts';

test('a pattern may bridge one gap, never combine stones across two gaps', () => {
  for (const offset of [1, 15, 16, 14]) {
    const b = createBoard();
    for (const delta of [-2, 0, 2]) b.cells[112 + delta * offset] = 1;
    const dir = [1, 15, 16, 14].indexOf(offset);
    assert.equal(classifyLine(scanLine(b, 112, dir, 1)), null);
    assert.equal(countPatterns(b, 1).GAP_THREE, 0);
    b.cells[112 + 3 * offset] = 1;
    assert.equal(classifyLine(scanLine(b, 112, dir, 1)), 'GAP_THREE');
  }
});

test('pattern-only scans preserve full-length lines, both colors, diagonals and Ko', () => {
  const b = createBoard();
  let state = 31579;
  const random = n => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) % n;
  };
  for (let sample = 0; sample < 80; sample++) {
    for (let pos = 0; pos < 225; pos++) b.cells[pos] = random(3);
    b.koPosition = random(225);
    for (let pos = 0; pos < 225; pos++) {
      if (!b.cells[pos]) continue;
      for (let dir = 0; dir < 4; dir++) for (const ignoreKo of [false, true]) {
        assert.equal(patternAt(b, pos, dir, b.cells[pos], ignoreKo),
          classifyLine(scanLine(b, pos, dir, b.cells[pos], ignoreKo)),
          `sample=${sample} pos=${pos} dir=${dir} ignoreKo=${ignoreKo}`);
      }
    }
  }
});

// Independent oracle: split a line into maximal runs, then classify a run
// alone or joined to one adjacent run across a single legal empty square.
function referencePattern(line, origin, ko) {
  const runs = [...line.join('').matchAll(/1+/g)].map(m => ({ start: m.index, end: m.index + m[0].length }));
  const index = runs.findIndex(r => r.start <= origin && origin < r.end);
  const run = runs[index];
  const open = p => p >= 0 && p < line.length && line[p] === 0 && p !== ko;
  const variants = [{ ...run, count: run.end - run.start, gap: false }];
  for (const neighbor of [runs[index - 1], runs[index + 1]]) {
    if (!neighbor) continue;
    const [left, right] = neighbor.start < run.start ? [neighbor, run] : [run, neighbor];
    if (right.start !== left.end + 1 || !open(left.end)) continue;
    variants.push({ start: left.start, end: right.end,
      count: left.end - left.start + right.end - right.start, gap: true });
  }
  const ranking = ['FIVE', 'OPEN_FOUR', 'GAP_FOUR', 'HALF_FOUR', 'OPEN_THREE', 'GAP_THREE', 'HALF_THREE', 'OPEN_TWO', 'HALF_TWO'];
  const patterns = variants.map(v => {
    const ends = Number(open(v.start - 1)) + Number(open(v.end));
    if (v.count === 5 && !v.gap) return 'FIVE';
    if (v.count === 4) return v.gap ? 'GAP_FOUR' : ends === 2 ? 'OPEN_FOUR' : ends === 1 ? 'HALF_FOUR' : null;
    if (v.count === 3) return v.gap ? (ends ? 'GAP_THREE' : null) : ends === 2 ? 'OPEN_THREE' : ends === 1 ? 'HALF_THREE' : null;
    if (v.count === 2 && !v.gap) return ends === 2 ? 'OPEN_TWO' : ends === 1 ? 'HALF_TWO' : null;
    return null;
  });
  return ranking.find(p => patterns.includes(p)) ?? null;
}

test('line classification agrees with a run-based oracle across all nine-cell lines', () => {
  const b = createBoard();
  // Every ternary nine-cell sequence, with the origin occupied by black.
  // Also exercise the board edge and a ko square inside the line.
  for (let encoded = 0; encoded < 3 ** 8; encoded++) {
    const values = Array(9).fill(1);
    let n = encoded;
    for (let i = 0; i < 9; i++) if (i !== 4) { values[i] = n % 3; n = Math.floor(n / 3); }
    for (const start of [0, 3, 6]) {
      b.cells.fill(0);
      b.cells.set(values, 105 + start);
      const line = [...b.cells.slice(105, 120)];
      for (const ko of [null, start + 3, start + 5]) {
        b.koPosition = ko === null ? null : 105 + ko;
        for (const ignoreKo of [false, true]) {
          const actual = classifyLine(scanLine(b, 105 + start + 4, 0, 1, ignoreKo));
          assert.equal(patternAt(b, 105 + start + 4, 0, 1, ignoreKo), actual);
          assert.equal(actual, referencePattern(line, start + 4, ignoreKo ? null : ko),
            `line=${line.join('')} origin=${start + 4} ko=${ko} ignore=${ignoreKo}`);
        }
      }
    }
  }
});
