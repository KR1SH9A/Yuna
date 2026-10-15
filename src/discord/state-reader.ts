/**
 * Planned component: DiscordStateReader
 * Kind: Outbound read adapter
 * Owner: Discord boundary
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Obtain the current Discord facts required by an owning feature.
 *
 * Planned methods:
 * - readExecutionFacts: Receive guild/actor/target and operation scope; return current native
 *   permissions, hierarchy and target state with completeness information.
 * - readMessage: Receive an authorized source reference; return current available source data
 *   with observation time and coverage. This cannot recover a deleted original or reconstruct
 *   pre-edit text. A REST read does not bypass missing MESSAGE_CONTENT access.
 * - readBan: Receive guild and account ID; return observed ban state without claiming attribution.
 * - readRelevantAuditEntries: Receive a bounded operation reference/time scope; return available
 *   audit evidence for the owning service to reconcile.
 *
 * Invariants:
 * Remote reads happen outside database transactions and may fail or become stale. A present ban
 * does not prove Yuna created it. Audit evidence may be unavailable. Guild member data is current
 * guild-scoped state, not a prerequisite for retaining an account target or evidence. Read
 * attachment URLs may be refreshed but are still expiring locators, not retained artifacts.
 */
