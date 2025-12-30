// Minimal Node typings to allow compiling training scripts without pulling @types/node.
// Runtime will be executed by Node, so these are intentionally minimal.

interface NodeProcessLike {
  argv: string[];
  execPath: string;
  exit(code?: number): never;
}

declare const process: NodeProcessLike;
declare const Buffer: {
  from(data: ArrayBuffer | Uint8Array): Uint8Array;
};

declare module 'node:fs/promises' {
  export const mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>;
  export const readFile: (path: string) => Promise<Uint8Array>;
  export const unlink: (path: string) => Promise<void>;
  export const writeFile: (path: string, data: Uint8Array) => Promise<void>;
  export const open: (path: string, flags: string) => Promise<{
    write: (buffer: Uint8Array, offset?: number, length?: number, position?: number) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

declare module 'node:path' {
  export const dirname: (p: string) => string;
}

declare module 'node:child_process' {
  export const spawn: any;
}

