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

test('按发布入口收集引用对象，阶段缺依据时变量留缺且快照持久可查', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wave-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const phase = value => fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: value }) });
  const collect = path => fetch(`${service.url}/waves`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(path === undefined ? {} : { path }) });
  try {
    const complete = await collect();
    assert.equal(complete.status, 201);
    const summary = await complete.json();
    assert.equal(summary.status, 'complete');
    assert.equal(summary.counts.objects, 4);
    assert.deepEqual(Object.keys(summary).sort(),
      ['complete','counts','createdAt','entry','gaps','id','status','summary']);
    assert.deepEqual(summary.gaps, []);
    const snapshot = await (await fetch(`${service.url}/waves/${summary.id}`)).json();
    assert.equal(snapshot.variables.length, 1);
    assert.equal(snapshot.variables[0].references.length, 3);
    assert.ok(snapshot.relationships.some(item => item.layer === 'variableScheme'));
    const requests = await (await fetch(`${provider.url}/_requests`)).json();
    assert.ok(requests.some(item => item.path === '/release'));
    assert.ok(requests.some(item => item.path === '/registry'));
    assert.ok(!requests.some(item => item.path === '/objects/codes-2'));

    await phase(1);
    const partial = await (await collect('/release')).json();
    assert.equal(partial.status, 'incomplete');
    assert.equal(partial.counts.incompleteVariables, 1);
    assert.equal(partial.counts.gaps, 1);
    const stored = await (await fetch(`${service.url}/waves/${partial.id}`)).json();
    assert.equal(stored.variables[0].complete, false);
    assert.equal(stored.variables[0].gaps[0].layer, 'universe');
    assert.equal(stored.variables[0].gaps[0].requested.version, '2');
    assert.equal(stored.gaps[0].variableKeys[0], stored.variables[0].key);
    assert.equal(stored.entry.identity.version, '2024');
    await phase(0);

    const listed = await (await fetch(`${service.url}/waves`)).json();
    assert.deepEqual(listed.map(item => item.id).sort(), [summary.id, partial.id].sort());
    assert.equal(listed.find(item => item.id === partial.id).status, 'incomplete');
    const records = await (await fetch(`${service.url}/records`)).json();
    assert.ok(records.some(item => item.parsed.kind === 'Universe'));
    const digest = records.find(item => item.parsed.kind === 'Universe').digest;
    assert.equal((await (await fetch(`${service.url}/objects/${digest}`)).arrayBuffer()).byteLength,
      (await readFile(new URL('../fixtures/resource-03.bin', import.meta.url))).byteLength);

    await service.close();
    const reopened = await startService({ source: provider.url, directory });
    try {
      const persisted = await (await fetch(`${reopened.url}/waves/${partial.id}`)).json();
      assert.equal(persisted.entry.digest, stored.entry.digest);
      assert.equal(persisted.variables[0].key, stored.variables[0].key);
      assert.equal((await (await fetch(`${reopened.url}/waves`)).json()).length, 2);
      assert.equal((await (await fetch(`${reopened.url}/records`)).json()).length, 7);
    } finally { await reopened.close(); }
  } finally { await service.close().catch(() => {}); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('轮次收集只接受配置来源内的入口，不接受额外字段', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wave-scope-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  const post = payload => fetch(`${service.url}/waves`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  try {
    assert.equal((await post({ path: 'https://example.invalid/release' })).status, 422);
    assert.equal((await post({ path: '/release', extra: true })).status, 422);
    assert.equal((await post({ path: 5 })).status, 422);
    assert.equal((await fetch(`${service.url}/records`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${service.url}/waves`, { method: 'PUT' })).status, 404);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
