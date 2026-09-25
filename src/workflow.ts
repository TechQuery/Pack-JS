import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { $, fs } from 'zx';
import fg from 'fast-glob';
import semver from 'semver';
import {
  LOCK_FILES,
  TargetPlatform,
  getExtractionCommand,
  normalizeArch,
  normalizePlatform,
  normalizeVersion,
  toPosixPath,
  toWindowsPath
} from './utils.js';

const require = createRequire(import.meta.url);
const MAKSELF_COMMIT = '9f5fd3f77eea3f5e262745c0f3899d761a5fd5f7';

const INSTALLERS = [
  {
    name: 'pnpm',
    attempts: [
      ['install', '--prod', '--frozen-lockfile', '--package-import-method=copy'],
      ['install', '--prod', '--package-import-method=copy']
    ]
  },
  { name: 'yarn', attempts: [['install', '--production', '--frozen-lockfile'], ['install', '--production']] },
  { name: 'npm', attempts: [['install', '--omit=dev']] }
] as const;

interface PackProjectInput {
  projectDir?: string;
  targetPlatform?: string;
  arch?: string;
  nodeVersion?: string;
  outputName?: string;
}

interface PackageJSON {
  name?: string;
  files?: string[];
  engines?: { node?: string };
  bin?: string | Record<string, string>;
}

export const packProject = async ({
  projectDir = process.cwd(),
  targetPlatform = process.platform,
  arch = process.arch,
  nodeVersion,
  outputName
}: PackProjectInput = {}) => {
  const sourceDir = path.resolve(projectDir);
  const sourcePkg = (await fs.readJSON(path.join(sourceDir, 'package.json'))) as PackageJSON;
  const packageName = sourcePkg.name?.trim();

  if (!packageName) throw new Error('package.json name is required');

  const platform = normalizePlatform(targetPlatform);
  const runtimeArch = normalizeArch(arch, platform);
  const tmpRoot = path.join(sourceDir, '.tmp', packageName);
  const appDir = path.join(tmpRoot, 'app');
  const runtimeDir = path.join(tmpRoot, 'runtime');
  const outDir = path.join(sourceDir, 'out');

  await fs.remove(tmpRoot);
  await fs.ensureDir(appDir);
  await fs.ensureDir(outDir);

  await copyProjectFiles(sourceDir, appDir, sourcePkg);
  await installProductionDependencies(appDir);

  const version = await resolveNodeVersion({ sourcePkg, overrideVersion: nodeVersion });
  const nodePath = await installNodeRuntime({ version, runtimeDir, platform, arch: runtimeArch });

  await createLaunchers({ tmpRoot, sourcePkg, nodePath, platform });
  if (platform !== 'win') await createInstallScript(tmpRoot);

  const outputBaseName = outputName || packageName;
  const outputFile = path.join(outDir, platform === 'win' ? `${outputBaseName}.exe` : outputBaseName);

  if (platform === 'win') {
    await packageWith7Zip(tmpRoot, outputFile);
  } else {
    await packageWithMakeself(tmpRoot, outputFile);
  }

  return { outputFile, packageName, tmpRoot, runtimeVersion: version };
};

export const resolveNodeVersion = async ({
  sourcePkg = {},
  overrideVersion
}: {
  sourcePkg?: PackageJSON;
  overrideVersion?: string;
}) => {
  if (overrideVersion) return normalizeVersion(overrideVersion);

  const response = await fetch('https://nodejs.org/dist/index.json');
  if (!response.ok) throw new Error(`Failed to fetch node versions: ${response.status}`);

  const index = (await response.json()) as Array<{ version: string }>;
  const range = sourcePkg.engines?.node;
  if (range) {
    const matched = semver.maxSatisfying(
      index.map(({ version }) => version),
      range
    );
    if (matched) return matched;
  }

  const latest = index[0]?.version;
  if (!latest) throw new Error('No node versions available from nodejs.org index');
  return latest;
};

