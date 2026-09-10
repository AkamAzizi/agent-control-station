#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from './server.js';
import { compileReviewContext } from './compile.js';
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
    if (!repo || !base)
      throw new Error('Usage: pnpm cli context --repo PATH --base REF [--head REF] [--out DIR]');
    const { packet } = await compileReviewContext({
      repo,
      base,
      head: flag('head', 'HEAD'),
      task: flag('task', 'Review this diff for actionable correctness defects.'),
      directory,
    });
    const out = flag('out');
    if (out) {
      await mkdir(resolve(out), { recursive: true });
      await writeFile(resolve(out, 'context.json'), JSON.stringify(packet, null, 2));
      await writeFile(resolve(out, 'context.md'), packet.prompt);
    } else console.log(JSON.stringify(packet, null, 2));
    if (packet.status !== 'ready') process.exitCode = 2;
    return;
  }
  if (command === 'mcp') {
    const { serveMcp } = await import('./mcp.js');
    serveMcp(directory);
    return;
  }
  if (command === 'corpus') {
    const { materializeCorpus } = await import('./corpus.js');
    const out = resolve(flag('out', 'corpus')!);
    const result = await materializeCorpus(out);
    console.log(`Wrote ${result.dataset.cases.length} seeded cases to ${out}/dataset.json`);
    return;
  }
  if (command === 'dataset-mine') {
    const { mineHeldOutDataset, writeFrozenDataset, DEFAULT_REPOSITORIES } =
      await import('./dataset-mine.js');
    const out = resolve(flag('out', 'artifacts')!);
    const result = await mineHeldOutDataset({
      sources:
        flag('repos')
          ?.split(',')
          .map((value) => value.trim())
          .filter(Boolean) ?? DEFAULT_REPOSITORIES,
      cacheDir: resolve(flag('cache', join(out, 'repos'))!),
      defectTarget: Number(flag('defects', '25')),
      cleanTarget: Number(flag('clean', '12')),
      github: args.includes('--github'),
    });
    const frozen = await writeFrozenDataset(result.cases, out);
    const defects = result.cases.filter((sample) => sample.kind === 'defect').length;
    const cleans = result.cases.filter((sample) => sample.kind === 'clean').length;
    console.log(
      JSON.stringify(
        {
          cases: result.cases.length,
          defects,
          clean: cleans,
          sha256: frozen.sha256,
          dataset: frozen.datasetPath,
          hash: frozen.hashPath,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'dataset-fetch') {
    const { fetchDatasetRepos } = await import('./dataset-mine.js');
    const file = resolve(flag('dataset', 'artifacts/benchmark.dataset.json')!);
    await fetchDatasetRepos(file, resolve(flag('cache', 'artifacts/repos')!));
    return;
  }
  if (command === 'dataset-freeze') {
    const { freezeDataset } = await import('./dataset-mine.js');
    const frozen = await freezeDataset(
      resolve(flag('dataset', 'artifacts/benchmark.dataset.json')!),
    );
    console.log(JSON.stringify(frozen, null, 2));
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
        'Usage: pnpm cli benchmark --dataset FILE [--runtime fixture|pi] [--provider PROVIDER --model MODEL] [--out DIR]',
      );
    await benchmark({
      dataset: resolve(file),
      directory: resolve(flag('out', 'benchmark-results')!),
      provider: flag('provider'),
      model: flag('model'),
      runtime: (flag('runtime', 'pi') as 'pi' | 'fixture') ?? 'pi',
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
    'Commands: serve, context, mcp, corpus, dataset-mine, dataset-fetch, dataset-freeze, pack-import, benchmark, benchmark-score. See README.md for options.',
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
