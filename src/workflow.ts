import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
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
} from './utility.js';

const MAKSELF_RELEASES_URL =
  'https://api.github.com/repos/megastep/makeself/releases/latest';

const INSTALLERS = [
  {
    name: 'pnpm',
    attempts: [
      [
        'install',
        '--prod',
        '--frozen-lockfile',
        '--package-import-method=copy',
        '--node-linker=hoisted'
      ],
      [
        'install',
        '--prod',
        '--package-import-method=copy',
        '--node-linker=hoisted'
      ]
    ]
  },
  {
    name: 'yarn',
    attempts: [
      ['install', '--production', '--frozen-lockfile'],
      ['install', '--production']
    ]
  },
  { name: 'npm', attempts: [['install', '--omit=dev']] }
] as const;

interface PackProjectInput {
  projectFolder?: string;
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

export async function packProject({
  projectFolder = process.cwd(),
  targetPlatform = process.platform,
  arch = process.arch,
  nodeVersion,
  outputName
}: PackProjectInput = {}) {
  const sourceFolder = path.resolve(projectFolder);
  const sourcePkg = (await fs.readJSON(
    path.join(sourceFolder, 'package.json')
  )) as PackageJSON;
  const packageName = sourcePkg.name?.trim();

  if (!packageName) throw new Error('package.json name is required');

  const platform = normalizePlatform(targetPlatform);
  const runtimeArch = normalizeArch(arch, platform);
  const tmpRoot = path.join(sourceFolder, '.tmp/npm2exe-apps', packageName);
  const appFolder = path.join(tmpRoot, 'app');
  const runtimeFolder = path.join(tmpRoot, 'runtime');
  const outFolder = path.join(sourceFolder, 'out');

  await fs.remove(tmpRoot);
  await fs.ensureDir(appFolder);
  await fs.ensureDir(outFolder);

  await copyProjectFiles(sourceFolder, appFolder, sourcePkg);
  await installProductionDependencies(appFolder);

  const version = await resolveNodeVersion({
    sourcePkg,
    overrideVersion: nodeVersion
  });
  const nodePath = await installNodeRuntime({
    version,
    runtimeFolder,
    platform,
    arch: runtimeArch
  });

  await createLaunchers({ tmpRoot, sourcePkg, nodePath, platform });
  if (platform !== 'win') await createInstallScript(tmpRoot);

  const outputBaseName = outputName || packageName;
  const outputFile = path.join(
    outFolder,
    platform === 'win' ? `${outputBaseName}.exe` : outputBaseName
  );

  if (platform === 'win') {
    await packageWith7Zip(path.join(sourceFolder, '.tmp'), outputFile);
  } else {
    const archiveRoot = path.join(sourceFolder, '.tmp');
    const installScript = `./${toPosixPath(path.relative(archiveRoot, path.join(tmpRoot, 'install.sh')))}`;

    await packageWithMakeself(archiveRoot, outputFile, installScript);
  }
  return { outputFile, packageName, tmpRoot, runtimeVersion: version };
}

export async function resolveNodeVersion({
  sourcePkg = {},
  overrideVersion
}: {
  sourcePkg?: PackageJSON;
  overrideVersion?: string;
}) {
  if (overrideVersion) return normalizeVersion(overrideVersion);

  const response = await fetch('https://nodejs.org/dist/index.json');
  if (!response.ok)
    throw new Error(`Failed to fetch node versions: ${response.status}`);

  const index = (await response.json()) as { version: string }[];
  const range = sourcePkg.engines?.node;
  if (range) {
    const matched = semver.maxSatisfying(
      index.map(({ version }) => version),
      range
    );
    if (matched) return matched;
  }

  const latest = index[0]?.version;

  if (latest) return latest;

  throw new Error('No node versions available from nodejs.org index');
}

async function copyProjectFiles(
  sourceFolder: string,
  appFolder: string,
  sourcePkg: PackageJSON
) {
  const entries = new Set(['package.json', '.npmrc', 'pnpm-workspace.yaml']);

  for (const lockFile of LOCK_FILES)
    if (await fs.pathExists(path.join(sourceFolder, lockFile)))
      entries.add(lockFile);

  const patterns =
    Array.isArray(sourcePkg.files) && sourcePkg.files.length > 0
      ? sourcePkg.files
      : ['**/*'];
  for (const item of await fg(patterns, {
    cwd: sourceFolder,
    dot: true,
    onlyFiles: false,
    ignore: ['.git/**', '.tmp/**', 'out/**', 'node_modules/**']
  }))
    entries.add(item);

  for (const relativePath of entries) {
    const from = path.join(sourceFolder, relativePath);

    if (await fs.pathExists(from))
      await fs.copy(from, path.join(appFolder, relativePath));
  }
}

export async function installProductionDependencies(appFolder: string) {
  const installers = await resolveInstallersByLockFile(appFolder);

  for (const installer of installers) {
    const runner = await resolveRunner(installer.name);
    if (!runner) {
      if (installers.length === 1)
        throw new Error(
          `${installer.name} is required for the detected lock file`
        );
      continue;
    }
    for (const args of installer.attempts)
      try {
        await runCommand(runner, args, appFolder);
        return;
      } catch {
        // fallback next attempt
      }
  }
  throw new Error(
    'No package manager succeeded for production dependency installation'
  );
}

async function resolveInstallersByLockFile(appFolder: string) {
  if (await fs.pathExists(path.join(appFolder, 'pnpm-lock.yaml')))
    return [INSTALLERS[0]];

  if (await fs.pathExists(path.join(appFolder, 'yarn.lock')))
    return [INSTALLERS[1]];
  if (
    (await fs.pathExists(path.join(appFolder, 'package-lock.json'))) ||
    (await fs.pathExists(path.join(appFolder, 'npm-shrinkwrap.json')))
  )
    return [INSTALLERS[2]];

  return INSTALLERS;
}

async function commandExists(command: string): Promise<boolean> {
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
}

async function resolveRunner(name: string) {
  if (await commandExists(name)) return { command: name, args: [] as string[] };

  if ((name === 'pnpm' || name === 'yarn') && (await commandExists('corepack')))
    return { command: 'corepack', args: [name] };

  return null;
}

const runCommand = async (
  runner: { command: string; args: string[] },
  args: readonly string[],
  cwd: string
) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(runner.command, [...runner.args, ...args], {
      cwd,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', code =>
      code === 0 ? resolve() : reject(new Error(`${runner.command} failed`))
    );
  });

