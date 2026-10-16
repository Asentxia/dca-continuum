import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

export type AeonRankInput = Readonly<{
  distance: number;
  neighborWeight: number;
}>;
export interface AeonRanker {
  score(inputs: readonly AeonRankInput[]): Promise<readonly number[]>;
}

/** Trusted composition supplies a locally built fixed binary, never worker JSON.
 * Numeric-only child protocol; no shell, provider, database, secrets or text I/O.
 * Resource caps are defensive bounds, NOT process/network sandbox containment.
 */
export class NativeAeonRanker implements AeonRanker {
  constructor(private readonly binary: string) {
    if (!isAbsolute(binary))
      throw Error('AEON requires fixed absolute executable');
  }
  async score(inputs: readonly AeonRankInput[]): Promise<readonly number[]> {
    if (!Array.isArray(inputs) || inputs.length > 16)
      throw Error('AEON numeric bounds');
    const args = ['0.15']; // reviewed static donor default; no learned policy
    for (const input of inputs) {
      if (
        !input ||
        !Number.isFinite(input.distance) ||
        input.distance < 0 ||
        input.distance > 2 ||
        !Number.isFinite(input.neighborWeight) ||
        input.neighborWeight < 0 ||
        input.neighborWeight > 5
      )
        throw Error('AEON numeric bounds');
      args.push(`${input.distance},${input.neighborWeight}`);
    }
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        this.binary,
        args,
        {
          env: {},
          timeout: 2000,
          maxBuffer: 4096,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error || stderr) reject(Error('AEON ranker unavailable'));
          else resolve(stdout);
        },
      );
    });
    const lines = output === '' ? [] : output.trimEnd().split('\n');
    if (lines.length !== inputs.length) throw Error('AEON numeric reply');
    return Object.freeze(
      lines.map((line, index) => {
        const match = /^(0|[1-9][0-9]*) ([0-9]+\.[0-9]{17})$/.exec(line);
        const score = match ? Number(match[2]) : NaN;
        if (
          !match ||
          Number(match[1]) !== index ||
          !Number.isFinite(score) ||
          score < 0 ||
          score > 2
        )
          throw Error('AEON numeric reply');
        return score;
      }),
    );
  }
}
