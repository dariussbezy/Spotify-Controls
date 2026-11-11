import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const cli = resolve('node_modules/@valenced/plugin-cli/bin/valenced-plugin.js');
function run(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Valenced CLI failed');
}
run('build', '--plugins-dir', 'plugins');
const manifest = fs.readFileSync('plugins/SPC/manifest.json');
const { id, version } = JSON.parse(manifest);
fs.mkdirSync('pool', { recursive: true });
fs.writeFileSync(`pool/${id}@${version}.zip`, zipSync({
  'manifest.json': manifest, 'index.js': fs.readFileSync('plugins/SPC/build/js/index.js'),
}, { level: 9 }));
run('generate-index', '--dist', 'pool', '--base-url',
  'https://raw.githubusercontent.com/dariussbezy/Spotify-Controls/refs/heads/main/pool', '--out', 'index.json');
