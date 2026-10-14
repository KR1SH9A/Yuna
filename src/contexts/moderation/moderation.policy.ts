/**
 * Planned component: ModerationPolicy
 * Kind: Pure domain policy
 * Owner: Moderation
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Evaluate supplied accepted findings, evidence coverage and a frozen rule revision to explain
 * what the conduct establishes.
 *
 * Planned methods:
 * - evaluateRule: Input: rule criteria, supported facts and required coverage. Output:
 *   established/suspected/allowed/incomplete rule assessment with reasons. Require the
 *   category-specific evidence rather than a universal model threshold.
 * - evaluateExclusions: Input: attributable context and exclusion definitions. Output: applicable
 *   quote/report/permitted-discussion/test exclusions with reasons. Do not infer trusted test
 *   authorization from a claim inside content.
 * - selectDisposition: Input: accepted rule assessments and exclusions. Output: one justified
 *   disposition and contributing finding references. Keep supported suspicion distinct from model
 *   uncertainty or technical failure.
 *
 * Collaborators/Boundaries:
 * Uses plain values from the Moderation context. No ORM access, SDK objects, queue calls, provider
 * calls or live permission queries.
 *
 * Invariants:
 * Policy decides evidence meaning only. Application/dispatch services perform live authority,
 * revision, safety, target and capacity gates. Multiple confirmed rules can contribute to one ban;
 * repeated warnings do not themselves establish a violation.
 */
