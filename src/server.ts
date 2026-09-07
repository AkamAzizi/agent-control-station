import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError, z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Orchestrator } from './orchestrator.js';
import { requestSchema, feedbackSchema, packSchema } from './schemas.js';
import { availableModels } from './runner/models.js';
import { createDemo } from './demo.js';
import { exportMarkdown } from './export.js';
import type { ContextPacket, Runner } from './types.js';
const exec = promisify(execFile);

export async function createServer(options: {
  directory: string;
  runner?: Runner;
  models?: { provider: string; id: string; name: string }[];
}) {
  const store = new Store(options.directory);
  const orchestrator = new Orchestrator(store, { runner: options.runner });
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const models = options.models
    ? Promise.resolve({ models: options.models })
    : availableModels(options.directory)
        .then((models) => ({
          models,
          modelError: models.length
            ? undefined
            : 'Configure a provider API key in the daemon environment, then restart. The demo works without credentials.',
        }))
        .catch(() => ({
          models: [],
          modelError:
            'Model catalog unavailable. Configure a provider API key in the daemon environment and restart.',
        }));
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host))
      return reply.code(403).send({ error: 'Local host required' });
    const origin = req.headers.origin;
    if (origin) {
      let allowed = false;
      try {
        const url = new URL(origin);
        allowed = url.host === host && url.protocol === 'http:';
      } catch {}
      if (!allowed) return reply.code(403).send({ error: 'Same-origin requests required' });
    }
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send({ error: 'Cross-site requests denied' });
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !req.headers['content-type']?.startsWith('application/json')
    )
      return reply.code(415).send({ error: 'Use application/json' });
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, req, reply) => {
    const message = error instanceof Error ? error.message : 'Request failed';
    const status = error instanceof ZodError ? 400 : /not found/i.test(message) ? 404 : 400;
    reply.code(status).send({
      error:
        error instanceof ZodError
          ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : message,
    });
  });
  app.get('/api/state', async () => ({
    repos: store.repos(),
    runs: store.runs(),
    packs: store.packs(),
    settings: { maxWorkers: 4 },
    ...(await models),
  }));
  app.post('/api/repos', async (req) =>
    orchestrator.register(z.object({ path: z.string().min(1).max(2000) }).parse(req.body).path),
  );
  app.post('/api/runs', async (req, reply) =>
    reply.code(202).send(orchestrator.start(requestSchema.parse(req.body))),
  );
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req) => {
    const run = store.run(req.params.id);
    return {
      run,
      context: run.contextId ? store.artifact('context', run.contextId) : null,
      events: store.events(0, run.id),
      feedback: store.feedback(run.id),
    };
  });
  app.get<{ Params: { id: string } }>('/api/context/:id', async (req) => {
    const context = store.artifact('context', req.params.id);
    if (!context) throw new Error('Context not found');
    return context;
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req) =>
    orchestrator.cancel(req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/runs/:id/retry', async (req, reply) =>
    reply.code(202).send(orchestrator.retry(req.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/runs/:id/feedback', async (req) => {
    const feedback = store.addFeedback({ runId: req.params.id, ...feedbackSchema.parse(req.body) });
    const event = store.record(store.run(req.params.id), 'feedback.recorded', {
      findingId: feedback.findingId,
      feedbackId: feedback.id,
    });
    orchestrator.events.emit('event', event);
    return feedback;
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/pack-draft', async (req) => {
    const { findingId } = z.object({ findingId: z.string() }).parse(req.body);
    const run = store.run(req.params.id);
    const finding = run.findings.find((f) => f.id === findingId);
    if (!finding) throw new Error('Finding not found');
    const feedback = store
      .feedback(run.id)
      .filter((f) => f.findingId === findingId && f.note.trim())
      .at(-1);
    if (!feedback)
      throw new Error('Add an explanatory feedback note before drafting a judgment rule.');
    return store.savePack({
      id: `feedback-${randomUUID().slice(0, 8)}`,
      version: 1,
      name: `Draft: ${finding.title}`.slice(0, 160),
      active: false,
      globs: [finding.path],
      roles: ['reviewer'],
      rules: [
        {
          id: 'operator-judgment',
          text: feedback.note,
          source: `run:${run.id}/finding:${findingId}/feedback:${feedback.id}`,
        },
      ],
    });
  });
  app.post('/api/packs', async (req) => store.savePack(packSchema.parse(req.body)));
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/api/runs/:id/export',
    async (req, reply) => {
      const run = store.run(req.params.id);
      const context = run.contextId
        ? (store.artifact('context', run.contextId) as ContextPacket)
        : null;
      const feedback = store.feedback(run.id);
      if (req.query.format === 'json')
        return reply
          .header('Content-Disposition', `attachment; filename="review-${run.id}.json"`)
          .type('application/json')
          .send(JSON.stringify({ run, context, feedback }, null, 2));
      return reply
        .header('Content-Disposition', `attachment; filename="review-${run.id}.md"`)
        .type('text/markdown; charset=utf-8')
        .send(exportMarkdown(run, context, feedback));
    },
  );
  let demoPromise: ReturnType<typeof createDemo> | undefined;
  app.post('/api/demo', async () => {
    demoPromise ??= createDemo(options.directory).catch((error) => {
      demoPromise = undefined;
      throw error;
    });
    const demo = await demoPromise;
    const repo = await orchestrator.register(demo.path);
    const run = orchestrator.start({
      repoId: repo.id,
      base: demo.base,
      head: demo.head,
      task: 'Review quantity validation',
      runtime: 'scripted',
      demo: true,
    });
    return { repo, run };
  });
  app.post('/api/github/import', async (req) => {
    const { repoId, url } = z
      .object({
        repoId: z.string(),
        url: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/),
      })
      .parse(req.body);
    const repo = store.repo(repoId);
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    const { stdout } = await exec(
      'gh',
      ['pr', 'view', url, '--json', 'baseRefOid,headRefOid,title'],
      { cwd: repo.path, timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    const metadata = z
      .object({
        baseRefOid: z.string().regex(/^[a-f0-9]{40,64}$/),
        headRefOid: z.string().regex(/^[a-f0-9]{40,64}$/),
        title: z.string(),
      })
      .parse(JSON.parse(stdout));
    // Only a local object fetch; no working-tree changes and no GitHub writes.
    await exec(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        `https://github.com/${segments[1]}/${segments[2]}.git`,
        metadata.baseRefOid,
        metadata.headRefOid,
      ],
      { cwd: repo.path, timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    return { base: metadata.baseRefOid, head: metadata.headRefOid, title: metadata.title };
  });
  const clients = new Set<() => void>();
  app.get('/api/events', (req, reply) => {
    const parsed = Number(req.headers['last-event-id'] ?? 0);
    const after = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: ReturnType<Store['events']>[number]) => {
      if (!reply.raw.destroyed)
        reply.raw.write(`id: ${event.id}\nevent: station\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // No await between replay and subscription: SQLite and emit share this event loop.
    for (const event of store.events(after)) write(event);
    const unsubscribe = orchestrator.subscribe(write);
    const timer = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 15000);
    timer.unref();
    const close = () => {
      clearInterval(timer);
      unsubscribe();
      clients.delete(close);
      if (!reply.raw.destroyed) reply.raw.end();
    };
    clients.add(close);
    reply.raw.on('close', close);
  });
  const webRoot = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
  if (existsSync(join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Not found' })
        : reply.sendFile('index.html'),
    );
  } else
    app.get('/', async (_, reply) =>
      reply
        .type('text/html')
        .send(
          '<h1>Agent Control Station</h1><p>Run <code>pnpm build</code> and restart to load the control station.</p>',
        ),
    );
  app.addHook('preClose', async () => {
    for (const close of clients) close();
    await orchestrator.close();
  });
  app.addHook('onClose', async () => {
    store.close();
  });
  return { app, store, orchestrator };
}
