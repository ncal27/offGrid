import { GpsFix } from '@offgrid/shared';
import { EmbeddingAdapter, GpsAdapter, NetworkAdapter, StorageAdapter } from '../core/adapters';

/** Generic in-memory StorageAdapter — reusable across any test, not scenario-specific. */
export class InMemoryStorageAdapter implements StorageAdapter {
  private store = new Map<string, unknown>();

  async writeJson(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async readJson<T>(key: string): Promise<T | null> {
    return this.store.has(key) ? (this.store.get(key) as T) : null;
  }

  async writeBinary(key: string, data: Uint8Array | string): Promise<void> {
    this.store.set(key, data);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async listKeys(prefix: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** Fake NetworkAdapter with a canned-response routing table, so tests control exactly what the "backend" returns. */
export class FakeNetworkAdapter implements NetworkAdapter {
  public online: boolean;
  private getRoutes = new Map<string, unknown>();
  private postRoutes = new Map<string, unknown>();
  public postCalls: { path: string; body: unknown }[] = [];

  constructor(options: { online?: boolean } = {}) {
    this.online = options.online ?? true;
  }

  mockGet(path: string, response: unknown): this {
    this.getRoutes.set(path, response);
    return this;
  }

  mockPost(path: string, response: unknown): this {
    this.postRoutes.set(path, response);
    return this;
  }

  async isOnline(): Promise<boolean> {
    return this.online;
  }

  async get<T>(path: string): Promise<T> {
    if (!this.getRoutes.has(path)) {
      throw new Error(`FakeNetworkAdapter: no mocked GET for ${path}`);
    }
    return this.getRoutes.get(path) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    this.postCalls.push({ path, body });
    if (!this.postRoutes.has(path)) {
      throw new Error(`FakeNetworkAdapter: no mocked POST for ${path}`);
    }
    return this.postRoutes.get(path) as T;
  }
}

/** Fake GpsAdapter that plays back a scripted sequence of fixes. */
export class ScriptedGpsAdapter implements GpsAdapter {
  constructor(private fixes: GpsFix[] = []) {}

  async getCurrentFix(): Promise<GpsFix> {
    if (this.fixes.length === 0) throw new Error('ScriptedGpsAdapter: no fixes scripted');
    return this.fixes[0];
  }

  watchPosition(onFix: (fix: GpsFix) => void): () => void {
    for (const fix of this.fixes) onFix(fix);
    return () => {};
  }
}

/** Fake EmbeddingAdapter keyed by photo URI, so tests control exactly what the "on-device model" returns. */
export class FakeEmbeddingAdapter implements EmbeddingAdapter {
  constructor(private table: Record<string, number[]>) {}

  async embed(photoUri: string): Promise<number[]> {
    const vec = this.table[photoUri];
    if (!vec) throw new Error(`FakeEmbeddingAdapter: no vector registered for ${photoUri}`);
    return vec;
  }
}
