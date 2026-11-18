/**
 * Talks to the OffGrid backend when the device has connectivity. A real build
 * backs this with fetch + NetInfo (for isOnline); tests use a fake with
 * canned responses (see testUtils/mockAdapters.ts).
 */
export interface NetworkAdapter {
  isOnline(): Promise<boolean>;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}
