/**
 * Planned component: GuildLifecycleService
 * Kind: Application Service
 * Owner: Administration
 * Status: Design scaffold only; not implemented.
 *
 * Responsibility:
 * Control registration, suspension and removal while each owner cleans its own data.
 *
 * Planned methods:
 * - readInstallation: Input: verified guild/source identity. Output: minimal InstallationView
 *   including current state and installationGeneration, or absence. Bot ingress uses this owner
 *   read to prepare TrustedCallerContext; it does not query private installation records. The
 *   read grants no authority, and operations revalidate current installation at admission/dispatch.
 * - registerGuild: Input: authenticated installation/current owner facts and configuration.
 *   Output: fresh or explicitly reactivated installation generation; protected actions require
 *   verified bootstrap.
 * - suspendInstallation: Input: authorized suspension or trusted platform-loss event. Output:
 *   suspended generation/state and affected admission invalidation.
 * - beginRemoval: Input: authenticated removal event/request and generation. Output: removing
 *   state, advanced generation and durable cleanup signals; stop new work before physical cleanup.
 * - completeRemoval: Input: installation and required owner cleanup acknowledgments. Output:
 *   removed status and minimal retained invalidation metadata.
 *
 * Collaborators/Boundaries:
 * Own native MikroORM queries/persistence for Administration installation records; no custom
 * repository wrapper is implied. These lifecycle methods consume trusted installation/platform
 * events, verified caller bindings or owner cleanup acknowledgments and produce InstallationView
 * or internal cleanup values from contracts.ts. They do not gain external request DTOs merely
 * for having arguments. Current Discord facts arrive through narrow verified contracts.
 * Do not import another business context; composition-root handlers route
 * approved operations to their feature owner. Nested mutations join the caller transaction.
 *
 * Invariants:
 * Reinstallation does not revive tasks, grants or deleted content. Emit cleanup signals through
 * infrastructure; do not mutate other context tables. Missing current installation state denies
 * consequential work. Feature-specific removal handlers and retention exceptions remain to be
 * specified with retention policy; completeRemoval cannot succeed until every required owner has
 * implemented and acknowledged its cleanup.
 */
