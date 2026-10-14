/**
 * Planned component: ReplyPolicy
 * Kind: Pure domain policy
 * Owner: Community
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Evaluate supplied reply eligibility, audience and output restrictions.
 *
 * Planned methods:
 * - shouldConsiderReply: Input: channel mode, trusted addressing/reply/source facts,
 *   cooldown/limit eligibility and advisory relevance. Output: eligible/ignore/clarify with
 *   reasons. Respect silent/direct/proactive modes and bot-loop prevention.
 * - validateAudience: Input: source visibility, destination and authorized context/disclosure
 *   bindings. Output: allowed or rejected disclosure with reasons; requester access alone is
 *   insufficient.
 * - validateReply: Input: accepted text/references and permitted mention/media/size constraints.
 *   Output: validated reply or rejection reasons.
 *
 * Collaborators/Boundaries:
 * Plain Community values only. Services provide current facts; no ORM, Discord, queue or provider
 * calls.
 *
 * Invariants:
 * Silent conversation mode does not disable moderation. Routing cannot grant staff tools,
 * authority or private context.
 */
