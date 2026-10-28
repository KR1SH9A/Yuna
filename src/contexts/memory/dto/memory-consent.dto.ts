/** Explicit private-memory consent belongs only to the authenticated member in this installation. */
export interface SetMemoryConsentRequestDto { readonly granted: boolean; readonly retentionDays: number; readonly expectedPrivacyRevision: number }
export interface MemoryConsentResponseDto { readonly granted: boolean; readonly retentionDays: number; readonly privacyRevision: number; readonly erasedFacts: number }
