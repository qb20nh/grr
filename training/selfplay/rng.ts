export interface Rng {
  nextU32(): number;
  nextFloat01(): number;
  int(minInclusive: number, maxExclusive: number): number;
}

export class XorShift32 implements Rng {
  private state: number;

  constructor(seed: number) {
    // Avoid the all-zero state.
    this.state = (seed | 0) || 0x9e3779b9;
  }

  nextU32(): number {
    // xorshift32
    let x = this.state | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    return this.state >>> 0;
  }

  nextFloat01(): number {
    // [0,1)
    return this.nextU32() / 0x1_0000_0000;
  }

  int(minInclusive: number, maxExclusive: number): number {
    const span = maxExclusive - minInclusive;
    if (span <= 0) return minInclusive;
    // Rejection sampling for uniformity.
    const limit = Math.floor(0x1_0000_0000 / span) * span;
    let x = this.nextU32();
    while (x >= limit) x = this.nextU32();
    return minInclusive + (x % span);
  }
}

