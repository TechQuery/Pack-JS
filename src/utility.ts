import path from 'node:path';

export type TargetPlatform = 'linux' | 'darwin' | 'win';

export const LOCK_FILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json'];

export const normalizePlatform = (platform: string): TargetPlatform => {
  if (platform === 'win32' || platform === 'win') return 'win';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  throw new Error(`Unsupported platform: ${platform}`);
};

export const normalizeArch = (arch: string, platform: TargetPlatform): string => {
  if (arch === 'x64' || arch === 'arm64') return arch;
  if (arch === 'arm') return 'armv7l';
  if (arch === 'ia32' || arch === 'x86') {
    if (platform !== 'win') throw new Error(`${arch} is only supported for Windows targets`);
    return 'x86';
  }
  throw new Error(`Unsupported architecture: ${arch}`);
};

export const normalizeVersion = (version: string): string => (version.startsWith('v') ? version : `v${version}`);

export const toPosixPath = (filePath: string): string => filePath.split(path.sep).join('/');

export const toWindowsPath = (filePath: string): string => filePath.replaceAll('/', '\\');

export const getExtractionCommand = (extension: string): 'zip' | 'tar' =>
  extension === 'zip' ? 'zip' : 'tar';
