import {
  ContributedPhotoUpload,
  ContributionAck,
  isOptionalBoolean,
  isPlausibleBase64,
  isSafeId,
  isSafeOptionalId,
  isValidIsoTimestamp,
  isValidOptionalLatLng,
} from '@offgrid/shared';
import { NetworkAdapter, StorageAdapter } from './adapters';
import { OfflineUploadQueue } from './OfflineUploadQueue';

export interface SyncQueueOptions {
  storageKeyPrefix?: string;
}

const MAX_BASE64_LENGTH = 12 * 1024 * 1024;

/**
 * Cheap, client-side defense in depth: reject obviously-invalid data before
 * it's even written to local storage, so a bug (or a tampered client) can't
 * fill up a hiker's phone with garbage that the backend would just reject
 * later anyway. This is NOT the authoritative check — it can't verify the
 * photo is really an image (no magic-byte check without Buffer; see
 * backend/src/validation/imageValidation.ts for that), and a modified client
 * could always skip it and hit the backend directly. The backend's own
 * validation (backend/src/validation/requestValidation.ts) is what actually
 * protects the system.
 */
function assertValidContribution(upload: ContributedPhotoUpload): void {
  const invalidFields: string[] = [];
  if (!isSafeId(upload.id)) invalidFields.push('id');
  if (!isSafeId(upload.trailId)) invalidFields.push('trailId');
  if (!isSafeOptionalId(upload.waypointHintId)) invalidFields.push('waypointHintId');
  if (!isValidIsoTimestamp(upload.capturedAt)) invalidFields.push('capturedAt');
  if (!isValidOptionalLatLng(upload.location)) invalidFields.push('location');
  if (!isOptionalBoolean(upload.gpsWeakOrMissing)) invalidFields.push('gpsWeakOrMissing');
  if (!isPlausibleBase64(upload.imageBase64, MAX_BASE64_LENGTH)) invalidFields.push('imageBase64');
  if (!isSafeId(upload.contributorId)) invalidFields.push('contributorId');

  if (invalidFields.length > 0) {
    throw new Error(`Cannot queue contribution — invalid field(s): ${invalidFields.join(', ')}`);
  }
}

/**
 * Queues hiker-contributed landmark photos locally while offline, then
 * flushes them to the backend once the device reconnects. Nothing here
 * assumes the contribution becomes "official" — the backend is responsible
 * for keeping it as pending_review until promoted (see docs/roadmap.md
 * item 4 for the corroboration/manual-review pipeline that does that).
 *
 * Public API (enqueue/pending/flush) is unchanged from V1; the storage/flush
 * mechanics have been extracted into OfflineUploadQueue so HazardReportQueue
 * can reuse them without duplicating this logic. `enqueue()` now validates
 * before storing anything — see assertValidContribution() above.
 */
export class SyncQueue extends OfflineUploadQueue<ContributedPhotoUpload, ContributionAck> {
  constructor(storage: StorageAdapter, network: NetworkAdapter, options: SyncQueueOptions = {}) {
    super(storage, network, {
      storageKeyPrefix: options.storageKeyPrefix ?? 'sync-queue/',
      uploadPath: '/contributions/photos',
    });
  }

  async enqueue(upload: ContributedPhotoUpload): Promise<void> {
    assertValidContribution(upload);
    return super.enqueue(upload);
  }
}
