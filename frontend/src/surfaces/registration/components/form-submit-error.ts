/**
 * Register popup (owner 2026-11-17): a save step after the form's own
 * validation failed, with a message for the form's alert line (the per-field
 * errors are shown by the caller's section). Nothing about the request body
 * (financial fields included) is ever in the message.
 */
export class FormSubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormSubmitError';
  }
}
