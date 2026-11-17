import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'wave-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const json = async (path, options) => {
  const response = await fetch(`${service.url}${path}`, options);
  const body = await response.json();
  if (response.status >= 400) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
};
const collect = () => json('/waves', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: '{}' });
const summary = wave => ({
  status: wave.status,
  release: wave.release,
  variables: wave.variables.map(variable => ({
    key: variable.key,
    label: variable.label,
    question: variable.question?.label,
    universe: variable.universe?.label ?? null,
    codeScheme: variable.codeScheme?.label ?? null,
    missingLayers: variable.missingLayers
  })),
  missing: wave.missing.map(item => `${item.variableKey ?? ''}:${item.layer}:${item.reason}`)
});
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
  console.log('阶段 1：来源暂时缺少 universe 的整轮领取',
    JSON.stringify(summary(await collect()), null, 2));
  console.log('可补采记录', JSON.stringify(await json('/waves/missing'), null, 2));
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 0 }) });
  const complete = await collect();
  console.log('阶段 0：补齐后再次领取', JSON.stringify(summary(complete), null, 2));
  console.log('同一发布的快照', JSON.stringify(
    (await json(`/waves?key=${encodeURIComponent(complete.key)}`))
      .map(record => ({ id: record.id, previous: record.previous, status: record.status })), null, 2));
  console.log('已登记的单件资料', await json('/records'));
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
