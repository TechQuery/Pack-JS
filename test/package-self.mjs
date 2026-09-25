import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { $ } from 'zx';
import { packProject } from '../src/pack.mjs';

const projectDir = path.resolve(process.cwd());
const nodeVersion = process.version;
const packageName = 'pack-js';

const result = await packProject({
  projectDir,
  nodeVersion
});

if (!existsSync(result.outputFile)) {
  throw new Error(`Expected output not found: ${result.outputFile}`);
}
if (!result.outputFile.endsWith(process.platform === 'win32' ? `${packageName}.exe` : packageName)) {
  throw new Error(`Unexpected default output name: ${result.outputFile}`);
}

if (process.platform !== 'win32') {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'pack-js-home-'));
  try {
    await $({ env: { ...process.env, HOME: homeDir } })`sh ${result.outputFile} --noexec`;
    if (!existsSync(path.join(homeDir, 'app', 'package.json'))) {
      throw new Error('Extracted package.json not found in app directory');
    }
    if (!existsSync(path.join(homeDir, packageName))) {
      throw new Error('Launcher script not found in extracted package');
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

console.log(`Packed self to ${result.outputFile}`);
