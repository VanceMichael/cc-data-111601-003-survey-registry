import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { inspect } from '../src/reader.mjs';

test('单件资料可解释，畸形输入被拒绝', async () => {
  const fixture = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
  assert.ok(inspect(fixture));
  assert.throws(() => inspect(Buffer.alloc(0)));
});
test('来源领取、原件持久化、重启查询及无副作用拒收', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const body = JSON.stringify({ path: '/primary' });
    const send = path => fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const first = await send('/primary');
    assert.equal(first.status, 201);
    const record = await first.json();
    assert.deepEqual(await new Store(directory).list(), [record]);
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${record.digest}`)).arrayBuffer()),
      await readFile(new URL('../fixtures/primary.bin', import.meta.url)));
    const repeated = await send('/primary');
    assert.equal((await repeated.json()).id, record.id);
    assert.equal((await send('/missing')).status, 422);
    assert.equal((await send('https://example.invalid/foreign')).status, 422);
    assert.equal((await new Store(directory).list()).length, 1);
    const range = await fetch(`${provider.url}/primary`, { headers: { range: 'bytes=0-0' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 1);
    const reject = await fetch(`${provider.url}/primary`, { headers: { 'if-match': '"old"' } });
    assert.equal(reject.status, 412);
    assert.ok(body.includes('primary'));
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
test('按发布入口领取整轮引用，缺失层保留并可后续补采', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wave-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const collect = path => fetch(`${service.url}/waves`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(path == null ? {} : { path }) });
  try {
    const phase = await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
    assert.equal(phase.status, 200);
    const first = await collect();
    assert.equal(first.status, 201);
    const incomplete = await first.json();
    assert.equal(incomplete.status, 'incomplete');
    assert.equal(incomplete.supplementable, true);
    const variable = incomplete.variables[0];
    assert.equal(variable.key, '["school-a","vars","2024","v1"]');
    assert.deepEqual(variable.missingLayers, ['universe']);
    assert.equal(variable.universe, null);
    assert.equal(incomplete.missing[0].layer, 'universe');
    assert.equal(incomplete.missing[0].variableKey, variable.key);

    const missing = await (await fetch(`${service.url}/waves/missing?key=${encodeURIComponent(incomplete.key)}`)).json();
    assert.equal(missing.length, 1);
    assert.equal(missing[0].wave, incomplete.id);
    assert.equal(missing[0].reason, 'source_status_404');

    // Re-collecting the same state is the same snapshot; nothing is invented.
    assert.equal((await (await collect()).json()).id, incomplete.id);

    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 0 }) });
    const second = await (await collect()).json();
    assert.notEqual(second.id, incomplete.id);
    assert.equal(second.previous, incomplete.id);
    assert.equal(second.status, 'complete');
    assert.equal(second.variables[0].universe.identity.version, '2');
    assert.equal(second.variables[0].codeScheme.identity.version, '1');

    // The old snapshot stays queryable exactly as it was collected.
    const kept = await (await fetch(`${service.url}/waves/${incomplete.id}`)).json();
    assert.equal(kept.status, 'incomplete');
    assert.equal(kept.variables[0].universe, null);
    const latest = await (await fetch(`${service.url}/waves/latest?key=${encodeURIComponent(incomplete.key)}`)).json();
    assert.equal(latest.id, second.id);
    const list = await (await fetch(`${service.url}/waves?key=${encodeURIComponent(incomplete.key)}`)).json();
    assert.deepEqual(list.map(item => item.id), [incomplete.id, second.id]);

    // The generic single-object intake and its listing remain unchanged.
    const intake = await fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
    assert.equal(intake.status, 201);
    assert.equal((await (await fetch(`${service.url}/records`)).json()).length, 1);
    // Wave members are still re-readable as raw bytes.
    const universe = second.variables[0].universe;
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${universe.digest}`)).arrayBuffer()),
      await readFile(new URL('../fixtures/resource-03.bin', import.meta.url)));
    const usages = await (await fetch(`${service.url}/objects/${universe.digest}?view=usages`)).json();
    assert.deepEqual(usages.map(item => item.wave), [second.id]);
    assert.equal(usages[0].referencedBy[0].variableKey, second.variables[0].key);
    assert.equal((await collect('/missing')).status, 422);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
