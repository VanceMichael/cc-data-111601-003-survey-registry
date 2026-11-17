import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startProvider } from '../src/provider.mjs';
import { collectWave, resolveReference, parseRegistry, identityKey } from '../src/wave.mjs';
import { inspect } from '../src/reader.mjs';

const manifest = JSON.parse(await readFile(new URL('../fixtures/upstream.json', import.meta.url), 'utf8'));
const registry = parseRegistry(Buffer.from(JSON.stringify({ objects: [
  { agency: 'school-a', id: 'q1', version: '1', url: '/objects/q1' },
  { agency: 'school-a', id: 'codes', version: '1', url: '/objects/codes-1' },
  { agency: 'school-a', id: 'codes', version: '2', url: '/objects/codes-2' },
  { agency: 'school-b', id: 'codes', version: '1', url: '/objects/other' }
] })));
assert.equal(manifest.resources['/objects/u1'].phases['1'].status, 404);

test('版本明确的引用指向同机构同版本，不取最新', () => {
  const resolution = resolveReference({ role: 'CodeSchemeReference', agency: 'school-a',
    id: 'codes', version: '1' }, { status: 'available', ...registry });
  assert.equal(resolution.status, 'resolved');
  assert.equal(resolution.basis, 'exact_version');
  assert.deepEqual(resolution.resolved, { agency: 'school-a', id: 'codes', version: '1' });
  assert.equal(resolution.url, '/objects/codes-1');
  assert.ok(resolution.candidates.some(item => item.version === '2'));
});

test('缺版本且注册表有多个版本时保持未解析，不按最大版本选择', () => {
  const resolution = resolveReference({ role: 'CodeSchemeReference', agency: 'school-a',
    id: 'codes' }, { status: 'available', ...registry });
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.reason, 'ambiguous_version');
  assert.equal(resolution.resolved ?? null, null);
  assert.deepEqual(resolution.evidence.availableVersions, ['1', '2']);
});

test('缺版本且同机构唯一版本时才解析并保留依据', () => {
  const resolution = resolveReference({ role: 'QuestionReference', agency: 'school-a',
    id: 'q1' }, { status: 'available', ...registry });
  assert.equal(resolution.status, 'resolved');
  assert.equal(resolution.basis, 'unique_registry_version');
  assert.deepEqual(resolution.resolved, { agency: 'school-a', id: 'q1', version: '1' });
});

test('他机构同号对象不参与解析，也不会被当成缺失版本的替代', () => {
  const resolution = resolveReference({ role: 'CodeSchemeReference', agency: 'school-a',
    id: 'other' }, { status: 'available', ...registry });
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.reason, 'not_found');
  assert.equal(resolution.evidence.ignoredOtherAgencyCount, 0);
  const other = resolveReference({ role: 'CodeSchemeReference', agency: 'school-b',
    id: 'codes', version: '1' }, { status: 'available', ...registry });
  assert.deepEqual(other.resolved, { agency: 'school-b', id: 'codes', version: '1' });
  assert.equal(other.url, '/objects/other');
});

test('版本不存在时不回退到可用版本', () => {
  const resolution = resolveReference({ role: 'CodeSchemeReference', agency: 'school-a',
    id: 'codes', version: '3' }, { status: 'available', ...registry });
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.reason, 'version_not_found');
});

test('注册表条目缺 URL 时不解析为可领取位置', () => {
  const missingUrl = parseRegistry(Buffer.from(JSON.stringify({ objects: [
    { agency: 'school-a', id: 'u1', version: '2' }
  ] })));
  const resolution = resolveReference({ role: 'UniverseReference', agency: 'school-a',
    id: 'u1', version: '2' }, { status: 'available', ...missingUrl });
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.reason, 'registry_url_missing');
});

test('变量身份按机构、方案、版本与变量 id 区分，不按标签合并', () => {
  const left = identityKey({ agency: 'school-a', id: 'vars', version: '2024' });
  const right = identityKey({ agency: 'school-a', id: 'vars', version: '2025' });
  assert.notEqual(left, right);
  const fixture = inspect(Buffer.from(`<d:VariableScheme xmlns:d="ddi:logicalproduct:3_3"
    agencyID="school-a" id="vars" version="2024">
    <d:Variable id="v1"><d:Label>就业状态</d:Label></d:Variable>
    <d:Variable id="v2"><d:Label>就业状态</d:Label></d:Variable>
    </d:VariableScheme>`));
  assert.equal(fixture.variables.length, 2);
  assert.deepEqual(fixture.variables.map(item => item.label), [['就业状态'], ['就业状态']]);
});

