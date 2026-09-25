import { $ } from 'zx';
import fg from 'fast-glob';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

const LOCK_FILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json'];
const MAKESELF_COMMIT = '9f5fd3f77eea3f5e262745c0f3899d761a5fd5f7';
const INSTALLERS = [
  {
    name: 'pnpm',
    attempts: [
      ['install', '--prod', '--frozen-lockfile', '--package-import-method=copy'],
      ['install', '--prod', '--package-import-method=copy']
    ]
  },
  {
    name: 'yarn',
    attempts: [
      ['install', '--production', '--frozen-lockfile'],
      ['install', '--production']
    ]
  },
  {
    name: 'npm',
    attempts: [['install', '--omit=dev']]
  }
];

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  await packProject(options);
}

export async function packProject({
  projectDir = process.cwd(),
  arch = process.arch,
  targetPlatform = process.platform,
  nodeVersion,
  outputName
} = {}) {
  const sourceDir = path.resolve(projectDir);
  const sourcePkg = await readPackageJson(sourceDir);
  const packageName = sourcePkg.name?.trim();

  if (!packageName) {
    throw new Error('package.json name is required');
  }

  const tmpRoot = path.join(sourceDir, '.tmp', packageName);
  const appDir = path.join(tmpRoot, 'app');
  const runtimeDir = path.join(tmpRoot, 'runtime');
  const outDir = path.join(sourceDir, 'out');
  const normalizedPlatform = normalizePlatform(targetPlatform);

  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  await copyProjectFiles({ sourceDir, appDir, sourcePkg });
  await installProductionDependencies(appDir);

  const resolvedVersion = await resolveNodeVersion({
    sourcePkg,
    overrideVersion: nodeVersion
  });
  const { extractedNodePath } = await installNodeRuntime({
    version: resolvedVersion,
    runtimeDir,
    arch: normalizeArch(arch, normalizedPlatform),
    targetPlatform: normalizedPlatform
  });

  await createLaunchers({ tmpRoot, sourcePkg, extractedNodePath, targetPlatform: normalizedPlatform });
  await createPosixInstallScript(tmpRoot);

  const outputBaseName = outputName || packageName;
  const outputFile = path.join(
    outDir,
    normalizedPlatform === 'win' ? `${outputBaseName}.exe` : outputBaseName
  );

  if (normalizedPlatform === 'win') {
    await packageWith7Zip(tmpRoot, outputFile);
  } else {
    await packageWithMakeself(tmpRoot, outputFile);
  }

  return { packageName, outputFile, tmpRoot, runtimeVersion: resolvedVersion };
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--project') {
      options.projectDir = args[++i];
    } else if (arg === '--arch') {
      options.arch = args[++i];
    } else if (arg === '--node-version') {
      options.nodeVersion = args[++i];
    } else if (arg === '--output') {
      options.outputName = args[++i];
    } else if (arg === '--platform') {
      options.targetPlatform = args[++i];
    }
  }
  return options;
}

async function readPackageJson(projectDir) {
  const packageJsonPath = path.join(projectDir, 'package.json');
  const pkgRaw = await readFile(packageJsonPath, 'utf8');
  return JSON.parse(pkgRaw);
}

async function copyProjectFiles({ sourceDir, appDir, sourcePkg }) {
  const entries = new Set(['package.json']);
  for (const lockFile of LOCK_FILES) {
    if (await pathExists(path.join(sourceDir, lockFile))) {
      entries.add(lockFile);
    }
  }

  const filePatterns = Array.isArray(sourcePkg.files) ? sourcePkg.files : [];
  const matchedFiles = await fg(filePatterns, {
    cwd: sourceDir,
    dot: true,
    onlyFiles: false,
    unique: true,
    ignore: ['.tmp/**', 'out/**', 'node_modules/**']
  });
  for (const file of matchedFiles) {
    entries.add(file);
  }

  for (const relativePath of entries) {
    const absoluteSource = path.join(sourceDir, relativePath);
    if (!(await pathExists(absoluteSource))) {
      continue;
    }
    const absoluteTarget = path.join(appDir, relativePath);
    await mkdir(path.dirname(absoluteTarget), { recursive: true });
    const sourceStats = await stat(absoluteSource);
    await cp(absoluteSource, absoluteTarget, { recursive: sourceStats.isDirectory() });
  }
}

async function installProductionDependencies(appDir) {
  const installers = await resolveInstallersByLockFile(appDir);
  for (const installer of installers) {
    const runner = await resolveInstallerRunner(installer.name);
    if (!runner) {
      if (installers.length === 1) {
        throw new Error(`${installer.name} is required for the detected lock file`);
      }
      continue;
    }
    for (const args of installer.attempts) {
      try {
        await runCommand(appDir, runner, args);
        return;
      } catch {
        // continue fallback attempts for this package manager
      }
    }
  }
  throw new Error('No package manager succeeded for production dependency installation');
}

