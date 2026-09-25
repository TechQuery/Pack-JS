#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Command } from 'commander-jsx';
import { packProject } from './workflow.js';

export const runCli = async (argv = process.argv.slice(2)) =>
  Command.execute(
    <Command
      name="npm2exe"
      parameters="[projectDir]"
      description="Pack an npm bin project into a self-extracting portable bundle"
      options={{
        platform: {
          parameters: '<platform>',
          description: 'Target platform: linux|darwin|win|win32'
        },
        arch: {
          parameters: '<arch>',
          description: 'Target architecture: x64|arm64|arm|x86|ia32'
        },
        output: {
          parameters: '<name>',
          description: 'Output file base name'
        },
        'node-version': {
          parameters: '<version>',
          description: 'Node.js runtime version override'
        }
      }}
      executor={async (options, projectDir = '.') => {
        const project = typeof projectDir === 'string' ? projectDir : '.';
        await packProject({
          projectDir: path.resolve(project),
          targetPlatform: typeof options.platform === 'string' ? options.platform : undefined,
          arch: typeof options.arch === 'string' ? options.arch : undefined,
          outputName: typeof options.output === 'string' ? options.output : undefined,
          nodeVersion: typeof options['node-version'] === 'string' ? options['node-version'] : undefined
        });
      }}
    />,
    argv
  );

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await runCli();
}
