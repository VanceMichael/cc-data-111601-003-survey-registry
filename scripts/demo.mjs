import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  const response = await fetch(`${service.url}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
  if (response.status !== 201) throw new Error(await response.text());
  console.log('接收结果', await response.json());
  console.log('已保存资料', await (await fetch(`${service.url}/records`)).json());

  const wave = await fetch(`${service.url}/waves`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  if (wave.status !== 201) throw new Error(await wave.text());
  const summary = await wave.json();
  console.log('轮次摘要', summary);
  const snapshot = await (await fetch(`${service.url}/waves/${summary.id}`)).json();
  console.log('变量依据', snapshot.variables.map(item => ({
    variable: item.variableId, scheme: item.scheme, status: item.status,
    references: item.references.map(reference => ({
      layer: reference.layer, requested: reference.requested,
      basis: reference.basis, label: reference.label
    }))
  })));
  console.log('复用关系', snapshot.relationships.map(item => ({
    from: `${item.from.id}@${item.from.version}`, layer: item.layer, requested: item.requested
  })));

  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
  const partialResponse = await fetch(`${service.url}/waves`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  const partial = await partialResponse.json();
  const partialSnapshot = await (await fetch(`${service.url}/waves/${partial.id}`)).json();
  console.log('阶段 1 摘要', partial);
  console.log('阶段 1 待补依据', partialSnapshot.gaps.map(item => item.description));
  console.log('阶段 1 受影响变量', partialSnapshot.variables
    .filter(item => !item.complete)
    .map(item => ({ variable: item.variableId, description: item.description })));
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