export async function resolveNodeVersion({ sourcePkg = {}, overrideVersion } = {}) {
  if (overrideVersion) {
    return normalizeVersion(overrideVersion);
  }
  const index = await fetchNodeIndex();
  const range = sourcePkg?.engines?.node;
  if (range) {
    const versions = index.map((entry) => entry.version);
    const matched = semver.maxSatisfying(versions, range);
    if (matched) {
      return matched;
    }
  }
  const latestVersion = index[0]?.version;
  if (!latestVersion) {
    throw new Error('No node versions available from nodejs.org index');
  }
  return latestVersion;
}

async function installNodeRuntime({ version, runtimeDir, arch, targetPlatform }) {
  const platform = targetPlatform;
  const extension = platform === 'win' ? 'zip' : platform === 'darwin' ? 'tar.gz' : 'tar.xz';
  const fileName = `node-${version}-${platform}-${arch}.${extension}`;
  const distDirName = `node-${version}-${platform}-${arch}`;
  const archiveUrl = `https://nodejs.org/dist/${version}/${fileName}`;
  const archivePath = path.join(os.tmpdir(), fileName);

  await downloadFile(archiveUrl, archivePath);
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });

  await extractArchive({ extension, archivePath, runtimeDir });

  const extractedNodePath = await resolveNodeExecutablePath(runtimeDir, distDirName, platform);
  return { archivePath, extractedNodePath };
}

async function createLaunchers({ tmpRoot, sourcePkg, extractedNodePath, targetPlatform }) {
  const binField = sourcePkg.bin;
  if (!binField) {
    return;
  }

  const binEntries =
    typeof binField === 'string'
      ? [[sourcePkg.name, binField]]
      : Object.entries(binField);

  const nodeRelativePath = path.relative(tmpRoot, extractedNodePath);
  for (const [name, target] of binEntries) {
    if (targetPlatform === 'win') {
      const scriptPath = path.join(tmpRoot, `${name}.cmd`);
      const cmdContent = `@echo off\r\n"%~dp0\\${normalizeToWindows(nodeRelativePath)}" "%~dp0\\app\\${normalizeToWindows(target)}" %*\r\n`;
      await writeFile(scriptPath, cmdContent, 'utf8');
    } else {
      const scriptPath = path.join(tmpRoot, name);
      const shContent = `#!/bin/sh\nexec "$(dirname "$0")/${toPosixPath(path.relative(tmpRoot, extractedNodePath))}" "$(dirname "$0")/app/${toPosixPath(target)}" "$@"\n`;
      await writeFile(scriptPath, shContent, 'utf8');
      await chmod(scriptPath, 0o755);
    }
  }
}

async function createPosixInstallScript(tmpRoot) {
  if (process.platform === 'win32') {
    return;
  }
  const installScriptPath = path.join(tmpRoot, 'install.sh');
  await writeFile(
    installScriptPath,
    '#!/bin/sh\nset -e\nprintf "Package extracted to %s\\n" "$(pwd)"\n',
    'utf8'
  );
  await chmod(installScriptPath, 0o755);
}

async function packageWithMakeself(tmpRoot, outputFile) {
  const makeselfDir = path.join(os.tmpdir(), 'pack-js-makeself');
  const makeselfPath = path.join(makeselfDir, 'makeself.sh');
  const headerPath = path.join(makeselfDir, 'makeself-header.sh');

  if (!(await pathExists(makeselfPath)) || !(await pathExists(headerPath))) {
    await mkdir(makeselfDir, { recursive: true });
    await downloadFile(
      `https://raw.githubusercontent.com/megastep/makeself/${MAKESELF_COMMIT}/makeself.sh`,
      makeselfPath
    );
    await downloadFile(
      `https://raw.githubusercontent.com/megastep/makeself/${MAKESELF_COMMIT}/makeself-header.sh`,
      headerPath
    );
    await chmod(makeselfPath, 0o755);
    await chmod(headerPath, 0o755);
  }

  await $`${makeselfPath} --target \\$HOME --nocomp ${tmpRoot} ${outputFile} "Pack-JS archive" ./install.sh`;
}

async function packageWith7Zip(tmpRoot, outputFile) {
  const sevenZipArchive = path.join(os.tmpdir(), `${path.basename(outputFile)}.7z`);
  await rm(sevenZipArchive, { force: true });
  await $({ cwd: tmpRoot })`7z a -t7z -mx=9 ${sevenZipArchive} .`;

  const sfxPath =
    (await findExistingPath([
      'C:/Program Files/7-Zip/7z.sfx',
      'C:/Program Files/7-Zip/7zSD.sfx',
      'C:/Program Files (x86)/7-Zip/7z.sfx',
      'C:/Program Files (x86)/7-Zip/7zSD.sfx'
    ])) || '';

  if (!sfxPath) {
    throw new Error('7-Zip SFX module not found');
  }

  const configPath = `${outputFile}.txt`;
  await writeFile(
    configPath,
    ';!@Install@!UTF-8!\nTitle="Pack-JS"\nInstallPath="%HOMEDRIVE%%HOMEPATH%"\nGUIMode="1"\n;!@InstallEnd@!',
    'utf8'
  );
  await $`cmd /c copy /b ${sfxPath} + ${configPath} + ${sevenZipArchive} ${outputFile}`;
  await rm(sevenZipArchive, { force: true });
  await rm(configPath, { force: true });
}

