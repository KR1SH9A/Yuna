/**
 * Planned component: DebateContracts
 * Kind: Plain boundary contract catalogue
 * Owner: Debates
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe the public serialized data boundary. Planned plain boundary types:
 * ProposeDebateCommand: authenticated initiator, topic, participants, visibility, limits and
 * rubric reference.
 * ParticipantConsentCommand: verified participant and exact accepted session scope.
 * TranscriptSourceInput: attributable source, author, order and revision/change markers.
 * FrozenEvaluationBinding: session, frozen transcript hash/revision, rubric revision and expected
 * task.
 * DebateResultView: criterion scores, real evidence references, code-computed totals,
 * tie/uncertainty and publication state.
 * DebateStatusView: consent and lifecycle progress without exposing private records.
 *
 * Scope:
 * Staged until debate mode ships.
 *
 * Planned methods:
 * No business methods planned. These are conceptual data shapes, not runtime services,
 * declarations or implementations.
 *
 * Collaborators/Boundaries:
 * Plain commands/results for debate interactions, transcript intake and task completion. Scoring
 * contracts describe argument evaluation only.
 *
 * Invariants:
 * Never reuse a pruned conversation buffer as the declared transcript. No score or winner result
 * can grant capability or authorize a sanction.
 */
