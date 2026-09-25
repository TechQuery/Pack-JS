import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { $ } from 'zx';
import { packProject } from '../src/pack.mjs';

const projectDir = path.resolve(process.cwd());
const nodeVersion = process.version;

const result = await packProject({
  projectDir,
  nodeVersion,
  outputName: 'pack-js-test'
});

if (!existsSync(result.outputFile)) {
  throw new Error(`Expected output not found: ${result.outputFile}`);
}

if (process.platform !== 'win32') {
  const extractDir = await mkdtemp(path.join(os.tmpdir(), 'pack-js-test-'));
  try {
    await $`sh ${result.outputFile} --target ${extractDir} --noexec`;
    if (!existsSync(path.join(extractDir, 'app', 'package.json'))) {
      throw new Error('Extracted package.json not found in app directory');
    }
    if (!existsSync(path.join(extractDir, 'pack-js'))) {
      throw new Error('Launcher script not found in extracted package');
    }
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}

console.log(`Packed self to ${result.outputFile}`);
