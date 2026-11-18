export interface CapturedPhoto {
  uri: string;
  capturedAt: string;
}

/**
 * Captures a photo on-device for landmark confirmation or contribution. A
 * real build backs this with react-native-vision-camera or similar.
 */
export interface CameraAdapter {
  capturePhoto(): Promise<CapturedPhoto>;
}
