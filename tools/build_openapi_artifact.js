import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const specPath = path.resolve(repoRoot, 'iot-cmp-api.yaml');
const openapiPackageDir = path.resolve(repoRoot, 'packages', 'openapi');
const openapitoolsPath = path.resolve(repoRoot, 'openapitools.json');

await mkdir(openapiPackageDir, { recursive: true });

const yamlContent = await readFile(specPath, 'utf8');
await writeFile(path.resolve(openapiPackageDir, 'openapi.yaml'), yamlContent);

const parsed = YAML.parse(yamlContent);
await writeFile(
  path.resolve(openapiPackageDir, 'openapi.json'),
  JSON.stringify(parsed, null, 2)
);

await copyFile(openapitoolsPath, path.resolve(openapiPackageDir, 'openapitools.json'));