const copyProjectFiles = async (sourceDir: string, appDir: string, sourcePkg: PackageJSON) => {
  const entries = new Set(['package.json']);
  for (const lockFile of LOCK_FILES) {
    if (await fs.pathExists(path.join(sourceDir, lockFile))) entries.add(lockFile);
  }

  const patterns = Array.isArray(sourcePkg.files) && sourcePkg.files.length > 0 ? sourcePkg.files : ['**/*'];
  for (const item of await fg(patterns, {
    cwd: sourceDir,
    dot: true,
    onlyFiles: false,
    ignore: ['.git/**', '.tmp/**', 'out/**', 'node_modules/**', 'dist/**']
  })) {
    entries.add(item);
  }

  for (const relativePath of entries) {
    const from = path.join(sourceDir, relativePath);
    if (!(await fs.pathExists(from))) continue;
    await fs.copy(from, path.join(appDir, relativePath));
  }
};

const installProductionDependencies = async (appDir: string) => {
  const installers = await resolveInstallersByLockFile(appDir);
  for (const installer of installers) {
    const runner = await resolveRunner(installer.name);
    if (!runner) {
      if (installers.length === 1) throw new Error(`${installer.name} is required for the detected lock file`);
      continue;
    }
    for (const args of installer.attempts) {
      try {
        await runCommand(runner, args, appDir);
        return;
      } catch {
        // fallback next attempt
      }
    }
  }

  throw new Error('No package manager succeeded for production dependency installation');
};

const resolveInstallersByLockFile = async (appDir: string) => {
  if (await fs.pathExists(path.join(appDir, 'pnpm-lock.yaml'))) return [INSTALLERS[0]];
  if (await fs.pathExists(path.join(appDir, 'yarn.lock'))) return [INSTALLERS[1]];
  if (
    (await fs.pathExists(path.join(appDir, 'package-lock.json'))) ||
    (await fs.pathExists(path.join(appDir, 'npm-shrinkwrap.json')))
  ) {
    return [INSTALLERS[2]];
  }
  return INSTALLERS;
};

const commandExists = async (command: string): Promise<boolean> => {
  try {
    if (process.platform === 'win32') {
      await $`where ${command}`;
    } else {
      await $`which ${command}`;
    }
    return true;
  } catch {
    return false;
  }
};

const resolveRunner = async (name: string) => {
  if (await commandExists(name)) return { command: name, args: [] as string[] };
  if ((name === 'pnpm' || name === 'yarn') && (await commandExists('corepack'))) {
    return { command: 'corepack', args: [name] };
  }
  return null;
};