async function installNodeRuntime({
  version,
  runtimeFolder,
  platform,
  arch
}: {
  version: string;
  runtimeFolder: string;
  platform: TargetPlatform;
  arch: string;
}) {
  const extension =
    platform === 'win' ? 'zip' : platform === 'darwin' ? 'tar.gz' : 'tar.xz';
  const fileName = `node-${version}-${platform}-${arch}.${extension}`;
  const archiveUrl = `https://nodejs.org/dist/${version}/${fileName}`;
  const archivePath = path.join(os.tmpdir(), fileName);

  await downloadFile(archiveUrl, archivePath);
  await fs.remove(runtimeFolder);
  await fs.ensureDir(runtimeFolder);
  await extractArchive({ extension, archivePath, runtimeFolder, platform });

  const binaryName = platform === 'win' ? 'node.exe' : 'node';
  const distFolder = path.join(
    runtimeFolder,
    `node-${version}-${platform}-${arch}`
  );
  const preferred =
    platform === 'win'
      ? path.join(distFolder, binaryName)
      : path.join(distFolder, 'bin', binaryName);

  if (await fs.pathExists(preferred)) return preferred;

  const matches = await fg(`**/${binaryName}`, {
    cwd: runtimeFolder,
    absolute: true,
    onlyFiles: true
  });
  if (!matches.length)
    throw new Error('Node runtime binary not found after extraction');

  matches.sort();

  return matches[0];
}

async function downloadFile(url: string, target: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url}`);

  const content = Buffer.from(await response.arrayBuffer());
  await fs.outputFile(target, content);
}

async function extractArchive({
  extension,
  archivePath,
  runtimeFolder,
  platform
}: {
  extension: string;
  archivePath: string;
  runtimeFolder: string;
  platform: TargetPlatform;
}) {
  if (getExtractionCommand(extension) === 'tar')
    return $`tar -xf ${archivePath} -C ${runtimeFolder}`;

  if (platform === 'win' && (await commandExists('powershell')))
    return $`powershell -NoProfile -Command Expand-Archive -Path ${archivePath} -DestinationPath ${runtimeFolder} -Force`;

  if (await commandExists('python'))
    return $`python -m zipfile -e ${archivePath} ${runtimeFolder}`;

  await $`unzip -q -o ${archivePath} -d ${runtimeFolder}`;
}

async function createLaunchers({
  tmpRoot,
  sourcePkg,
  nodePath,
  platform
}: {
  tmpRoot: string;
  sourcePkg: PackageJSON;
  nodePath: string;
  platform: TargetPlatform;
}) {
  if (!sourcePkg.bin) return;

  const entries =
    typeof sourcePkg.bin === 'string'
      ? [[sourcePkg.name || 'app', sourcePkg.bin]]
      : Object.entries(sourcePkg.bin);
  const archiveRoot = path.join(tmpRoot, '../..');
  const nodeRelativePath = path.relative(archiveRoot, nodePath);
  const nodeModulesRelativePath = path.relative(
    archiveRoot,
    path.join(tmpRoot, 'app/node_modules')
  );
  const runtimeBinRelativePath = path.relative(
    archiveRoot,
    path.dirname(nodePath)
  );

  for (const [name, target] of entries) {
    const targetRelativePath = path.relative(
      archiveRoot,
      path.join(tmpRoot, 'app', target)
    );

    if (platform === 'win') {
      await fs.outputFile(
        path.join(archiveRoot, `${name}.cmd`),
        `@echo off
