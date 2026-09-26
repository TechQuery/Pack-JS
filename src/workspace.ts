import path from 'node:path';
import { fs } from 'zx';
import fg from 'fast-glob';
import ignore from 'ignore';
import { toPosixPath } from './utility.js';

interface PackageJSON {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: unknown;
}

interface StageWorkspacePackageInput {
  sourceFolder: string;
  sourcePkg: PackageJSON;
  appFolder: string;
  installProductionDependencies(appFolder: string): Promise<void>;
}

const WORKSPACE_PROTOCOL = 'workspace:';
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
] as const;

export async function stageWorkspacePackage({
  sourceFolder,
  sourcePkg,
  appFolder,
  installProductionDependencies
}: StageWorkspacePackageInput) {
  if (!hasWorkspaceProtocolDependency(sourcePkg)) return null;

  const workspaceRoot = await findWorkspaceRoot(sourceFolder);
  if (!workspaceRoot)
    throw new Error(
      'Detected `workspace:` dependencies but no workspace root was found'
    );

  const relativePackagePath = path.relative(workspaceRoot, sourceFolder);
  const workspacePkg = (await fs.readJSON(
    path.join(workspaceRoot, 'package.json')
  )) as PackageJSON;
  const workspaceName = workspacePkg.name?.trim() || path.basename(workspaceRoot);
  const workspaceTempRoot = path.join(sourceFolder, '.temp', workspaceName);

  await fs.remove(workspaceTempRoot);
  await fs.remove(appFolder);
  await fs.ensureDir(path.dirname(appFolder));
  await copyWorkspaceFiles(workspaceRoot, workspaceTempRoot);
  await installProductionDependencies(workspaceTempRoot);
  await fs.move(workspaceTempRoot, appFolder, { overwrite: true });

  return { appBasePath: relativePackagePath };
}

function hasWorkspaceProtocolDependency(pkg: PackageJSON) {
  return DEPENDENCY_FIELDS.some(field =>
    Object.values(pkg[field] || {}).some(version =>
      version.startsWith(WORKSPACE_PROTOCOL)
    )
  );
}

async function findWorkspaceRoot(sourceFolder: string) {
  let current = sourceFolder;

  while (true) {
    if (await fs.pathExists(path.join(current, 'pnpm-workspace.yaml')))
      return current;

    const packageJSONPath = path.join(current, 'package.json');

    if (await fs.pathExists(packageJSONPath)) {
      const currentPkg = (await fs.readJSON(packageJSONPath)) as PackageJSON;

      if (currentPkg.workspaces) return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;

    current = parent;
  }
}

async function copyWorkspaceFiles(sourceFolder: string, targetFolder: string) {
  const matcher = await createGitIgnoreMatcher(sourceFolder);
  const relativePaths = await fg('**/*', {
    cwd: sourceFolder,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    ignore: [
      '.git/**',
      '.temp/**',
      'out/**',
      'node_modules/**',
      '**/.temp/**',
      '**/out/**',
      '**/node_modules/**'
    ]
  });

  for (const relativePath of relativePaths) {
    const from = path.join(sourceFolder, relativePath);
    const stats = await fs.lstat(from);
    const normalizedPath = toPosixPath(relativePath);
    const to = path.join(targetFolder, relativePath);

    if (matcher.ignores(stats.isDirectory() ? `${normalizedPath}/` : normalizedPath))
      continue;

    if (stats.isDirectory()) {
      await fs.ensureDir(to);
      continue;
    }

    await fs.copy(from, to);
  }
}

async function createGitIgnoreMatcher(sourceFolder: string) {
  const matcher = ignore();
  const gitIgnorePath = path.join(sourceFolder, '.gitignore');

  if (await fs.pathExists(gitIgnorePath))
    matcher.add(await fs.readFile(gitIgnorePath, 'utf8'));

  return matcher;
}
