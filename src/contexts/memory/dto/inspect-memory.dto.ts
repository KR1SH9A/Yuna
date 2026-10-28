/** Private memory display deliberately excludes vectors, internal storage references and other members' identities. */
import type { MemoryConsentResponseDto } from './memory-consent.dto.js';
export interface InspectMemoryRequestDto { readonly query?: string; readonly offset?: number }
export interface OwnMemoryFactsResponseDto extends MemoryConsentResponseDto {
  readonly facts: readonly { readonly factId: string; readonly text: string; readonly acceptedAt: string; readonly expiresAt: string }[];
  readonly nextOffset: number | null;
}
export interface RememberMemoryRequestDto { readonly text: string; readonly expectedPrivacyRevision: number }
export interface RememberMemoryResponseDto { readonly factId: string; readonly privacyRevision: number; readonly expiresAt: string; readonly duplicate: boolean }
