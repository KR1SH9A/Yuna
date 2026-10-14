/**
 * Planned component: DebateResultDtos
 * Kind: Staged public response DTO catalogue
 * Owner: Debates
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Describe the outward result produced by the existing accepted-evaluation publication use case.
 *
 * Scope:
 * Staged until consented debate mode ships.
 *
 * Planned shapes:
 * - DebateResultResponseDto: outbound authorized session/evaluation references, criterion scores,
 *   real permitted evidence references, code-computed totals, winner/tie/insufficient outcome,
 *   uncertainty/limitations and distinct publication status. Produced by DebateService's
 *   publishResult flow from the owner's accepted evaluation for the authorized audience.
 *
 * Planned methods:
 * None. No result submission or scoring request DTO is introduced here.
 *
 * Boundaries/invariants:
 * Evaluation acceptance consumes stored task results and FrozenEvaluationBinding internally;
 * callers cannot submit this response as an accepted evaluation. Mapping filters references for
 * the current audience and excludes raw provider output, private transcript/storage handles and
 * ORM objects. An accepted evaluation is not evidence of confirmed publication. Scores and
 * outcomes cannot authorize capability grants or sanctions.
 */
