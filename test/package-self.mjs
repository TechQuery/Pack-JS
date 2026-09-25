import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { $ } from 'zx';
import { getExtractionCommand, packProject, resolveNodeVersion } from '../src/pack.mjs';

const projectDir = path.resolve(process.cwd());
const nodeVersion = process.version;
const packageName = 'pack-js';
const fetchBackup = global.fetch;

try {
  if (getExtractionCommand('zip', 'win32') !== 'powershell-zip') {
    throw new Error('Expected Windows ZIP extraction command to use PowerShell');
  }
  if (getExtractionCommand('zip', 'linux') !== 'python-zip') {
    throw new Error('Expected POSIX ZIP extraction command to use python zipfile');
  }
  if (getExtractionCommand('tar.xz', 'linux') !== 'tar') {
    throw new Error('Expected tar extraction command for non-zip archives');
  }

  global.fetch = async (url) => {
    if (String(url).includes('/index.json')) {
      return {
        ok: true,
        json: async () => [{ version: 'v22.8.0' }, { version: 'v20.18.0' }]
      };
    }
    return fetchBackup(url);
  };
  const resolvedByEngine = await resolveNodeVersion({ sourcePkg: { engines: { node: '^20' } } });
  if (resolvedByEngine !== 'v20.18.0') {
    throw new Error(`Unexpected resolved node version: ${resolvedByEngine}`);
  }

  global.fetch = async () => ({ ok: false, status: 503 });
  let fetchErrorCaught = false;
  try {
    await resolveNodeVersion({ sourcePkg: {} });
  } catch {
    fetchErrorCaught = true;
  }
  if (!fetchErrorCaught) {
    throw new Error('Expected resolveNodeVersion to throw when node index fetch fails');
  }
} finally {
  global.fetch = fetchBackup;
}

const homeDir = await mkdtemp(path.join(os.tmpdir(), 'pack-js-home-'));
const originalHome = process.env.HOME;
process.env.HOME = homeDir;

try {
  const result = await packProject({ projectDir, nodeVersion });

  if (!existsSync(result.outputFile)) {
    throw new Error(`Expected output not found: ${result.outputFile}`);
  }
  if (!result.outputFile.endsWith(process.platform === 'win32' ? `${packageName}.exe` : packageName)) {
    throw new Error(`Unexpected default output name: ${result.outputFile}`);
  }

  if (process.platform !== 'win32') {
    await $`sh ${result.outputFile} --noexec`;
    if (!existsSync(path.join(homeDir, 'app', 'package.json'))) {
      throw new Error('Extracted package.json not found in app directory');
    }
    if (!existsSync(path.join(homeDir, packageName))) {
      throw new Error('Launcher script not found in extracted package');
    }
  }
  console.log(`Packed self to ${result.outputFile}`);
} finally {
  process.env.HOME = originalHome;
  await rm(homeDir, { recursive: true, force: true });
}
