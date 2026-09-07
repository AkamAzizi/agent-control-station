import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
export function createModelRuntime(directory: string) {
  return ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(directory, 'models-store.json'),
    allowModelNetwork: false,
    signal: AbortSignal.timeout(10000),
  });
}
export async function availableModels(directory: string) {
  const runtime = await createModelRuntime(directory);
  return (await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(10000) })).map(
    (m) => ({ provider: m.provider, id: m.id, name: m.name }),
  );
}
