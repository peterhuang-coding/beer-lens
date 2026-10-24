// Offline portability regression test for package-lock.json.
//
// The lockfile was generated with 48 of its 180 tarball "resolved" URLs
// pointing at the internal vendor registry (https://bnpm.byted.org), which
// the parent local TLS probe could not reach; GitHub npm ci also failed
// before business tests. The public path passed the probe and clean install.
// Every registry-resolved package must instead use the public HTTPS npm
// registry while keeping the identical tarball path, version and integrity.
//
// This test uses only Node.js built-ins and never opens a network socket, so
// it runs in a clean checkout without `npm ci` and is safe for `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR_HOST = 'bnpm.byted.org';
const PUBLIC_REGISTRY_HOST = 'registry.npmjs.org';
// 48 vendor-origin tarballs + 132 already-public tarballs when this guard
// was introduced; update intentionally if the pinned dependency set changes.
const EXPECTED_RESOLVED_COUNT = 180;

interface LockPackage {
  version?: string;
  resolved?: string;
  integrity?: string;
}

interface Lockfile {
  lockfileVersion: number;
  packages: Record<string, LockPackage>;
}

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(workspaceRoot, 'package-lock.json');

function loadLockfile(): { lock: Lockfile; raw: string } {
  const raw = readFileSync(lockPath, 'utf8');
  return { lock: JSON.parse(raw) as Lockfile, raw };
}

function resolvedEntries(lock: Lockfile): Array<[string, LockPackage]> {
  return Object.entries(lock.packages).filter(
    (entry): entry is [string, LockPackage] =>
      typeof entry[1].resolved === 'string' && entry[1].resolved !== '',
  );
}

// Lockfile keys look like "node_modules/<pkg>" or, for nested copies,
// "node_modules/<a>/node_modules/<pkg>". The tail after the final
// "/node_modules/" is the real package name; scoped packages keep their
// "@scope/name" tail.
function packageNameFromKey(key: string): string {
  const marker = 'node_modules/';
  let rest = key;
  if (rest.startsWith(marker)) {
    rest = rest.slice(marker.length);
  }
  const index = rest.lastIndexOf(`/${marker}`);
  if (index !== -1) {
    rest = rest.slice(index + `/${marker}`.length);
  }
  if (rest === key || rest.includes(marker)) {
    throw new Error(`unexpected package key (no node_modules segment): ${key}`);
  }
  return rest;
}

// Public npm registry tarball layout:
//   unscoped: /<name>/-/<name>-<version>.tgz
//   scoped:   /@<scope>/<name>/-/<name>-<version>.tgz
function expectedTarballPathname(name: string, version: string): string {
  const slash = name.indexOf('/');
  const base = slash === -1 ? name : name.slice(slash + 1);
  return `/${name}/-/${base}-${version}.tgz`;
}

test('lockfile is npm lockfileVersion 3 with a packages map', () => {
  const { lock } = loadLockfile();
  assert.equal(lock.lockfileVersion, 3);
  assert.ok(lock.packages, 'lockfile must contain a packages map');
  assert.equal(typeof lock.packages, 'object');
});

test(`all ${EXPECTED_RESOLVED_COUNT} pinned tarballs are resolved (48 fixed + 132 already public)`, () => {
  const { lock } = loadLockfile();
  assert.equal(resolvedEntries(lock).length, EXPECTED_RESOLVED_COUNT);
});

test('every resolved tarball is a portable HTTPS URL on the public npm registry', () => {
  const { lock } = loadLockfile();
  const violations: string[] = [];
  for (const [key, pkg] of resolvedEntries(lock)) {
    const resolved = pkg.resolved as string;
    let url: URL;
    try {
      url = new URL(resolved);
    } catch {
      violations.push(`${key}: unparsable resolved URL: ${resolved}`);
      continue;
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== PUBLIC_REGISTRY_HOST ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      !url.pathname.endsWith('.tgz')
    ) {
      violations.push(`${key}: ${resolved}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `non-portable resolved URLs (must all be https://${PUBLIC_REGISTRY_HOST} tarballs):\n${violations.join('\n')}`,
  );
});

test(`lockfile contains no reference to the vendor host ${VENDOR_HOST}`, () => {
  const { raw } = loadLockfile();
  assert.ok(
    !raw.includes(VENDOR_HOST),
    `package-lock.json still references the unreachable vendor host ${VENDOR_HOST}`,
  );
});

test('every tarball path preserves the package name and pinned version, including scoped packages', () => {
  const { lock } = loadLockfile();
  const violations: string[] = [];
  for (const [key, pkg] of resolvedEntries(lock)) {
    const name = packageNameFromKey(key);
    if (typeof pkg.version !== 'string' || pkg.version === '') {
      violations.push(`${key}: missing pinned version`);
      continue;
    }
    const pathname = new URL(pkg.resolved as string).pathname;
    const expected = expectedTarballPathname(name, pkg.version);
    if (pathname !== expected) {
      violations.push(`${key}: pathname ${pathname} does not match ${expected}`);
    }
    if (typeof pkg.integrity !== 'string' || !pkg.integrity.startsWith('sha512-')) {
      violations.push(`${key}: missing sha512 integrity alongside ${pathname}`);
    }
  }
  assert.deepEqual(violations, [], `tarball path/integrity violations:\n${violations.join('\n')}`);
});

test('scoped packages keep the "@scope/name/-/<base>-<version>.tgz" tarball path', () => {
  const { lock } = loadLockfile();
  const scoped = resolvedEntries(lock).filter(([key]) => packageNameFromKey(key).startsWith('@'));
  assert.ok(scoped.length > 0, 'expected scoped packages (e.g. @larksuiteoapi/node-sdk) in the lock');
  const violations: string[] = [];
  for (const [key, pkg] of scoped) {
    const name = packageNameFromKey(key);
    const match = /^@([^/]+)\/(.+)$/.exec(name);
    if (!match) {
      violations.push(`${key}: malformed scoped name ${name}`);
      continue;
    }
    const scope = match[1];
    const base = match[2];
    const expected = `/@${scope}/${base}/-/${base}-${pkg.version}.tgz`;
    const pathname = new URL(pkg.resolved as string).pathname;
    if (pathname !== expected) {
      violations.push(`${key}: ${pathname} does not preserve scoped path ${expected}`);
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('@larksuiteoapi/node-sdk@1.74.0 pins the publicly reachable tarball and unchanged integrity', () => {
  const { lock } = loadLockfile();
  const sdk = lock.packages['node_modules/@larksuiteoapi/node-sdk'];
  assert.ok(sdk, 'node_modules/@larksuiteoapi/node-sdk entry must exist');
  assert.equal(sdk.version, '1.74.0');
  // Parent probe evidence: the local vendor request failed TLS EOF while this
  // exact public-registry path returned HTTP 200.
  assert.equal(sdk.resolved, 'https://registry.npmjs.org/@larksuiteoapi/node-sdk/-/node-sdk-1.74.0.tgz');
  assert.equal(
    sdk.integrity,
    'sha512-K2WoGy6x97u2kPPSFsu0v9X8CY+0q4OwO3rhXiOSRXYjGS7ovydFpEH07AS5VYcBnbQCoc5sGezo0IEGVViuoA==',
  );
});
