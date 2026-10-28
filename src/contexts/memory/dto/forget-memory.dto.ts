/** Forget selection is scoped to the authenticated member; no request can choose a different subject. */
export interface ForgetMemoryRequestDto { readonly expectedPrivacyRevision: number; readonly factId?: string }
export interface MemoryDeletionResponseDto { readonly deletionId: string; readonly privacyRevision: number; readonly erasedFacts: number; readonly state: 'complete' }
