import { mkdtemp, mkdir, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from '../src/server.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

async function main() {
  const data = await mkdtemp(join(tmpdir(), 'station-demo-'));
  const out = join(root, 'docs', 'demo');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const { app } = await createServer({ directory: data });
  const port = 4318;
  await app.listen({ host: '127.0.0.1', port });
  const url = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
    recordVideo: { dir: join(out, 'raw'), size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await pause(800);
    await page.screenshot({ path: join(out, '01-empty.png') });
    await page.getByRole('button', { name: 'Try demo' }).click();
    await page
      .getByRole('heading', { name: 'Review quantity validation' })
      .waitFor({ timeout: 10000 });
    await pause(150);
    await page.screenshot({ path: join(out, '02-running.png') });
    await page.getByText('Negative quantities pass validation').waitFor({ timeout: 20000 });
    await page.getByText('quantity === 0').waitFor();
    await page.getByText('Completed').first().waitFor();
    await pause(800);
    await page.screenshot({ path: join(out, '03-finding-evidence.png') });
    await page.getByRole('tab', { name: /Context/ }).click();
    await pause(800);
    await page.screenshot({ path: join(out, '04-context.png') });
    await page.getByRole('tab', { name: /Findings/ }).click();
    await pause(600);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
  const videoDir = join(out, 'raw');
  const { readdir } = await import('node:fs/promises');
  const videos = (await readdir(videoDir)).filter((name) => name.endsWith('.webm'));
  if (videos[0]) await copyFile(join(videoDir, videos[0]), join(out, 'local-run.webm'));
  await rm(videoDir, { recursive: true, force: true });
  await exec('ffmpeg', [
    '-y',
    '-loop',
    '1',
    '-t',
    '1.5',
    '-i',
    join(out, '01-empty.png'),
    '-loop',
    '1',
    '-t',
    '1.5',
    '-i',
    join(out, '02-running.png'),
    '-loop',
    '1',
    '-t',
    '2.2',
    '-i',
    join(out, '03-finding-evidence.png'),
    '-loop',
    '1',
    '-t',
    '1.8',
    '-i',
    join(out, '04-context.png'),
    '-filter_complex',
    '[0][1][2][3]concat=n=4:v=1:a=0,fps=8,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
    join(out, 'flow.gif'),
  ]);
  console.log(`Wrote demo assets to ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
