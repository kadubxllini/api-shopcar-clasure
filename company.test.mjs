import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { addCompany } from './scripts/company-add.mjs';
import { validateServiceConfig, authorized } from './core.mjs';
import { validateWorkerConfig } from './worker-client.mjs';

test('company creation has isolated keys, restrictive permissions, no overwrite and preserves existing clients', () => {
  const root = mkdtempSync(join(tmpdir(), 'shopcar-company-'));
  const read = path => JSON.parse(readFileSync(join(root, path)));
  try {
    addCompany(root, 'loja-a', 'https://example.com');
    const first = read('companies/loja-a/worker.json');
    assert.equal(validateWorkerConfig(first).site, 'https://example.com');
    assert.notEqual(first.siteToken, first.importerToken);
    assert.equal(read('companies/loja-a/site-config.json').serviceTokenHash,
      createHash('sha256').update(first.siteToken).digest('hex'));
    addCompany(root, 'loja-b', 'https://example.org');
    const config = validateServiceConfig(read('runtime/service.json'));
    const second = read('companies/loja-b/worker.json');
    assert.notEqual(first.siteToken, second.siteToken);
    assert.notEqual(first.importerToken, second.importerToken);
    assert.equal(config.clients.length, 2);
    assert.notEqual(authorized(`Bearer ${first.importerToken}`, config.clients),
      authorized(`Bearer ${second.importerToken}`, config.clients));
    for (const name of ['worker.json', 'client.json', 'site-config.json']) {
      assert.equal(statSync(join(root, 'companies/loja-a', name)).mode & 0o777, 0o600);
    }
    assert.equal(statSync(join(root, 'companies/loja-a')).mode & 0o777, 0o700);
    const before = readFileSync(join(root, 'runtime/service.json'), 'utf8');
    assert.throws(() => addCompany(root, 'loja-a', 'https://example.org'));
    assert.throws(() => addCompany(root, '../escape', 'https://example.org'));
    assert.throws(() => addCompany(root, 'invalid-site', 'http://example.org'));
    assert.equal(readFileSync(join(root, 'runtime/service.json'), 'utf8'), before);
    assert.deepEqual(readdirSync(join(root, 'companies')).sort(), ['loja-a', 'loja-b']);
    assert.deepEqual(read('companies/loja-a/worker.json'), first);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
