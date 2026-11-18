import {
  ContributedPhotoUpload,
  HAZARD_SEVERITIES,
  HAZARD_TYPES,
  HazardReportUpload,
  isOptionalBoolean,
  isSafeId,
  isSafeOptionalId,
  isSafeOptionalText,
  isValidEnumValue,
  isValidIsoTimestamp,
  isValidOptionalLatLng,
} from '@offgrid/shared';
import { SanitizedImage, sanitizeBase64Image } from './imageValidation';

export interface ValidationResult<T> {
  valid: boolean;
  errors: string[];
  value?: T;
}

/**
 * Everything a ContributedPhotoUpload needs except `id`, which the route fills
 * in (client-supplied or generated) after validation passes. `imageBase64` here
 * is the *sanitized, re-encoded* JPEG, never the bytes the client sent.
 */
export type ValidatedContributionFields = Omit<ContributedPhotoUpload, 'id'> & {
  id?: string;
  sanitizedImage: SanitizedImage;
};

/** Everything a HazardReportUpload needs except `id`, same reasoning as above. */
export type ValidatedHazardReportFields = Omit<HazardReportUpload, 'id'> & { id?: string };

const MAX_DESCRIPTION_LENGTH = 1000;

/**
 * Async because image sanitization decodes and re-encodes the photo. All the
 * cheap field checks run first, and the image is only decoded if every other
 * field is valid, so a request with a bad trailId never costs an image decode.
 */
export async function validateContributedPhotoUploadBody(
  body: unknown,
): Promise<ValidationResult<ValidatedContributionFields>> {
  const errors: string[] = [];

  if (typeof body !== 'object' || body === null) {
    return { valid: false, errors: ['request body must be a JSON object'] };
  }
  const b = body as Record<string, unknown>;

  if (!isSafeOptionalId(b.id)) {
    errors.push('id must be a safe identifier (letters, digits, "-", "_", max 128 chars) if provided');
  }
  if (!isSafeId(b.trailId)) {
    errors.push('trailId is required and must be a safe identifier');
  }
  if (!isSafeOptionalId(b.waypointHintId)) {
    errors.push('waypointHintId must be a safe identifier if provided');
  }
  if (!isValidIsoTimestamp(b.capturedAt)) {
    errors.push('capturedAt is required and must be a valid timestamp within the last/next 10 years');
  }
  if (!isValidOptionalLatLng(b.location)) {
    errors.push('location, if provided, must have lat in [-90, 90] and lng in [-180, 180]');
  }
  if (!isOptionalBoolean(b.gpsWeakOrMissing)) {
    errors.push('gpsWeakOrMissing must be a boolean if provided');
  }
  if (!isSafeId(b.contributorId)) {
    errors.push('contributorId is required and must be a safe identifier');
  }

  if (errors.length > 0) return { valid: false, errors };

  const imageResult = await sanitizeBase64Image(b.imageBase64);
  if (!imageResult.valid) {
    return { valid: false, errors: [`imageBase64 invalid: ${imageResult.error}`] };
  }

  return {
    valid: true,
    errors: [],
    value: {
      id: b.id as string | undefined,
      trailId: b.trailId as string,
      waypointHintId: b.waypointHintId as string | undefined,
      capturedAt: b.capturedAt as string,
      location: b.location as ValidatedContributionFields['location'],
      gpsWeakOrMissing: (b.gpsWeakOrMissing as boolean | undefined) ?? false,
      imageBase64: imageResult.image.jpeg.toString('base64'),
      contributorId: b.contributorId as string,
      sanitizedImage: imageResult.image,
    },
  };
}

export function validateHazardReportUploadBody(body: unknown): ValidationResult<ValidatedHazardReportFields> {
  const errors: string[] = [];

  if (typeof body !== 'object' || body === null) {
    return { valid: false, errors: ['request body must be a JSON object'] };
  }
  const b = body as Record<string, unknown>;

  if (!isSafeOptionalId(b.id)) {
    errors.push('id must be a safe identifier (letters, digits, "-", "_", max 128 chars) if provided');
  }
  if (!isSafeId(b.trailId)) {
    errors.push('trailId is required and must be a safe identifier');
  }
  if (!isSafeOptionalId(b.waypointHintId)) {
    errors.push('waypointHintId must be a safe identifier if provided');
  }
  if (!isValidEnumValue(b.hazardType, HAZARD_TYPES)) {
    errors.push(`hazardType is required and must be one of: ${HAZARD_TYPES.join(', ')}`);
  }
  if (!isValidEnumValue(b.severity, HAZARD_SEVERITIES)) {
    errors.push(`severity is required and must be one of: ${HAZARD_SEVERITIES.join(', ')}`);
  }
  if (!isSafeOptionalText(b.description, MAX_DESCRIPTION_LENGTH)) {
    errors.push(`description, if provided, must be 1-${MAX_DESCRIPTION_LENGTH} characters with no control characters`);
  }
  if (!isValidIsoTimestamp(b.reportedAt)) {
    errors.push('reportedAt is required and must be a valid timestamp within the last/next 10 years');
  }
  if (!isValidOptionalLatLng(b.location)) {
    errors.push('location, if provided, must have lat in [-90, 90] and lng in [-180, 180]');
  }
  if (!isOptionalBoolean(b.gpsWeakOrMissing)) {
    errors.push('gpsWeakOrMissing must be a boolean if provided');
  }
  if (!isSafeId(b.reporterId)) {
    errors.push('reporterId is required and must be a safe identifier');
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    value: {
      id: b.id as string | undefined,
      trailId: b.trailId as string,
      waypointHintId: b.waypointHintId as string | undefined,
      hazardType: b.hazardType as ValidatedHazardReportFields['hazardType'],
      severity: b.severity as ValidatedHazardReportFields['severity'],
      description: b.description as string | undefined,
      reportedAt: b.reportedAt as string,
      location: b.location as ValidatedHazardReportFields['location'],
      gpsWeakOrMissing: (b.gpsWeakOrMissing as boolean | undefined) ?? false,
      reporterId: b.reporterId as string,
    },
  };
}
