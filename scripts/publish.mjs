// publish.mjs -- build and push dist/ to the gh-pages branch.
//
// Deliberately does NOT use the Pages REST API: creating a Pages site needs a permission
// the Actions GITHUB_TOKEN does not have on this repo, and a plain branch push does not.
// Works the same from a laptop (`npm run deploy`) and from CI.
//
// The Pages source has to be set once, by hand:
//   Settings -> Pages -> Build and deployment -> Deploy from a branch -> gh-pages / (root)

import { execSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' });
const out = (cmd, cwd = root) => execSync(cmd, { cwd }).toString().trim();

const repo = process.env.GITHUB_REPOSITORY
  ? `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`
  : out('git remote get-url origin');
const sha = out('git rev-parse --short HEAD');
const name = process.env.GITHUB_ACTOR ?? out('git config user.name');
const email = process.env.GITHUB_ACTOR
  ? 'github-actions[bot]@users.noreply.github.com'
  : out('git config user.email');

console.log('building for /my-3d-test/ ...');
run('npm run build', root);

if (!existsSync(resolve(dist, 'index.html'))) throw new Error('build produced no dist/index.html');
writeFileSync(resolve(dist, '.nojekyll'), '');       // keep _-prefixed paths servable

console.log('publishing dist/ to gh-pages ...');
rmSync(resolve(dist, '.git'), { recursive: true, force: true });
run('git init -q -b gh-pages', dist);
run(`git -c user.name="${name}" -c user.email="${email}" add -A`, dist);
run(`git -c user.name="${name}" -c user.email="${email}" commit -q -m "Deploy ${sha}"`, dist);
run(`git push -q -f "${repo}" gh-pages:gh-pages`, dist);
rmSync(resolve(dist, '.git'), { recursive: true, force: true });

console.log('done -> https://pakornkub.github.io/my-3d-test/');
