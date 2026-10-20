// Post-build step: emit dist/index.html from the static shell
// (cortex-app-image/index.html), pointing at the content-hashed bundle
// webpack just wrote. Run after webpack in `npm run build`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(dir, '../cortex-app-image/dist');
const shell = readFileSync(path.resolve(dir, '../cortex-app-image/index.html'), 'utf8');
const bundle = readdirSync(dist).find((f) => /^app-bundle\.[0-9a-f]+\.js$/.test(f));
if (!bundle) throw new Error('hashed app-bundle.*.js not found in dist/');
writeFileSync(
  path.join(dist, 'index.html'),
  shell.replace('/app-bundle.js', `/${bundle}`),
);
console.log(`index.html -> /${bundle}`);
