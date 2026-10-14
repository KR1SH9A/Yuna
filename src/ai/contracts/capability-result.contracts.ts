/**
 * Planned component: CapabilityResultContracts
 * Kind: Shared technical result vocabulary
 * Owner: AI contracts
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Define explicit execution outcomes while retaining capability-specific payloads.
 *
 * Planned methods:
 * - None. Plain discriminated result/error values and validation rules only.
 *
 * Planned values:
 * Success: validated payload for the requested capability plus available usage.
 * Uncertain: bounded reason and incomplete coverage; not an established rule finding.
 * Failure: categorized provider/validation/deadline error with bounded retry guidance.
 * ProviderUsage: request reference, measured units and known or unresolved cost.
 *
 * Boundaries:
 * This is shared error vocabulary, not a universal AiService or loosely typed payload. Provider
 * uncertainty alone cannot authorize a warning or other moderation action. Jobs owns task binding;
 * feature owners decide whether a stored result is acceptable.
 */
