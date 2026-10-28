/**
 * Ban/unban coordination is implemented by StaffModerationService and ActionExecutionService.
 * StaffModerationService admits explicit current-authorized staff requests; ModerationWorkflowService
 * creates policy bans only from accepted original-evidence findings. ActionExecutionService shares
 * one target gate and durable attempt across ban/unban/warning, so conflicting effects and ambiguous
 * outcomes follow one reviewed implementation instead of separate competing coordinators.
 */
