// Checks what `npm pack` would publish: the built CLI and public docs only. Run after `pnpm build`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as z from 'zod';

const Pack = z.tuple([z.object({ files: z.array(z.object({ path: z.string() })) })]);
const [{ files }] = Pack.parse(
  JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
  ),
);

const paths = files.map((file) => file.path);
const unexpected = paths.filter(
  (path) =>
    !['package.json', 'README.md', 'LICENSE'].includes(path) &&
    !/^dist\/(?!.*\.test\.js$).+\.js$/.test(path),
);

const cli = paths.includes('dist/cli.js') ? readFileSync('dist/cli.js', 'utf8') : undefined;
const problems = [
  ...unexpected.map((path) => `unexpected file: ${path}`),
  ...(cli === undefined ? ['dist/cli.js is missing'] : []),
  ...(cli !== undefined && !cli.startsWith('#!/usr/bin/env node\n')
    ? ['dist/cli.js has no shebang']
    : []),
];

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}

console.log(`Package contents look right: ${paths.length} files.`);
