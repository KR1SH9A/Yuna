/**
 * Planned component: WorkerTaskStore
 * Kind: Restricted work-claiming and result-persistence boundary
 * Owner: Platform / Jobs
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Give workers only the prepared input and conditional writes needed for one attempt.
 *
 * Planned methods:
 * - readTaskDescriptor: authorized worker consumer and task ID -> minimal TaskDescriptor or
 *   absence. Expose stored kind/schema version and bounded routing metadata before handler
 *   selection and compatibility checks, without creating an attempt or disclosing prepared input.
 *   claimTask and releasePreparedInput still enforce current execution/eligibility gates.
 * - claimTask: task ID and executor identity -> eligible claim with attempt generation, lease and
 *   task configuration, or no claim. Atomically reject unavailable work; do not disclose the
 *   prepared payload merely because a queue message was received.
 * - releasePreparedInput: claim/generation and trusted task binding -> prepared input plus scoped
 *   artifact access, or denial. In a short transaction check lease, deadline and current
 *   eligibility/invalidation bindings before disclosure.
 * - renewLease: current claim/generation and bounded renewal -> renewed lease or loss. An expired,
 *   canceled or superseded attempt must not retain current write authority.
 * - recordResult: task/attempt generation, validated result and usage reference -> stored result
 *   reference or stale rejection. Conditionally persist once, make it discoverable for completion
 *   routing, and preserve failed/uncertain outcomes.
 *
 * Boundaries/invariants:
 * No broad prepared-input table/bucket access may bypass releasePreparedInput. No task identity,
 * guild, workflow, revision or business-decision mutation rights. Eligibility invalidation
 * serializes with input release; data already released is in flight. Provider I/O occurs after the
 * short release transaction has committed. Generation fences database writes, not an HTTP request
 * already sent to a provider. Rejecting a stale result must not discard separately recorded
 * attempt usage/liability. No domain entity imports, model calls, Discord token or exactly-once
 * remote promise.
 */
