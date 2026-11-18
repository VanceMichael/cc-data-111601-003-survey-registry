import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { parseCatalog, parseRelease, parseRegistry, collectRelease } from './waves.mjs';
import { startProvider } from './provider.mjs';

async function body(request, limit = 16384) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  if (length === 0) return {};
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('json_object_required');
  return payload;
}

function requiredPath(payload) {
  if (typeof payload.path !== 'string' || payload.path.length === 0) throw new Error('path_required');
  return payload.path;
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const base = new URL(source).href;
  const fetchObject = async path => {
    const target = new URL(path, base).href;
    const result = await acquire(base, target, { accept: 'application/xml, application/json' });
    return { ...result, url: target };
  };
  const save = (bytes, url, parsed) => store.accept(bytes, url, parsed);

  async function collect(entryPath) {
    const catalogResult = await fetchObject('/catalog');
    const catalog = parseCatalog(catalogResult.bytes);
    const resolvedEntry = entryPath ?? catalog.entry;
    const releasePath = new URL(resolvedEntry, base).href;
    const releaseResult = await fetchObject(releasePath);
    const release = parseRelease(releaseResult.bytes);
    const registryPath = new URL(catalog.registry, base).href;
    const registryResult = await fetchObject(registryPath);
    const registry = parseRegistry(registryResult.bytes);

    const releaseStored = await save(releaseResult.bytes, releasePath,
      { kind: 'Release', identity: { ...release.identity }, references: release.references });
    const registryStored = await save(registryResult.bytes, registryPath,
      { kind: 'Registry', objects: registry.objects.length });
    const catalogStored = await save(catalogResult.bytes, catalogResult.url,
      { kind: 'Catalog', entry: catalog.entry, registry: catalog.registry });

    const snapshot = await collectRelease({
      release,
      releasePath: new URL(resolvedEntry, base).pathname,
      registry,
      catalog: { ...catalog, digest: catalogStored.digest, recordId: catalogStored.recordId },
      evidence: {
        release: { digest: releaseStored.digest, recordId: releaseStored.recordId },
        registry: { path: new URL(catalog.registry, base).pathname,
          digest: registryStored.digest, recordId: registryStored.recordId }
      },
      fetch: fetchObject,
      save
    });
    const id = randomUUID();
    const stored = { id, createdAt: new Date().toISOString(), ...snapshot };
    await store.saveSnapshot(stored);
    await store.recordSnapshot({
      id, createdAt: stored.createdAt, entry: stored.entry,
      status: stored.status, complete: stored.complete, counts: stored.counts
    });
    return stored;
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname === '/objects/' && request.method === 'GET') {
        response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' }));
      }
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = await body(request);
        const path = requiredPath(payload);
        const result = await acquire(base, path);
        const parsed = inspect(result.bytes);
        const { recordId, ...record } = await store.accept(result.bytes, new URL(path, base).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/waves' && request.method === 'POST') {
        const payload = await body(request);
        if (Object.keys(payload).some(key => key !== 'path')) throw new Error('unexpected_field');
        const path = payload.path === undefined ? null : requiredPath(payload);
        const snapshot = await collect(path);
        response.statusCode = 201;
        return response.end(JSON.stringify({
          id: snapshot.id, createdAt: snapshot.createdAt, entry: snapshot.entry,
          status: snapshot.status, complete: snapshot.complete, summary: snapshot.summary,
          counts: snapshot.counts,
          gaps: snapshot.gaps.map(gap => ({
            layer: gap.layer, status: gap.status, reason: gap.reason,
            requested: gap.requested, description: gap.description,
            variableKeys: gap.variableKeys ?? []
          }))
        }));
      }
      if (url.pathname === '/waves' && request.method === 'GET') {
        return response.end(JSON.stringify(await store.listSnapshots()));
      }
      if (url.pathname.startsWith('/waves/') && request.method === 'GET') {
        return response.end(JSON.stringify(await store.snapshot(url.pathname.slice(7))));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = process.env.SOURCE_URL ? null : await startProvider();
  const source = process.env.SOURCE_URL ?? provider.url;
  let service;
  try {
    service = await startService({ source, directory: process.env.DATA_DIR ?? './data',
      port: Number(process.env.PORT ?? 4102) });
  } catch (error) {
    if (provider) await provider.close();
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    if (provider) await provider.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  console.log(JSON.stringify({ product: service.url, source }));
}