set "PATH=%~dp0${toWindowsPath(runtimeBinRelativePath)};%PATH%"
set "NODE_PATH=%~dp0${toWindowsPath(nodeModulesRelativePath)};%NODE_PATH%"
"%~dp0${toWindowsPath(nodeRelativePath)}" "%~dp0${toWindowsPath(targetRelativePath)}" %*
`.replace(/\n/g, '\r\n')
      );
      continue;
    }

    const scriptPath = path.join(archiveRoot, name);
    await fs.outputFile(
      scriptPath,
      `#!/bin/sh
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export PATH="$ROOT_DIR/${toPosixPath(runtimeBinRelativePath)}:$PATH"
export NODE_PATH="$ROOT_DIR/${toPosixPath(nodeModulesRelativePath)}\${NODE_PATH:+:$NODE_PATH}"
exec "$ROOT_DIR/${toPosixPath(nodeRelativePath)}" "$ROOT_DIR/${toPosixPath(targetRelativePath)}" "$@"
`
    );
    await fs.chmod(scriptPath, 0o755);
  }
}

async function createInstallScript(tmpRoot: string) {
  const scriptPath = path.join(tmpRoot, 'install.sh');
  await fs.outputFile(
    scriptPath,
    `#!/bin/sh
set -e
printf "Package extracted to %s\\n" "$(pwd)"
`
  );
  await fs.chmod(scriptPath, 0o755);
}

async function installMakeself() {
  const makeselfFolder = path.join(os.tmpdir(), 'npm2exe-makeself');
  const makeselfPath = path.join(makeselfFolder, 'makeself.sh');

  await fs.ensureDir(makeselfFolder);

  const response = await fetch(MAKSELF_RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json' }
  });
  if (!response.ok)
    throw new Error(`Failed to fetch Makeself release: ${response.status}`);

  const release = (await response.json()) as {
    assets?: Record<'name' | 'browser_download_url', string>[];
  };
  const asset = release.assets?.find(({ name }) =>
    /^makeself-.+\.run$/.test(name)
  );
  if (!asset) throw new Error('Makeself release .run asset not found');

  const archivePath = path.join(os.tmpdir(), asset.name);

  await downloadFile(asset.browser_download_url, archivePath);
  await fs.chmod(archivePath, 0o755);
  await $`${archivePath} --noexec --target ${makeselfFolder}`;

  return makeselfPath;
}

async function packageWithMakeself(
  tmpRoot: string,
  outputFile: string,
  installScript: string
) {
  const makeselfFolder = path.join(os.tmpdir(), 'npm2exe-makeself');
  const makeselfPath = path.join(makeselfFolder, 'makeself.sh');
  const headerPath = path.join(makeselfFolder, 'makeself-header.sh');

  if (
    !(await fs.pathExists(makeselfPath)) ||
    !(await fs.pathExists(headerPath))
  )
    await installMakeself();

  await $`${makeselfPath} --nocomp --target '$HOME' ${tmpRoot} ${outputFile} "npm2exe bundle" ${installScript}`;
}

async function packageWith7Zip(tmpRoot: string, outputFile: string) {
  const { path7z } = await import('7zip-bin-full');
  const sfxConfigPath = path.join(os.tmpdir(), 'npm2exe-sfx-config.txt');

  await fs.outputFile(
    sfxConfigPath,
    `;!@Install@!UTF-8!
InstallPath="%USERPROFILE%"
;!@InstallEnd@!
`
  );
  await fs.remove(outputFile);
  await $({
    cwd: tmpRoot
  })`${path7z} a -t7z -mx=9 -sfx -sfxconfig ${sfxConfigPath} ${outputFile} .`;
}
