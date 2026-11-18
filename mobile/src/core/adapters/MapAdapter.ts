import { GpsFix, LatLng } from '@offgrid/shared';

/**
 * Renders the offline map. A real build backs this with MapLibre GL Native
 * (@maplibre/maplibre-react-native) loading the downloaded vector tile bundle
 * referenced by TripPackage.mapTiles. Pure UI concern — not exercised by the
 * use-case integration tests in this repo, since there's no device/simulator
 * in this environment to render into. Kept here so the integration point is
 * documented for whoever wires up the native screens next.
 */
export interface MapAdapter {
  loadOfflineStyle(mbtilesUri: string): Promise<void>;
  renderRoute(route: LatLng[]): Promise<void>;
  showCurrentLocation(fix: GpsFix): Promise<void>;
}
