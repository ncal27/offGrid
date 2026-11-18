/**
 * Persists data on-device. A real build backs this with something like
 * react-native-fs / MMKV / SQLite; tests use an in-memory implementation
 * (see testUtils/mockAdapters.ts) so core logic never needs a device to run.
 */
export interface StorageAdapter {
  writeJson(key: string, value: unknown): Promise<void>;
  readJson<T>(key: string): Promise<T | null>;
  writeBinary(key: string, data: Uint8Array | string): Promise<void>;
  exists(key: string): Promise<boolean>;
  listKeys(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
}
