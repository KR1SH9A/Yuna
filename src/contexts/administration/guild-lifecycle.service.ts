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
 *   including installationId, guildId, immutable generation, product state and observed Discord
 *   availability, or absence. Bot ingress uses this owner read to prepare TrustedCallerContext; it does not query private installation records. The
 *   read grants no authority, and operations revalidate current installation at admission/dispatch.
 * - registerGuild: Input: authenticated installation/current owner facts and configuration.
 *   Output: existing current installation or fresh immutable installation row/generation under a
 *   guild lock after verified removal/reinstallation; protected actions require verified bootstrap.
 * - recordAvailability: Input: trusted Discord availability observation. Output: readiness update;
 *   a temporary outage or cache miss never suspends/removes an installation or changes generation.
 * - suspendInstallation/resumeInstallation: Input: authorized cause and exact installation/revision.
 *   Output: changed product admission state within the same generation; canceled work never revives.
 * - beginRemoval: Input: confirmed removal/request and exact installation. Output: removing state
 *   and captured required-owner cleanup signals; stop new work before physical cleanup.
 * - recordCleanupProgress: Input: exact installation and owner acknowledgment/retry disposition.
 *   Output: idempotent recorded progress; late cleanup never addresses the current guild by ID alone.
 * - updateUsagePolicy: Input: authorized exact installation, expected policy revision and validated
 *   limit/window values. Output: revised current policy; serialize with reservation admission and
 *   preserve existing snapshots/spend/liabilities, including applicable prior-installation spend.
 * - setFeatureAdmission: Input: authorized feature admission and drain/cancel choice. Output: revised
 *   settings while completion/cleanup routes remain available for outstanding work.
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