test('发布的完整领取会实际引用三类依据并记录复用关系', async () => {
  const provider = await startProvider();
  try {
    const wave = await collectWave({ source: provider.url });
    assert.equal(wave.status, 'complete');
    assert.equal(wave.release.id, 'survey');
    assert.equal(wave.variables.length, 1);
    const variable = wave.variables[0];
    assert.equal(variable.label[0], '就业状态');
    assert.equal(variable.universe.identity.version, '2');
    assert.equal(variable.universe.label[0], '仅全职人员');
    assert.equal(variable.codeScheme.identity.version, '1');
    assert.equal(variable.question.label[0], '当前的就业状态？');
    const codeScheme = wave.objects.find(item => item.identity.id === 'codes');
    assert.equal(codeScheme.referencedBy.length, 1);
    const requests = await (await fetch(`${provider.url}/_requests`)).json();
    assert.ok(requests.some(item => item.path === '/objects/u1'));
    assert.ok(requests.some(item => item.path === '/objects/codes-1'));
    assert.ok(!requests.some(item => item.path === '/objects/codes-2'));
    assert.ok(!requests.some(item => item.path === '/objects/other'));
  } finally { await provider.close(); }
});

test('来源缺 universe 时受影响变量留作可补采记录并标明缺失层', async () => {
  const provider = await startProvider();
  try {
    await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
    const wave = await collectWave({ source: provider.url });
    assert.equal(wave.status, 'incomplete');
    assert.equal(wave.complete, false);
    const variable = wave.variables[0];
    assert.equal(variable.status, 'incomplete');
    assert.deepEqual(variable.missingLayers, ['universe']);
    assert.equal(variable.universe, null);
    assert.equal(variable.question.label[0], '当前的就业状态？');
    assert.equal(variable.codeScheme.label[0], '1=就业；2=未就业');
    const [item] = wave.missing;
    assert.equal(item.level, 'variable');
    assert.equal(item.layer, 'universe');
    assert.equal(item.reason, 'source_status_404');
    assert.deepEqual(item.requested, { agency: 'school-a', id: 'u1', version: '2' });
    assert.equal(wave.entry.digest.length, 64);
  } finally { await provider.close(); }
});

test('同一 DDI 对象被多个变量引用时只领取一次并逐个记录复用位置', async () => {
  const provider = await startProvider();
  try {
    const wave = await collectWave({ source: provider.url });
    const schemes = wave.schemes[0];
    assert.ok(schemes.variables.length >= 1);
    const question = wave.objects.find(item => item.identity.id === 'q1');
    assert.equal(question.identity.version, '1');
    const requests = await (await fetch(`${provider.url}/_requests`)).json();
    assert.equal(requests.filter(item => item.path === '/objects/q1').length, 1);
  } finally { await provider.close(); }
});

test('引用自己写明的 URL 也要通过身份校验', async () => {
  const { createServer } = await import('node:http');
  const xml = body => ['application/xml', body];
  const json = body => ['application/json', JSON.stringify(body)];
  const resources = {
    '/catalog': json({ entry: '/release', registry: '/registry' }),
    '/release': json({ agency: 'a', id: 'survey', version: '2024',
      references: [{ agency: 'a', id: 'vars', version: '2024', url: '/vars' }] }),
    '/vars': xml(`<VariableScheme agencyID="a" id="vars" version="2024">
      <Variable id="v1"><Label>x</Label>
      <QuestionReference agencyID="a" id="q" version="1" url="/wrong"/>
      <UniverseReference agencyID="a" id="u" version="1"/>
      <CodeSchemeReference agencyID="a" id="c" version="1"/></Variable></VariableScheme>`),
    // q@1 is absent from the registry, so the reference locator is tried; the
    // bytes there are q@2, which must not be accepted for q@1.
    '/registry': json({ objects: [
      { agency: 'a', id: 'u', version: '1', url: '/u' },
      { agency: 'a', id: 'c', version: '1', url: '/c' }] }),
    '/wrong': xml('<QuestionItem agencyID="a" id="q" version="2"><Label>Q2</Label></QuestionItem>'),
    '/u': xml('<Universe agencyID="a" id="u" version="1"><Label>U</Label></Universe>'),
    '/c': xml('<CodeScheme agencyID="a" id="c" version="1"><Label>C</Label></CodeScheme>')
  };
  const server = createServer((request, response) => {
    const found = resources[request.url.split('?')[0]];
    if (!found) { response.writeHead(404); return response.end('not_found'); }
    response.writeHead(200, { 'content-type': found[0] });
    response.end(found[1]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const wave = await collectWave({ source: `http://127.0.0.1:${server.address().port}` });
    const variable = wave.variables[0];
    assert.equal(variable.question, null);
    assert.deepEqual(variable.missingLayers, ['question']);
    const reference = variable.references.find(item => item.layer === 'question');
    assert.equal(reference.status, 'unresolved');
    assert.equal(reference.reason, 'identity_mismatch');
    assert.deepEqual(reference.observed, { agency: 'a', id: 'q', version: '2' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
