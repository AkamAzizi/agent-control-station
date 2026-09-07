import { resolve } from 'node:path';
import { snapshot } from './repository/index.js';
import { compile } from './context/index.js';
import { Store } from './store.js';
import type { ContextPacket, ContextPolicy, Snapshot } from './types.js';

export async function compileReviewContext(options: {
  repo: string;
  base: string;
  head?: string;
  task?: string;
  policy?: Partial<ContextPolicy>;
  scopePaths?: string[];
  directory?: string;
}): Promise<{ packet: ContextPacket; snapshot: Snapshot }> {
  const directory = resolve(options.directory ?? process.env.STATION_DATA ?? '.station');
  const store = new Store(directory);
  try {
    const source = await snapshot(resolve(options.repo), options.base, options.head ?? 'HEAD');
    const packet = await compile(
      source,
      options.task ?? 'Review this diff for actionable correctness defects.',
      options.policy ?? {},
      store.packs().filter((pack) => pack.roles.includes('reviewer')),
      options.scopePaths,
    );
    return { packet, snapshot: source };
  } finally {
    store.close();
  }
}
