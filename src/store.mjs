import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const digestOf = value => createHash('sha256').update(value).digest('hex');
// `collectedAt` records when a snapshot was observed, so it does not take part
// in deciding whether the collected content changed.
const waveDigest = wave => {
  const { collectedAt, ...content } = wave;
  return digestOf(JSON.stringify(content));
};

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    await mkdir(join(this.directory, 'waves'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    try { await this.listWaves(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveWaveIndex([]);
    }
    return this;
  }
  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  // Referenced objects keep their raw bytes available under /objects/{digest}
  // without entering the single-object intake index at /records, which keeps
  // the existing intake contract unchanged.
  async retain(bytes) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const target = join(this.directory, 'objects', digest);
    try {
      await readFile(target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(target, bytes);
    }
    return { digest, bytes: bytes.length };
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }

  // Waves are stored as immutable snapshots: the same key and the same
  // collected content keep the same id, while a changed snapshot (for example
  // after a missing layer becomes available) is kept as a new record.
  async saveWave(wave) {
    const serialized = JSON.stringify(wave);
    const digest = waveDigest(wave);
    const operation = this.pending.then(async () => {
      const records = await this.listWaves();
      const previous = records.filter(record => record.key === wave.key).at(-1) ?? null;
      // Repeating an unchanged collection must not create a new snapshot; a
      // changed one (for example after a missing layer is supplied) must.
      if (previous && previous.digest === digest) return this.wave(previous.id);
      const id = randomUUID();
      const record = { id, key: wave.key, digest, collectedAt: wave.collectedAt,
        status: wave.status, complete: wave.complete, source: wave.entry?.url ?? null,
        previous: previous?.id ?? null };
      await writeFile(join(this.directory, 'waves', `${id}.json`), serialized);
      records.push(record);
      await this.saveWaveIndex(records);
      return this.wave(id);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async saveWaveIndex(records) {
    const temporary = join(this.directory, `waves-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'waves.json'));
  }
  async listWaves() {
    return JSON.parse(await readFile(join(this.directory, 'waves.json'), 'utf8'));
  }
  async wave(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('invalid_wave_id');
    const stored = JSON.parse(await readFile(join(this.directory, 'waves', `${id}.json`), 'utf8'));
    const record = (await this.listWaves()).find(item => item.id === id) ?? {};
    return { id, key: stored.key, digest: waveDigest(stored),
      previous: record.previous ?? null, ...stored };
  }
  async wavesByKey(key) {
    const records = await this.listWaves();
    return records.filter(record => record.key === key)
      .map(record => ({ ...record }));
  }
  async latestWaveFor(key) {
    const records = (await this.listWaves()).filter(record => record.key === key);
    if (records.length === 0) return null;
    return this.wave(records.at(-1).id);
  }
  // Every stored wave is an immutable observation, so reuse of one DDI object
  // can be reported by scanning the wave snapshots themselves.
  async objectUsages(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    const usages = [];
    for (const record of await this.listWaves()) {
      const wave = await this.wave(record.id);
      const object = (wave.objects ?? []).find(item => item.digest === digest);
      if (!object) continue;
      usages.push({
        wave: wave.id,
        waveKey: wave.key,
        release: wave.release,
        status: wave.status,
        identity: object.identity,
        kind: object.kind,
        urls: object.urls ?? [object.url],
        referencedBy: object.referencedBy ?? []
      });
    }
    return usages;
  }
}
