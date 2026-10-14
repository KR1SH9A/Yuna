/**
 * Planned component: LlmService
 * Kind: Capability facade and provider adapter
 * Owner: AI worker / LLM
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Perform bounded observation or language generation on already prepared inputs.
 *
 * Planned methods:
 * - observeContent: Receive ObservationInput; return supported observations and coverage markers,
 *   preserving original source references and missing context.
 * - generateReply: Receive ReplyGenerationInput; return a candidate reply and available
 *   usage/completion information within supplied output constraints.
 * - explainFindings: Receive accepted findings and explanation constraints; return explanatory
 *   prose without changing those findings.
 *
 * Boundaries:
 * Validate provider outputs and normalize errors; never call Jev or choose a next stage. No access
 * to feature repositories, personal-memory retrieval, grants or Discord. Prompts cannot confer
 * authority. Inputs may contain malicious or misleading text.
 */
