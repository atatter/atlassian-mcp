// Scans every file Git would commit (tracked and untracked, minus ignored) for credentials and
// private local paths. A pattern scan catches common mistakes only; it is not a guarantee.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PATTERNS: [string, RegExp][] = [
  ['Atlassian API token', /ATATT[\w=-]{20,}/],
  ['Basic auth credentials', /Basic (?=[A-Za-z]*[0-9+/=])[A-Za-z0-9+/]{20,}={0,2}/],
  ['Bearer token', /Bearer [\w.~+/-]{20,}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Local home directory path', /\/(Users|home)\/[a-z][\w.-]*\//i],
];

const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .split('\0')
  // Staged files can be missing from disk; only what's there can be committed as is.
  .filter((file) => file !== '' && existsSync(file));

const findings = files.flatMap((file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      PATTERNS.filter(([, pattern]) => pattern.test(line)).map(
        ([name]) => `${file}:${index + 1}: ${name}`,
      ),
    ),
);

if (findings.length > 0) {
  console.error(`Possible secrets or private data:\n${findings.join('\n')}`);
  process.exit(1);
}

console.log(`No secrets found in ${files.length} files.`);
