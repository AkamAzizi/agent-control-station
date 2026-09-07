import { fork } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Runner, WorkerSpec, ScopedTools, WorkerEvent } from '../types.js';

export function workerEnvironment(directory: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    STATION_DATA: directory,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
  };
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'OPENROUTER_API_KEY',
    'MISTRAL_API_KEY',
    'GROQ_API_KEY',
    'XAI_API_KEY',
  ])
    if (process.env[key]) result[key] = process.env[key];
  return result;
}
export class PiRunner implements Runner {
  constructor(private directory: string) {}
  async *run(
    spec: WorkerSpec,
    tools: ScopedTools,
    signal: AbortSignal,
  ): AsyncIterable<WorkerEvent> {
    signal.throwIfAborted();
    const cwd = join(this.directory, 'workers');
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const child = fork(fileURLToPath(new URL('./pi-worker.ts', import.meta.url)), [], {
      cwd,
      execArgv: ['--import', import.meta.resolve('tsx')],
      env: workerEnvironment(this.directory),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const queue: WorkerEvent[] = [];
    let wake: () => void = () => {};
    let done = false;
    let failure: Error | undefined;
    let stderr = '';
    const stop = () => {
      failure = signal.reason instanceof Error ? signal.reason : new Error('Worker aborted');
      done = true;
      child.kill('SIGTERM');
      wake();
    };
    signal.addEventListener('abort', stop, { once: true });
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.on('error', (error) => {
      failure = error;
      done = true;
      wake();
    });
    child.on('exit', (code) => {
      if (!done && code !== 0) failure = new Error(`Pi worker exited (${code}): ${stderr}`);
      done = true;
      wake();
    });
    child.on('message', async (message: any) => {
      if (message?.type === 'tool') {
        try {
          const value =
            message.name === 'read'
              ? await tools.read(message.input)
              : message.name === 'lookup'
                ? await tools.lookup(message.input)
                : (() => {
                    throw new Error('Unknown worker tool');
                  })();
          if (child.connected) child.send({ type: 'tool_result', id: message.id, value });
        } catch (error) {
          if (child.connected)
            child.send({
              type: 'tool_result',
              id: message.id,
              error: error instanceof Error ? error.message : String(error),
            });
        }
      } else if (message?.type === 'event') {
        queue.push(message.event);
        wake();
      } else if (message?.type === 'error') {
        failure = new Error(message.error);
        done = true;
        wake();
      } else if (message?.type === 'done') {
        done = true;
        wake();
      }
    });
    child.send({ type: 'start', spec });
    try {
      while (!done || queue.length) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (failure) throw failure;
    } finally {
      signal.removeEventListener('abort', stop);
      if (child.connected) child.disconnect();
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
        kill.unref();
      }
    }
  }
}