async function fetchNodeIndex() {
  const response = await fetch('https://nodejs.org/dist/index.json');
  if (!response.ok) {
    throw new Error(`Failed to fetch node versions: ${response.status}`);
  }
  return response.json();
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${url}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, data);
}

async function resolveNodeExecutablePath(runtimeDir, distDirName, platform) {
  const binaryName = platform === 'win' ? 'node.exe' : 'node';
  const expected = distDirName
    ? path.join(
        runtimeDir,
        distDirName,
        ...(platform === 'win' ? [binaryName] : ['bin', binaryName])
      )
    : null;

  if (expected && (await pathExists(expected))) {
    return expected;
  }

  const candidates = await fg(`**/${binaryName}`, { cwd: runtimeDir, absolute: true, onlyFiles: true });
  if (!candidates.length) {
    throw new Error('Node binary not found in extracted runtime');
  }
  candidates.sort();
  return candidates[0];
}

function normalizeVersion(version) {
  return version.startsWith('v') ? version : `v${version}`;
}

function normalizePlatform(platform) {
  if (platform === 'win32' || platform === 'win') return 'win';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  throw new Error(`Unsupported platform: ${platform}`);
}

function normalizeArch(arch, targetPlatform) {
  if (arch === 'x64' || arch === 'arm64') {
    return arch;
  }
  if (arch === 'arm') {
    return 'armv7l';
  }
  if (arch === 'x86') {
    if (targetPlatform !== 'win') {
      throw new Error('x86 is only supported for Windows targets');
    }
    return arch;
  }
  if (arch === 'ia32') {
    if (targetPlatform !== 'win') {
      throw new Error('ia32 is only supported for Windows targets');
    }
    return 'x86';
  }
  throw new Error(`Unsupported architecture: ${arch}`);
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function normalizeToWindows(filePath) {
  return filePath.replaceAll('/', '\\');
}

export function getExtractionCommand(extension, platform) {
  if (extension === 'zip' && platform === 'win32') {
    return 'powershell-zip';
  }
  if (extension === 'zip') {
    return 'python-zip';
  }
  return 'tar';
}

async function extractArchive({ extension, archivePath, runtimeDir }) {
  const extraction = getExtractionCommand(extension, process.platform);
  if (extraction === 'powershell-zip') {
    await $`powershell -NoProfile -Command Expand-Archive -Path ${archivePath} -DestinationPath ${runtimeDir} -Force`;
    return;
  }
  if (extraction === 'python-zip') {
    if (await commandExists('python')) {
      await $`python -m zipfile -e ${archivePath} ${runtimeDir}`;
      return;
    }
    if (await commandExists('unzip')) {
      await $`unzip -q -o ${archivePath} -d ${runtimeDir}`;
      return;
    }
    throw new Error('ZIP extraction requires python or unzip');
  }
  if (!(await commandExists('tar'))) {
    throw new Error('tar is required for extracting node runtime archives');
  }
  await $`tar -xf ${archivePath} -C ${runtimeDir}`;
}

async function commandExists(command) {
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

async function resolveInstallersByLockFile(appDir) {
  if (await pathExists(path.join(appDir, 'pnpm-lock.yaml'))) {
    return [INSTALLERS[0]];
  }
  if (await pathExists(path.join(appDir, 'yarn.lock'))) {
    return [INSTALLERS[1]];
  }
  if (
    (await pathExists(path.join(appDir, 'package-lock.json'))) ||
    (await pathExists(path.join(appDir, 'npm-shrinkwrap.json')))
  ) {
    return [INSTALLERS[2]];
  }
  return INSTALLERS;
}

async function resolveInstallerRunner(name) {
  if (await commandExists(name)) {
    return { useCorepack: false, name };
  }
  if ((name === 'pnpm' || name === 'yarn') && (await commandExists('corepack'))) {
    return { useCorepack: true, name };
  }
  return null;
}

async function runCommand(cwd, runner, args) {
  const command = runner.useCorepack ? 'corepack' : runner.name;
  const commandArgs = runner.useCorepack ? [runner.name, ...args] : args;
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed: ${command} ${commandArgs.join(' ')}`));
    });
  });
}

async function findExistingPath(paths) {
  for (const entry of paths) {
    if (await pathExists(entry)) {
      return entry;
    }
  }
  return null;
}

async function pathExists(entryPath) {
  try {
    await stat(entryPath);
    return true;
  } catch {
    return false;
  }
}

export async function readDirectoryFlat(dir) {
  return readdir(dir);
}
