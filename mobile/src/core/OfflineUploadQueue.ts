import { isSafeId } from '@offgrid/shared';
import { HttpError, NetworkAdapter, StorageAdapter } from './adapters';

export interface OfflineUploadQueueConfig {
  storageKeyPrefix: string;
  uploadPath: string;
}

export interface RejectedUpload<TUpload> {
  upload: TUpload;
  status: number;
  rejectedAt: string;
}

/**
 * Generic "queue something locally while offline, flush it to the backend
 * once connectivity returns" engine, shared by SyncQueue (photos) and
 * HazardReportQueue (hazards).
 *
 * Flush failure handling (BUG-011). Previously a single failing item threw
 * out of flush(), so everything queued after it was never sent. Because items
 * are flushed in the same order every time, one permanently-rejected upload
 * (e.g. a 400 from the backend's stricter validation) blocked every later
 * hazard report and photo on that phone, forever. Now:
 *  - permanent rejection (HttpError 4xx, see HttpError.isPermanent): the item
 *    is moved to a separate "rejected" area (kept so the UI can tell the hiker
 *    and they don't silently lose a report), and flushing continues;
 *  - transient failure (offline mid-flush, timeout, 5xx, 429): the item stays
 *    queued and flushing stops, since the next items would most likely fail
 *    too. It's retried on the next flush. That's safe because the backend
 *    treats a resend of the same id as idempotent.
 */
export class OfflineUploadQueue<TUpload extends { id: string }, TAck> {
  private readonly rejectedPrefix: string;

  constructor(
    private storage: StorageAdapter,
    private network: NetworkAdapter,
    private config: OfflineUploadQueueConfig,
  ) {
    // Sibling prefix, NOT nested under storageKeyPrefix, so pending()'s
    // listKeys(storageKeyPrefix) never picks up rejected items.
    this.rejectedPrefix = `${config.storageKeyPrefix.replace(/\/$/, '')}-rejected/`;
  }

  private key(id: string): string {
    // `id` becomes part of a storage key (a file path once a real filesystem
    // StorageAdapter exists), so it must be safe here too, not just in subclasses.
    if (!isSafeId(id)) throw new Error('Cannot queue upload: invalid id');
    return `${this.config.storageKeyPrefix}${id}.json`;
  }

  async enqueue(upload: TUpload): Promise<void> {
    await this.storage.writeJson(this.key(upload.id), upload);
  }

  async pending(): Promise<TUpload[]> {
    const keys = await this.storage.listKeys(this.config.storageKeyPrefix);
    const items: TUpload[] = [];
    for (const key of keys) {
      const item = await this.storage.readJson<TUpload>(key);
      if (item && isSafeId(item.id)) items.push(item);
    }
    return items;
  }

  /** Uploads the backend refused permanently, for the UI to show the hiker. */
  async rejected(): Promise<RejectedUpload<TUpload>[]> {
    const keys = await this.storage.listKeys(this.rejectedPrefix);
    const items: RejectedUpload<TUpload>[] = [];
    for (const key of keys) {
      const item = await this.storage.readJson<RejectedUpload<TUpload>>(key);
      if (item) items.push(item);
    }
    return items;
  }

  async clearRejected(): Promise<void> {
    for (const key of await this.storage.listKeys(this.rejectedPrefix)) await this.storage.remove(key);
  }

  /** Uploads everything queued, if and only if the device currently has connectivity. Returns acks for items that succeeded. */
  async flush(): Promise<TAck[]> {
    const online = await this.network.isOnline();
    if (!online) return [];

    const items = await this.pending();
    const acks: TAck[] = [];
    for (const item of items) {
      let ack: TAck;
      try {
        ack = await this.network.post<TAck>(this.config.uploadPath, item);
      } catch (err) {
        if (err instanceof HttpError && err.isPermanent) {
          const record: RejectedUpload<TUpload> = {
            upload: item,
            status: err.status,
            rejectedAt: new Date().toISOString(),
          };
          await this.storage.writeJson(`${this.rejectedPrefix}${item.id}.json`, record);
          await this.storage.remove(this.key(item.id));
          continue;
        }
        break; // transient: keep this and the rest queued for the next flush
      }
      acks.push(ack);
      await this.storage.remove(this.key(item.id));
    }
    return acks;
  }
}
