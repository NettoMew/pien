/**
 * A question from the guest answered with no (ask.ts): what to tell the
 * guest, and the status its command returns.
 */
export class No extends Error {
  readonly status: number;
  constructor(message: string, status = 1) {
    super(message);
    this.status = status;
  }
}
