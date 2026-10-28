/** Memory ships as private, explicit user submissions; no inferred facts or public/provider copies cross this boundary. */
export interface MemoryDisclosureBinding {
  readonly installationId: string; readonly guildId: string; readonly userId: string;
  readonly scopeId: string; readonly privacyRevision: number;
  readonly facts: readonly { readonly factId: string; readonly contentHash: string }[];
}
export const memoryPurpose = 'personal_reference';
export const maximumMemoryFacts = 50;
export const memoryPageSize = 3;
