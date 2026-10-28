/**
 * Debates composition reference. apps/bot/bot.module.ts wires DebateService and
 * DebatePublicationService directly; the worker owns DebateTaskHandlers and JevService.
 * There is no Nest dependency-injection module or exported repository.
 *
 * DebateService owns the six scoped records, explicit participant consent, submitted text,
 * immutable transcript/rubric binding, paired typed scoring, acceptance and cleanup.
 * DebatePublicationService performs current authorization checks around one committed send
 * and reconciles unknown outcomes. Scores never grant permissions or trigger moderation.
 *
 * The public interaction surface is the Debate service and its plain DTOs. Database entities,
 * scoring arithmetic, task claims and native Discord transport remain owner-private details.
 */
