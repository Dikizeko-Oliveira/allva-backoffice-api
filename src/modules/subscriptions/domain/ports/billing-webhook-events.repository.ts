export type BillingWebhookEventRecord = {
  provider: 'STRIPE';
  eventKey: string;
  topic: string;
  action?: string;
  externalEventId?: string;
  resourceId: string;
  payload: Record<string, unknown>;
};

/**
 * Outcome of claiming a webhook delivery for processing.
 *
 * - `CLAIMED`: this delivery owns the event and must process it. Either it is
 *   the first delivery, or a previous attempt recorded the event but never
 *   completed (crash / transient failure). Reprocessing is safe because the
 *   downstream invoice/payment resolution is idempotent — it looks records up
 *   by their external IDs before creating anything.
 * - `ALREADY_PROCESSED`: a previous delivery completed successfully, so this is
 *   a genuine duplicate and must be skipped.
 *
 * Recording the event and marking it processed are deliberately two separate
 * steps: an event that was merely *seen* must never suppress the provider's
 * retry, otherwise a transient failure silently drops billing history.
 */
export type BillingWebhookEventClaim = 'CLAIMED' | 'ALREADY_PROCESSED';

export abstract class BillingWebhookEventsRepositoryInterface {
  abstract claim(
    event: BillingWebhookEventRecord,
  ): Promise<BillingWebhookEventClaim>;
  abstract markProcessed(eventKey: string): Promise<void>;
}
