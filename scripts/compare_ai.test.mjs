import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
        '--opening','long-pro-full','--illegal','forfeit'], {cwd:root,encoding:'utf8',timeout:30000});
      assert.equal(run.status, 0, run.stderr);
      const summary = run.stdout.trim().split('\n').map(s => JSON.parse(s)).find(x => x.matchSummary).matchSummary;
      assert.equal(summary.illegalMoveForfeits, 2, JSON.stringify({move,summary}));
      assert.equal(summary.currentWins, 2, JSON.stringify({move,summary}));
    }
  } finally {
    await rm(temporary, {recursive:true,force:true});
  }
});
