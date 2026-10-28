/**
 * Warning intent is created by ModerationWorkflowService from accepted policy findings and dispatched
 * by ActionExecutionService through DiscordModerationTransport. This consolidated implementation owns
 * permission checks, one durable attempt, exact message attribution and retention. Delivery failure
 * never upgrades a finding or permits a second send while the first outcome remains unknown.
 */