const runCommand = async (
  runner: { command: string; args: string[] },
  args: readonly string[],
  cwd: string
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(runner.command, [...runner.args, ...args], { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${runner.command} failed`))));
  });

const installNodeRuntime = async ({
  version,
  runtimeDir,
  platform,
  arch
}: {
  version: string;
  runtimeDir: string;
  platform: TargetPlatform;
  arch: string;
}) => {
  const extension = platform === 'win' ? 'zip' : platform === 'darwin' ? 'tar.gz' : 'tar.xz';
  const fileName = `node-${version}-${platform}-${arch}.${extension}`;
  const archiveUrl = `https://nodejs.org/dist/${version}/${fileName}`;
  const archivePath = path.join(os.tmpdir(), fileName);

  await downloadFile(archiveUrl, archivePath);
  await fs.remove(runtimeDir);
  await fs.ensureDir(runtimeDir);
  await extractArchive({ extension, archivePath, runtimeDir, platform });

  const binaryName = platform === 'win' ? 'node.exe' : 'node';
  const distDir = path.join(runtimeDir, `node-${version}-${platform}-${arch}`);
  const preferred = platform === 'win' ? path.join(distDir, binaryName) : path.join(distDir, 'bin', binaryName);

  if (await fs.pathExists(preferred)) return preferred;

  const matches = await fg(`**/${binaryName}`, { cwd: runtimeDir, absolute: true, onlyFiles: true });
  if (!matches.length) throw new Error('Node runtime binary not found after extraction');
  matches.sort();
  return matches[0];
};

const downloadFile = async (url: string, target: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url}`);
  const content = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(target, content);
};

const extractArchive = async ({
  extension,
  archivePath,
  runtimeDir,
  platform
}: {
  extension: string;
  archivePath: string;
  runtimeDir: string;
  platform: TargetPlatform;
}) => {
  if (getExtractionCommand(extension, platform) === 'tar') {
    await $`tar -xf ${archivePath} -C ${runtimeDir}`;
    return;
  }

  if (platform === 'win' && (await commandExists('powershell'))) {
    await $`powershell -NoProfile -Command Expand-Archive -Path ${archivePath} -DestinationPath ${runtimeDir} -Force`;
    return;
  }

  if (await commandExists('python')) {
    await $`python -m zipfile -e ${archivePath} ${runtimeDir}`;
    return;
  }

  await $`unzip -q -o ${archivePath} -d ${runtimeDir}`;
};

const createLaunchers = async ({
  tmpRoot,
  sourcePkg,
  nodePath,
  platform
}: {
  tmpRoot: string;
  sourcePkg: PackageJSON;
  nodePath: string;
  platform: TargetPlatform;
}) => {
  if (!sourcePkg.bin) return;

  const entries = typeof sourcePkg.bin === 'string' ? [[sourcePkg.name || 'app', sourcePkg.bin]] : Object.entries(sourcePkg.bin);
  const nodeRelativePath = path.relative(tmpRoot, nodePath);

  for (const [name, target] of entries) {
    if (platform === 'win') {
      await fs.writeFile(
        path.join(tmpRoot, `${name}.cmd`),
        `@echo off\r\n"%~dp0\\${toWindowsPath(nodeRelativePath)}" "%~dp0\\app\\${toWindowsPath(target)}" %*\r\n`
      );
      continue;
    }

    const scriptPath = path.join(tmpRoot, name);
    await fs.writeFile(
      scriptPath,
      `#!/bin/sh\nexec "$(dirname "$0")/${toPosixPath(nodeRelativePath)}" "$(dirname "$0")/app/${toPosixPath(target)}" "$@"\n`
    );
    await fs.chmod(scriptPath, 0o755);
  }
};

const createInstallScript = async (tmpRoot: string) => {
  const scriptPath = path.join(tmpRoot, 'install.sh');
  await fs.writeFile(scriptPath, '#!/bin/sh\nset -e\nprintf "Package extracted to %s\\n" "$(pwd)"\n');
  await fs.chmod(scriptPath, 0o755);
};

const packageWithMakeself = async (tmpRoot: string, outputFile: string) => {
  const makeselfDir = path.join(os.tmpdir(), 'npm2exe-makeself');
  const makeselfPath = path.join(makeselfDir, 'makeself.sh');
  const headerPath = path.join(makeselfDir, 'makeself-header.sh');

  if (!(await fs.pathExists(makeselfPath)) || !(await fs.pathExists(headerPath))) {
    await fs.ensureDir(makeselfDir);
    await downloadFile(
      `https://raw.githubusercontent.com/megastep/makeself/${MAKSELF_COMMIT}/makeself.sh`,
      makeselfPath
    );
    await downloadFile(
      `https://raw.githubusercontent.com/megastep/makeself/${MAKSELF_COMMIT}/makeself-header.sh`,
      headerPath
    );
    await fs.chmod(makeselfPath, 0o755);
    await fs.chmod(headerPath, 0o755);
  }

  await $`${makeselfPath} --nocomp ${tmpRoot} ${outputFile} "npm2exe bundle" ./install.sh`;
};

const packageWith7Zip = async (tmpRoot: string, outputFile: string) => {
  const host7z = require('7zip-bin-full').path7z as string;
  await fs.remove(outputFile);
  await $({ cwd: tmpRoot })`${host7z} a -t7z -mx=9 -sfx ${outputFile} .`;
};
