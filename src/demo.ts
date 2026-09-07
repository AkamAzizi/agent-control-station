import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function createDemo(
  directory: string,
): Promise<{ path: string; base: string; head: string }> {
  const path = join(directory, 'demo-repository');
  const marker = join(directory, 'demo.json');
  try {
    return JSON.parse(await readFile(marker, 'utf8'));
  } catch {}
  await mkdir(join(path, 'src'), { recursive: true });
  await mkdir(join(path, 'test'), { recursive: true });
  const git = (args: string[]) =>
    exec(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Agent Station Demo',
        '-c',
        'user.email=demo@localhost',
        ...args,
      ],
      {
        cwd: path,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      },
    );
  await git(['init', '-b', 'main']);
  await writeFile(
    join(path, 'package.json'),
    JSON.stringify({ name: 'checkout-service', type: 'module' }, null, 2),
  );
  await writeFile(
    join(path, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true },
        include: ['src', 'test'],
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(path, 'src', 'pricing.ts'),
    'export function calculateTotal(quantity: number, unitPrice: number): number {\n  return quantity * unitPrice;\n}\n',
  );
  const order = (condition: string) =>
    `import { calculateTotal } from './pricing.js';\n\nexport function createOrder(quantity: number, unitPrice: number) {\n  if (${condition}) throw new Error('Quantity must be positive');\n  return { quantity, total: calculateTotal(quantity, unitPrice) };\n}\n`;
  await writeFile(join(path, 'src', 'order.ts'), order('quantity <= 0'));
  await writeFile(
    join(path, 'test', 'order.test.ts'),
    "import { createOrder } from '../src/order.js';\nexport function testPositiveOrder() {\n  return createOrder(2, 12).total === 24;\n}\n",
  );
  await git(['add', '.']);
  await git(['commit', '-m', 'Add order validation']);
  const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(path, 'src', 'order.ts'), order('quantity === 0'));
  await git(['add', 'src/order.ts']);
  await git(['commit', '-m', 'Simplify quantity validation']);
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const result = { path, base, head };
  await writeFile(marker, JSON.stringify(result), { mode: 0o600 });
  return result;
}
