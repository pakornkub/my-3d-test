// dev-all.mjs -- run the Vite dev server and the Office Server side by side, one terminal.
// No `concurrently` dependency: two child processes, both killed together on Ctrl+C.

import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const procs = [
  spawn(npm, ['run', 'office'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn(npm, ['run', 'dev', '--', '--port', '5180', '--strictPort'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];
const stop = () => { for (const p of procs) if (!p.killed) p.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code && code !== 0) stop(); });
