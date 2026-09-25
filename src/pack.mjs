import { $ } from 'zx';
import fg from 'fast-glob';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

const LOCK_FILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json'];
const MAKESELF_COMMIT = '9f5fd3f77eea3f5e262745c0f3899d761a5fd5f7';
const INSTALLERS = [
  { name: 'pnpm', cmd: ['install', '--prod', '--frozen-lockfile'] },
  { name: 'yarn', cmd: ['install', '--production', '--frozen-lockfile'] },
  { name: 'npm', cmd: ['install', '--omit=dev'] }
];

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  await packProject(options);
}

export async function packProject({
  projectDir = process.cwd(),
  arch = process.arch,
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

  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  await copyProjectFiles({ sourceDir, appDir, sourcePkg });
  await installProductionDependencies(appDir);

  const resolvedVersion = await resolveNodeVersion(sourcePkg, nodeVersion);
  const { extractedNodePath } = await installNodeRuntime({
    version: resolvedVersion,
    runtimeDir,
    arch: normalizeArch(arch)
  });

  await createLaunchers({ tmpRoot, sourcePkg, extractedNodePath });
  await createPosixInstallScript(tmpRoot);

  const outputBaseName = outputName || packageName;
  const outputFile = path.join(
    outDir,
    process.platform === 'win32' ? `${outputBaseName}.exe` : outputBaseName
  );

  if (process.platform === 'win32') {
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
  for (const installer of INSTALLERS) {
    if (!(await commandExists(installer.name))) {
      continue;
    }
    try {
      await $({ cwd: appDir })`${installer.name} ${installer.cmd}`;
      return;
    } catch {
      // continue fallback installers
    }
  }
  throw new Error('No package manager succeeded for production dependency installation');
}

async function resolveNodeVersion(sourcePkg, overrideVersion) {
  const index = await fetchNodeIndex();
  if (overrideVersion) {
    return normalizeVersion(overrideVersion);
  }
  const range = sourcePkg?.engines?.node;
  if (range) {
    const versions = index.map((entry) => entry.version);
    const matched = semver.maxSatisfying(versions, range);
    if (matched) {
      return matched;
    }
  }
  return index[0]?.version;
}

async function installNodeRuntime({ version, runtimeDir, arch }) {
  const platform = normalizePlatform(process.platform);
  const extension = platform === 'win' ? 'zip' : platform === 'darwin' ? 'tar.gz' : 'tar.xz';
  const fileName = `node-${version}-${platform}-${arch}.${extension}`;
  const archiveUrl = `https://nodejs.org/dist/${version}/${fileName}`;
  const archivePath = path.join(os.tmpdir(), fileName);

  await downloadFile(archiveUrl, archivePath);
  await rm(runtimeDir, { recursive: true, force: true });
  await mkdir(runtimeDir, { recursive: true });

  if (extension === 'zip') {
    await $`python -m zipfile -e ${archivePath} ${runtimeDir}`;
  } else {
    await $`tar -xf ${archivePath} -C ${runtimeDir}`;
  }

  const extractedNodePath = await findNodeExecutable(runtimeDir, platform);
  return { archivePath, extractedNodePath };
}

async function createLaunchers({ tmpRoot, sourcePkg, extractedNodePath }) {
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
    if (process.platform === 'win32') {
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

  await $`${makeselfPath} --target ~ --nocomp ${tmpRoot} ${outputFile} "Pack-JS archive" ./install.sh`;
}

async function packageWith7Zip(tmpRoot, outputFile) {
  const sevenZipArchive = `${outputFile}.7z`;
  await $({ cwd: tmpRoot })`7z a -t7z -mx=9 ${sevenZipArchive} .`;

  const sfxPath =
    (await findExistingPath([
      'C:/Program Files/7-Zip/7z.sfx',
      'C:/Program Files/7-Zip/7zSD.sfx'
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

async function findNodeExecutable(runtimeDir, platform) {
  const binaryName = platform === 'win' ? 'node.exe' : 'node';
  const candidates = await fg(`**/${binaryName}`, { cwd: runtimeDir, absolute: true, onlyFiles: true });
  if (!candidates.length) {
    throw new Error('Node binary not found in extracted runtime');
  }
  return candidates[0];
}

function normalizeVersion(version) {
  return version.startsWith('v') ? version : `v${version}`;
}

function normalizePlatform(platform) {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

function normalizeArch(arch) {
  if (arch === 'x64' || arch === 'arm64') {
    return arch;
  }
  if (arch === 'ia32') {
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
