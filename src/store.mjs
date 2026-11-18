import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    await mkdir(join(this.directory, 'snapshots'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
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
  /**
   * Persist one fetched original. `source` is the URL the bytes actually came
   * from, which may differ from the URL that was requested after a registry
   * lookup; `recordId` is returned so a snapshot can cite the stored original.
   */
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return { ...existing, recordId: existing.id };
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return { ...record, recordId: record.id };
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
  async saveSnapshot(snapshot) {
    const operation = this.pending.then(async () => {
      await writeFile(join(this.directory, 'snapshots', `${snapshot.id}.json`), JSON.stringify(snapshot));
      return snapshot;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async listSnapshots() {
    const index = JSON.parse(await readFile(join(this.directory, 'snapshots', 'index.json'), 'utf8')
      .catch(error => error.code === 'ENOENT' ? '[]' : Promise.reject(error)));
    return index;
  }
  async snapshot(id) {
    if (!/^[a-z0-9-]{8,64}$/.test(id)) throw new Error('invalid_snapshot_id');
    return JSON.parse(await readFile(join(this.directory, 'snapshots', `${id}.json`), 'utf8'));
  }
  async recordSnapshot(summary) {
    const operation = this.pending.then(async () => {
      let index;
      try { index = await this.listSnapshots(); } catch { index = []; }
      index.push(summary);
      const temporary = join(this.directory, 'snapshots', `index-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(index));
      await rename(temporary, join(this.directory, 'snapshots', 'index.json'));
      return summary;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
