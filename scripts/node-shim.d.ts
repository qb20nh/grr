// Minimal Node typings to allow typechecking this script under the app's TS config
// (which uses `moduleResolution: bundler` and doesn't include full Node libdefs).
// Runtime executes under Node, so these are intentionally lightweight.

interface NodeProcessLike {
  argv: string[];
  env: Record<string, string | undefined>;
  stdin: { isTTY?: boolean };
  stdout: any;
  stderr: any;
  exit: (code?: number) => never;
  exitCode?: number;
}

declare const process: NodeProcessLike;

declare module 'node:child_process' {
  export interface ChildProcessWithoutNullStreams {
    stdout: any;
    stderr: any;
    stdin: any;
    on: (...args: any[]) => any;
    kill: (signal?: string) => void;
  }
  export const spawn: (...args: any[]) => ChildProcessWithoutNullStreams;
}

declare module 'node:fs/promises' {
  export const cp: any;
  export const mkdir: any;
  export const readFile: any;
  export const readdir: any;
  export const rename: any;
  export const rm: any;
  export const stat: any;
  export const writeFile: any;
}

declare module 'node:net' {
  export const createServer: any;
}

declare module 'node:path' {
  export const dirname: (p: string) => string;
  export const join: (...parts: string[]) => string;
}

declare module 'node:readline' {
  export const createInterface: any;
}

declare module 'node:url' {
  export const fileURLToPath: any;
  export const pathToFileURL: any;
}

