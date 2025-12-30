export type PolicyKind = 'random' | 'softmax' | 'epsilon' | 'search';

export interface SelfPlayOptions {
  games: number;
  maxPlies: number;
  seed: number;
  outPath: string;
  weightsPath: string | null;

  // Parallelism
  shards: number;
  shardIndex: number | null;

  policy: PolicyKind;
  // random/softmax
  topK: number;
  temperature: number;
  // epsilon
  epsilon: number;
  // search
  timeMs: number;
  maxDepth: number;
}

function parseIntArg(v: string, name: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${name}: ${v}`);
  return n;
}

function parseFloatArg(v: string, name: string): number {
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${name}: ${v}`);
  return n;
}

export function parseArgs(argv: string[]): SelfPlayOptions {
  // Defaults chosen to allow “nearly random” bootstrap.
  const opts: SelfPlayOptions = {
    games: 200,
    maxPlies: 600,
    seed: 1,
    outPath: 'training/data/selfplay.bin',
    weightsPath: null,
    shards: 1,
    shardIndex: null,
    policy: 'softmax',
    topK: 40,
    temperature: 3.0,
    epsilon: 0.25,
    timeMs: 25,
    maxDepth: 6,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v == null) throw new Error(`Missing value for ${a}`);
      i++;
      return v;
    };

    if (a === '--games') opts.games = parseIntArg(next(), a);
    else if (a === '--maxPlies') opts.maxPlies = parseIntArg(next(), a);
    else if (a === '--seed') opts.seed = parseIntArg(next(), a);
    else if (a === '--out') opts.outPath = next();
    else if (a === '--weights') opts.weightsPath = next();
    else if (a === '--policy') opts.policy = next() as PolicyKind;
    else if (a === '--topK') opts.topK = parseIntArg(next(), a);
    else if (a === '--temperature') opts.temperature = parseFloatArg(next(), a);
    else if (a === '--epsilon') opts.epsilon = parseFloatArg(next(), a);
    else if (a === '--timeMs') opts.timeMs = parseIntArg(next(), a);
    else if (a === '--maxDepth') opts.maxDepth = parseIntArg(next(), a);
    else if (a === '--shards') opts.shards = parseIntArg(next(), a);
    else if (a === '--shardIndex') opts.shardIndex = parseIntArg(next(), a);
    else if (a === '--help' || a === '-h') {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }

  if (opts.games <= 0) throw new Error('--games must be > 0');
  if (opts.maxPlies <= 0) throw new Error('--maxPlies must be > 0');
  if (opts.topK <= 0) throw new Error('--topK must be > 0');
  if (opts.temperature <= 0) throw new Error('--temperature must be > 0');
  if (opts.epsilon < 0 || opts.epsilon > 1) throw new Error('--epsilon must be in [0,1]');
  if (opts.timeMs < 0) throw new Error('--timeMs must be >= 0');
  if (opts.maxDepth <= 0) throw new Error('--maxDepth must be > 0');
  if (opts.shards <= 0) throw new Error('--shards must be > 0');
  if (opts.shardIndex !== null) {
    if (opts.shardIndex < 0) throw new Error('--shardIndex must be >= 0');
    if (opts.shardIndex >= opts.shards) throw new Error('--shardIndex must be < --shards');
  }

  return opts;
}

function printHelpAndExit(): void {
  // eslint-disable-next-line no-console
  console.log(`
Self-play dataset generator

Usage:
  node training/dist/selfplay/generate_dataset.mjs [args]

Args:
  --out PATH          Output dataset path (default: training/data/selfplay.bin)
  --games N           Number of self-play games (default: 200)
  --maxPlies N        Max plies per game before draw (default: 600)
  --seed N            RNG seed (default: 1)
  --shards N          Parallel shards (default: 1)
  --shardIndex N      Shard index (internal; default: unset)

  --weights PATH      Optional NNUE weights.bin path for search-guided play

  --policy KIND       random | softmax | epsilon | search (default: softmax)
  --topK N            Sampling window for random/softmax (default: 40)
  --temperature F     Softmax temperature (default: 3.0)
  --epsilon F         Epsilon for epsilon-greedy (default: 0.25)
  --timeMs N          Search time per move when policy uses search (default: 25)
  --maxDepth N        Search max depth (default: 6)
`);
  // eslint-disable-next-line no-process-exit
  process.exit(0);
}

