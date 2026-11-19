import {
  HAZARD_VOTES,
  HazardVoteAck,
  HazardVoteUpload,
  isOptionalBoolean,
  isRecentObservationTimestamp,
  isSafeId,
  isValidEnumValue,
  isValidOptionalLatLng,
} from '@offgrid/shared';
import { NetworkAdapter, StorageAdapter } from './adapters';
import { OfflineUploadQueue } from './OfflineUploadQueue';

export interface HazardVoteQueueOptions {
  storageKeyPrefix?: string;
}

function assertValidVote(vote: HazardVoteUpload): void {
  const invalid: string[] = [];
  if (!isSafeId(vote.id)) invalid.push('id');
  if (!isSafeId(vote.incidentId)) invalid.push('incidentId');
  if (!isSafeId(vote.trailId)) invalid.push('trailId');
  if (!isValidEnumValue(vote.vote, HAZARD_VOTES)) invalid.push('vote');
  if (!isRecentObservationTimestamp(vote.observedAt)) invalid.push('observedAt');
  if (!isValidOptionalLatLng(vote.location)) invalid.push('location');
  if (!isOptionalBoolean(vote.gpsWeakOrMissing)) invalid.push('gpsWeakOrMissing');
  if (!isSafeId(vote.voterId)) invalid.push('voterId');
  if (invalid.length > 0) {
    throw new Error(`Cannot queue hazard vote — invalid field(s): ${invalid.join(', ')}`);
  }
}

/**
 * Offline queue for "Is this hazard still there?" answers (the Waze-style
 * confirmation loop). The app asks when OfflineNavigator emits
 * 'approaching_hazard'; the answer is stored here and synced on reconnect.
 * observedAt must be when the hiker answered, NOT sync time, because the
 * backend decays confidence from it.
 *
 * A vote rejected as too far away (422), or for a hazard a reviewer has since
 * closed (409), counts as a permanent rejection and moves to rejected()
 * rather than blocking the queue (see OfflineUploadQueue).
 */
export class HazardVoteQueue extends OfflineUploadQueue<HazardVoteUpload, HazardVoteAck> {
  constructor(storage: StorageAdapter, network: NetworkAdapter, options: HazardVoteQueueOptions = {}) {
    super(storage, network, {
      storageKeyPrefix: options.storageKeyPrefix ?? 'hazard-vote-queue/',
      uploadPath: '/hazards/votes',
    });
  }

  async enqueue(vote: HazardVoteUpload): Promise<void> {
    assertValidVote(vote);
    return super.enqueue(vote);
  }
}
