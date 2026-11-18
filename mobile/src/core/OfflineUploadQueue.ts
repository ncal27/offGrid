import { NetworkAdapter, StorageAdapter } from './adapters';

export interface OfflineUploadQueueConfig {
  storageKeyPrefix: string;
  uploadPath: string;
}

/**
 * Generic "queue something locally while offline, flush it to the backend
 * once connectivity returns" engine. Extracted from what was originally a
 * one-off SyncQueue (for landmark photo contributions) so the same offline
 * -first pattern can be reused for hazard reports (HazardReportQueue) and
 * any future contribution type without copy-pasting the storage/flush logic.
 */
export class OfflineUploadQueue<TUpload extends { id: string }, TAck> {
  constructor(
    private storage: StorageAdapter,
    private network: NetworkAdapter,
    private config: OfflineUploadQueueConfig,
  ) {}

  async enqueue(upload: TUpload): Promise<void> {
    await this.storage.writeJson(`${this.config.storageKeyPrefix}${upload.id}.json`, upload);
  }

  async pending(): Promise<TUpload[]> {
    const keys = await this.storage.listKeys(this.config.storageKeyPrefix);
    const items: TUpload[] = [];
    for (const key of keys) {
      const item = await this.storage.readJson<TUpload>(key);
      if (item) items.push(item);
    }
    return items;
  }

  /** Uploads everything queued, if and only if the device currently has connectivity. */
  async flush(): Promise<TAck[]> {
    const online = await this.network.isOnline();
    if (!online) return [];

    const items = await this.pending();
    const acks: TAck[] = [];
    for (const item of items) {
      const ack = await this.network.post<TAck>(this.config.uploadPath, item);
      acks.push(ack);
      await this.storage.remove(`${this.config.storageKeyPrefix}${item.id}.json`);
    }
    return acks;
  }
}
