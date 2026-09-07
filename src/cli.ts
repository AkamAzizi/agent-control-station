#!/usr/bin/env node
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from './server.js';
import { snapshot } from './repository/index.js';
import { compile } from './context/index.js';
import { Store } from './store.js';
import { packSchema } from './schemas.js';
const args = process.argv.slice(2);
const command = args[0] ?? 'serve';
function flag(name: string, fallback?: string) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const directory = resolve(flag('data', process.env.STATION_DATA ?? '.station')!);
async function main() {
  if (command === 'serve') {
    const { app } = await createServer({ directory });
    const port = Number(flag('port', process.env.PORT ?? '4317'));
    await app.listen({ host: '127.0.0.1', port });
    console.log(`Agent Control Station · http://127.0.0.1:${port}\nLocal data: ${directory}`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        void app.close().then(() => process.exit(0));
      });
    return;
  }
  if (command === 'context') {
    const repo = flag('repo');
    const base = flag('base');
    const head = flag('head', 'HEAD');
    if (!repo || !base)
      throw new Error('Usage: pnpm cli context --repo PATH --base REF [--head REF] [--out DIR]');
    const store = new Store(directory);
    try {
      const source = await snapshot(resolve(repo), base, head!);
      const packet = await compile(
        source,
        flag('task', 'Review this diff for actionable correctness defects.')!,
        {},
        store.packs().filter((p) => p.roles.includes('reviewer')),
      );
      const out = flag('out');
      if (out) {
        await mkdir(resolve(out), { recursive: true });
        await writeFile(resolve(out, 'context.json'), JSON.stringify(packet, null, 2));
        await writeFile(resolve(out, 'context.md'), packet.prompt);
      } else console.log(JSON.stringify(packet, null, 2));
      if (packet.status !== 'ready') process.exitCode = 2;
    } finally {
      store.close();
    }
    return;
  }
  if (command === 'pack-import') {
    const file = flag('file');
    if (!file) throw new Error('Usage: pnpm cli pack-import --file PACK.md');
    const text = await readFile(resolve(file), 'utf8');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) throw new Error('Pack requires JSON frontmatter between --- delimiters.');
    const pack = packSchema.parse(JSON.parse(match[1]));
    const store = new Store(directory);
    try {
      store.savePack(pack);
      console.log(`Imported ${pack.id} v${pack.version}`);
    } finally {
      store.close();
    }
    return;
  }
  if (command === 'benchmark') {
    const { benchmark } = await import('./benchmark.js');
    const file = flag('dataset');
    if (!file)
      throw new Error(
        'Usage: pnpm cli benchmark --dataset FILE --provider PROVIDER --model MODEL [--out DIR]',
      );
    await benchmark({
      dataset: resolve(file),
      directory: resolve(flag('out', 'benchmark-results')!),
      provider: flag('provider'),
      model: flag('model'),
      repeats: Number(flag('repeats', '3')),
      execute: args.includes('--execute'),
    });
    return;
  }
  if (command === 'benchmark-score') {
    const { scoreBenchmark } = await import('./benchmark.js');
    await scoreBenchmark(resolve(flag('out', 'benchmark-results')!));
    return;
  }
  console.log(
    'Commands: serve, context, pack-import, benchmark, benchmark-score. See README.md for options.',
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
