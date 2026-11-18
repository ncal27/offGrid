import {
  HAZARD_SEVERITIES,
  HAZARD_TYPES,
  HazardReportAck,
  HazardReportUpload,
  isOptionalBoolean,
  isSafeId,
  isSafeOptionalId,
  isSafeOptionalText,
  isValidEnumValue,
  isValidIsoTimestamp,
  isValidOptionalLatLng,
} from '@offgrid/shared';
import { NetworkAdapter, StorageAdapter } from './adapters';
import { OfflineUploadQueue } from './OfflineUploadQueue';

export interface HazardReportQueueOptions {
  storageKeyPrefix?: string;
}

const MAX_DESCRIPTION_LENGTH = 1000;

/** Same reasoning as SyncQueue's assertValidContribution — cheap client-side check, not the authoritative one. */
function assertValidHazardReport(upload: HazardReportUpload): void {
  const invalidFields: string[] = [];
  if (!isSafeId(upload.id)) invalidFields.push('id');
  if (!isSafeId(upload.trailId)) invalidFields.push('trailId');
  if (!isSafeOptionalId(upload.waypointHintId)) invalidFields.push('waypointHintId');
  if (!isValidEnumValue(upload.hazardType, HAZARD_TYPES)) invalidFields.push('hazardType');
  if (!isValidEnumValue(upload.severity, HAZARD_SEVERITIES)) invalidFields.push('severity');
  if (!isSafeOptionalText(upload.description, MAX_DESCRIPTION_LENGTH)) invalidFields.push('description');
  if (!isValidIsoTimestamp(upload.reportedAt)) invalidFields.push('reportedAt');
  if (!isValidOptionalLatLng(upload.location)) invalidFields.push('location');
  if (!isOptionalBoolean(upload.gpsWeakOrMissing)) invalidFields.push('gpsWeakOrMissing');
  if (!isSafeId(upload.reporterId)) invalidFields.push('reporterId');

  if (invalidFields.length > 0) {
    throw new Error(`Cannot queue hazard report — invalid field(s): ${invalidFields.join(', ')}`);
  }
}

/**
 * Queues hiker-submitted hazard/wash-out reports locally while offline, then
 * flushes them to the backend once the device reconnects — same offline
 * -first shape as SyncQueue (landmark photo contributions), built on the
 * same OfflineUploadQueue engine. `enqueue()` validates before storing
 * anything, same reasoning as SyncQueue.
 */
export class HazardReportQueue extends OfflineUploadQueue<HazardReportUpload, HazardReportAck> {
  constructor(storage: StorageAdapter, network: NetworkAdapter, options: HazardReportQueueOptions = {}) {
    super(storage, network, {
      storageKeyPrefix: options.storageKeyPrefix ?? 'hazard-queue/',
      uploadPath: '/hazards/reports',
    });
  }

  async enqueue(upload: HazardReportUpload): Promise<void> {
    assertValidHazardReport(upload);
    return super.enqueue(upload);
  }
}
