import { GpsFix } from '@offgrid/shared';

/**
 * Reads the device's GPS chip. Important: this works fully offline — GPS
 * needs sky view, not wifi/cellular — so this adapter has no network
 * dependency at all. A real build backs it with react-native-geolocation or
 * similar; tests feed it a scripted sequence of fixes.
 */
export interface GpsAdapter {
  getCurrentFix(): Promise<GpsFix>;
  /** Returns an unsubscribe function. */
  watchPosition(onFix: (fix: GpsFix) => void): () => void;
}
