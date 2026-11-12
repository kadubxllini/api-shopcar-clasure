import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { validateServiceConfig } from '../core.mjs';
import { validateWorkerConfig } from '../worker-client.mjs';

export function addCompany(root, slug, site) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug || '')) throw new Error('Invalid company slug');
  const companies = join(root, 'companies');
  const directory = join(companies, slug);
  const runtime = join(root, 'runtime');
  const configPath = join(runtime, 'service.json');
  for (const path of [companies, runtime]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Private directory cannot be a symlink');
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const lockPath = configPath + '.lock';
  writeFileSync(lockPath, '', { flag: 'wx', mode: 0o600 });
  let created = false;
  let committed = false;
  let wroteTemporary = false;
  const temporary = configPath + '.new';
  try {
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8'))
      : { stateDir: join(runtime, 'state'), clients: [] };
    const importerToken = randomBytes(32).toString('hex');
    const siteToken = randomBytes(32).toString('hex');
    const hash = value => createHash('sha256').update(value).digest('hex');
    const worker = { site, siteToken, importerToken };
    validateWorkerConfig(worker);
    const client = { tokenHash: hash(importerToken), adapters: ['shopcar'], rateLimit: 30 };
    config.clients.push(client);
    validateServiceConfig(config);
    mkdirSync(directory, { mode: 0o700 });
    created = true;
    for (const [name, value] of Object.entries({ 'worker.json': worker, 'client.json': client,
      'site-config.json': { enabled: true, serviceTokenHash: hash(siteToken) } })) {
      writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    wroteTemporary = true;
    renameSync(temporary, configPath);
    committed = true;
    return directory;
  } finally {
    if (!committed && created) rmSync(directory, { recursive: true });
    if (wroteTemporary && existsSync(temporary)) unlinkSync(temporary);
    unlinkSync(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: npm run company:add -- company https://example.com');
    const directory = addCompany(resolve(dirname(fileURLToPath(import.meta.url)), '..'), process.argv[2], process.argv[3]);
    console.log(`Company created: ${directory}\nPrivate files written. Restart capture service and start this company worker; see README.`);
  } catch {
    console.error('Company creation failed. Check slug, HTTPS site, existing directory, configuration and lock. No credentials are printed.');
    process.exitCode = 1;
  }
}
