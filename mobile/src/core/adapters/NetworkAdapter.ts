/**
 * Talks to the OffGrid backend when the device has connectivity. A real build
 * backs this with fetch + NetInfo (for isOnline); tests use a fake with
 * canned responses (see testUtils/mockAdapters.ts).
 *
 * Contract for failures: when the server answers with a non-2xx status,
 * implementations MUST throw an `HttpError` carrying that status. Any other
 * thrown error (timeout, DNS, connection reset) is treated as a transient
 * network failure. OfflineUploadQueue relies on that distinction to decide
 * whether to retry an upload later or give up on it.
 */
export interface NetworkAdapter {
  isOnline(): Promise<boolean>;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message = `HTTP ${status}`,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /**
   * 4xx means "this request will never succeed as sent" (bad data, unknown
   * trail, ID conflict), except 408 (timeout) and 429 (rate limited), which
   * are worth retrying later. 5xx is the server's problem, so retry.
   */
  get isPermanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}
