/**
 * Planned component: BotModule
 * Kind: Composition root
 * Owner: Bot application
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Wire the five context modules, Discord adapters and shared infrastructure. Enable Memory,
 * Debates and governance only when their feature scope is ready.
 *
 * Planned methods:
 * - None. This file declares dependency registration when implementation begins.
 *
 * Planned wiring:
 * DiscordHandlers, CompletionHandlers and RecoveryHandlers; ApprovedPlanHandlers only with
 * optional governance. Import feature modules and inject their explicitly exported services:
 * ModerationService / StaffModerationService for input, BanService / WarningService and optional
 * KickService for effect recovery; ConversationService / KnowledgeService / ReplyDeliveryService;
 * AuthorityService / SafetyService / GuildLifecycleService and optional GovernanceService;
 * MemoryService / DebateService only when enabled. Jobs bot API, Usage, Audit, Artifacts and
 * database setup supply infrastructure. Use a fresh ORM context per top-level entry point.
 * Feature DTOs, trusted caller contracts and AI schemas are plain data imports, not providers.
 *
 * Boundaries:
 * Do not load provider clients or AI-worker credentials into the bot runtime. Contexts retain
 * ownership of all business transitions.
 * Do not bypass module exports by re-registering a private feature service in the bot. Policies,
 * entities and native ORM repositories remain private to the module that owns them.
 */
