import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readdir, symlink, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
// A standalone CLI must not inherit Node's test-runner IPC output protocol.
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
function compare(checkout, args) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', resolve(checkout, 'scripts/compare_ai.mjs'),
    '--reference', checkout, '--games', '4', '--time', '1', '--plies', '2', ...args],
  { cwd: checkout, env: childEnv, encoding: 'utf8', timeout: 30000 });
  assert.ifError(run.error);
  return run;
}
function summary(run) {
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.matchSummary).matchSummary;
}
async function fixture() {
  const temporary = await mkdtemp(resolve(tmpdir(), 'grr-comparison-fixture-'));
  const ai = resolve(temporary, 'src/lib/game/ai');
  await mkdir(ai, { recursive: true });
  await mkdir(resolve(temporary, 'scripts'));
  await symlink(resolve(root, 'node_modules'), resolve(temporary, 'node_modules'));
  await symlink(resolve(root, 'src/lib/game/riftRules.ts'), resolve(temporary, 'src/lib/game/riftRules.ts'));
  for (const file of await readdir(resolve(root, 'src/lib/game/ai'))) {
    if (file !== 'search.ts') await symlink(resolve(root, 'src/lib/game/ai', file), resolve(ai, file));
  }
  await copyFile(resolve(root, 'scripts/compare_ai.mjs'), resolve(temporary, 'scripts/compare_ai.mjs'));
  // Model state that the normal TT/history reset cannot clear.
  await writeFile(resolve(ai, 'search.ts'), `
    import { validateReinforce } from './board';
    let calls = 0;
    export function findBestMove(board, side, time, depth, progress, filter) {
      for (let pos1 = 0; pos1 < 225; pos1++) for (let pos2 = pos1 + 1; pos2 < 225; pos2++) {
        const move = { action: 'reinforce', pos1, pos2 };
        if (validateReinforce(board, pos1, pos2, side) && (!filter || filter(move))) {
          return { move, score: ++calls, depth: 0, nodes: 0 };
        }
      }
      throw new Error('fixture could not find a legal move');
    }
  `);
  return temporary;
}
async function traces(prefix, games = 4) {
  return Promise.all(Array.from({ length: games }, (_, i) => readFile(`${prefix}-${i + 1}.json`, 'utf8').then(JSON.parse)));
}

test('unique openings are deterministic, distinct between pairs, and identical within each pair', async () => {
  const temporary = await fixture();
  try {
    const runs = [];
    for (const name of ['first', 'second']) {
      const prefix = resolve(temporary, name);
      const result = summary(compare(temporary, ['--bundle', '--unique-openings', '--opening', 'long-pro-book', '--book-width', '2', '--trace', prefix]));
      assert.equal(result.distinctStartingBoards, 2);
      assert.equal(result.uniqueOpenings, true);
      const played = await traces(prefix);
      assert.deepEqual(played[0].initial, played[1].initial);
      assert.deepEqual(played[2].initial, played[3].initial);
      assert.notDeepEqual(played[0].initial, played[2].initial);
      runs.push(played.map(game => ({ initial: game.initial, seed: game.seed })));
    }
    assert.deepEqual(runs[0], runs[1]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('fresh engines clear module state for both engines before every game', async () => {
  const temporary = await fixture();
  try {
    for (const fresh of [false, true]) {
      const prefix = resolve(temporary, fresh ? 'fresh' : 'reused');
      const result = summary(compare(temporary, ['--bundle', '--opening', 'long-pro-full', '--trace', prefix, ...(fresh ? ['--fresh-engines'] : [])]));
      assert.equal(result.freshEngines, fresh);
      assert.equal(result.distinctStartingBoards, 1);
      const played = await traces(prefix);
      for (let game = 0; game < played.length; game++) {
        assert.equal(played[game].history.length, 2);
        assert.deepEqual(new Set(played[game].history.map(move => move.engine)), new Set(['current', 'reference']));
        assert.deepEqual(played[game].history.map(move => move.score), [fresh ? 1 : game + 1, fresh ? 1 : game + 1]);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('invalid isolation and impossible distinct opening requests fail before playing', () => {
  for (const [args, message] of [
    [['--fresh-engines'], /--fresh-engines requires --bundle/],
    [['--unique-openings', '--opening', 'long-pro-full'], /only one starting board/],
    [['--unique-openings', '--opening', 'long-pro-book', '--book-width', '1'], /one book-width entry per color-swapped pair/],
  ]) {
    const run = compare(root, args);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, message);
    assert.equal(run.stdout, '');
  }
});

test('unique opening sampling fails after bounded retries when the book is exhausted', async () => {
  const temporary = await fixture();
  try {
    const moveGen = resolve(temporary, 'src/lib/game/ai/moveGen.ts');
    await rm(moveGen); // Remove the fixture symlink before replacing this module.
    await writeFile(moveGen, `export function generateAllMoves() {
      return [{ move: { action: 'reinforce', pos1: 0, pos2: 17 }, score: 0 }];
    }`);
    const run = compare(temporary, ['--bundle', '--unique-openings', '--opening', 'long-pro-book', '--book-width', '2']);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /could not find a distinct opening for pair 2 within 1000 attempts/);
    assert.equal(run.stdout, '');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('forfeit mode records every illegal move category and finishes the paired match', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const temporary = await mkdtemp(resolve(tmpdir(), 'grr-illegal-engine-'));
  const ai = resolve(temporary, 'src/lib/game/ai');
  try {
    await mkdir(ai, {recursive:true});
    for (const file of await readdir(resolve(root, 'src/lib/game/ai'))) {
      if (file === 'search.ts') continue;
      await symlink(resolve(root, 'src/lib/game/ai', file), resolve(ai, file));
    }
    for (const move of [null,
      {action:'reinforce',pos1:112,pos2:112},
      {action:'rift',pos:0},
      {action:'reinforce',pos1:0,pos2:null},
      {action:'reinforce',pos1:112,pos2:null},
      {action:'rift',pos:112}, // legal capture, prohibited during the opening
    ]) {
      await writeFile(resolve(ai,'search.ts'), `export function findBestMove() { return {move:${JSON.stringify(move)},score:0,depth:0,nodes:0}; }`);
      const run = spawnSync(process.execPath, ['--import','tsx',resolve(root,'scripts/compare_ai.mjs'),
        '--reference',temporary,'--bundle','--games','2','--time','1',
        '--opening','long-pro-full','--illegal','forfeit'], {cwd:root,env:childEnv,encoding:'utf8',timeout:30000});
      assert.ifError(run.error);
      assert.equal(run.status, 0, run.stderr);
      const summary = run.stdout.trim().split('\n').map(s => JSON.parse(s)).find(x => x.matchSummary).matchSummary;
      assert.equal(summary.illegalMoveForfeits, 2, JSON.stringify({move,summary}));
      assert.equal(summary.currentWins, 2, JSON.stringify({move,summary}));
    }
  } finally {
    await rm(temporary, {recursive:true,force:true});
  }
});
