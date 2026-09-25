import path from 'node:path';
import { existsSync } from 'node:fs';
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

console.log(`Packed self to ${result.outputFile}`);
