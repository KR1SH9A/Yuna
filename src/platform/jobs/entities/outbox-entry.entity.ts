/**
 * Planned component: OutboxEntry
 * Kind: Durable publication record
 * Owner: Platform / Jobs
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Bridge committed local state changes to recoverable delivery signals.
 *
 * Planned methods:
 * None. The creating owner uses Jobs in its transaction; OutboxRelay tracks delivery.
 *
 * Planned fields:
 * Message ID; tenant guild when applicable; versioned topic/kind; aggregate/task reference;
 * creation time; publication status; publication claim/attempt metadata; published time; next
 * attempt; bounded last-error classification.
 *
 * Boundaries/invariants:
 * Create the row in the same transaction as the change requiring publication. Reference the owning
 * records instead of copying unnecessary private content. Duplicate publication is valid;
 * publishing does not mean the consumer accepted work. Conditional claim/acknowledgment supports
 * multiple relay instances without an exactly-once delivery or external-effect guarantee.
 */
