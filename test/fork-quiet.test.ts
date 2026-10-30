/**
 * The fork's defaults: no npm update check or nudge, no `upgrade` over a source
 * checkout, no cloud sign-in line while the cloud is off, and no savings tally in
 * the skill under GRAFT_NO_SAVINGS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatUpdateNudge, maybeRefreshInBackground, updateCachePath } from '../src/upkeep.js';
import { sourceCheckoutRoot } from '../src/cli-meta.js';
import { teamSignInLine } from '../src/cloud/team-file.js';
import { skillTemplate } from '../src/claude/skill-template.js';

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('no update nudge unless GRAFT_UPDATE_CHECK=1', () => {
  assert.equal(formatUpdateNudge('0.9.1', '0.11.0', {}), null);
  assert.match(formatUpdateNudge('0.9.1', '0.11.0', { GRAFT_UPDATE_CHECK: '1' }) ?? '', /0\.11\.0/);
});

test('a stale cache spawns no registry check unless GRAFT_UPDATE_CHECK=1', () => {
  const home = mkdtempSync(join(tmpdir(), 'fork-quiet-home-'));
  try {
    assert.equal(maybeRefreshInBackground(home, Date.now(), {}), false);
    assert.equal(existsSync(updateCachePath(home)), false, 'the cache is not even touched');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('sourceCheckoutRoot: a git checkout is recognised, a registry install is not', () => {
  const root = mkdtempSync(join(tmpdir(), 'fork-quiet-pkg-'));
  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'package.json'), '{"name":"@nanonets/graft","version":"0.0.0"}');
    const moduleUrl = pathToFileURL(join(root, 'dist', 'cli.js')).href;
    assert.equal(sourceCheckoutRoot(moduleUrl), null);
    mkdirSync(join(root, '.git'));
    assert.equal(sourceCheckoutRoot(moduleUrl), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no team sign-in line while the cloud is off', () => {
  assert.equal(teamSignInLine(process.cwd(), { ...process.env, TRAIL_CLOUD: '0' }), '');
});

test('the skill asks for a savings tally only while savings are reported', () => {
  for (const brand of ['graft', 'trail'] as const) {
    const quiet = withEnv({ GRAFT_NO_SAVINGS: '1' }, () => skillTemplate(brand));
    assert.doesNotMatch(quiet, /saved, every turn/, `${brand}: the tally section is gone`);
    assert.match(quiet, /\*\*Never pipe/, `${brand}: the section after it stays`);
    const loud = withEnv({ GRAFT_NO_SAVINGS: undefined }, () => skillTemplate(brand));
    assert.match(loud, /saved, every turn/, `${brand}: upstream text unchanged by default`);
  }
});
