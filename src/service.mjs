import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { collectWave } from './wave.mjs';

async function readJson(request, limit = 16384) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString();
  return body.trim() === '' ? {} : JSON.parse(body);
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') return response.end(JSON.stringify(await store.list()));
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        const digest = url.pathname.slice(9);
        if (url.searchParams.get('view') === 'usages') {
          return response.end(JSON.stringify(await store.objectUsages(digest)));
        }
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(digest));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const payload = await readJson(request);
        if (typeof payload.path !== 'string') throw new Error('path_required');        const result = await acquire(source, payload.path);
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      if (url.pathname === '/waves' && request.method === 'POST') {
        const payload = await readJson(request);
        if (payload.path != null && typeof payload.path !== 'string') throw new Error('path_invalid');
        // A collection that cannot even read the release is rejected without
        // storing anything; a collection with missing layers is stored as an
        // explicitly incomplete, supplementable record.
        const wave = await collectWave({ source, store,
          ...(payload.path == null ? {} : { path: payload.path }) });
        const stored = await store.saveWave(wave);
        response.statusCode = 201;
        return response.end(JSON.stringify(stored));
      }
      if (url.pathname === '/waves' && request.method === 'GET') {
        const key = url.searchParams.get('key');
        const records = await store.listWaves();
        return response.end(JSON.stringify(key == null
          ? records : records.filter(record => record.key === key)));
      }
      if (url.pathname === '/waves/missing' && request.method === 'GET') {
        const key = url.searchParams.get('key');
        const waves = key == null ? await store.listWaves() : await store.wavesByKey(key);
        const details = [];
        for (const record of waves) {
          const wave = await store.wave(record.id);
          for (const item of wave.missing ?? []) details.push({ wave: record.id, key: record.key, ...item });
        }
        return response.end(JSON.stringify(details));
      }
      if (url.pathname.startsWith('/waves/') && request.method === 'GET') {
        const id = url.pathname.slice(7);
        if (id === 'latest') {
          const key = url.searchParams.get('key');
          if (!key) throw new Error('wave_key_required');
          const wave = await store.latestWaveFor(key);
          if (!wave) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
          return response.end(JSON.stringify(wave));
        }
        return response.end(JSON.stringify(await store.wave(id)));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) {
      const notFound = error.code === 'ENOENT';
      response.statusCode = notFound ? 404 : 422;
      response.end(JSON.stringify({ error: notFound ? 'not_found' : error.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SOURCE_URL) throw new Error('SOURCE_URL_required');
  const service = await startService({ source: process.env.SOURCE_URL,
    directory: process.env.DATA_DIR ?? './data', port: Number(process.env.PORT ?? 4102) });
  console.log(JSON.stringify({ product: service.url }));
}
