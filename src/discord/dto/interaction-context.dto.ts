/** Transport-derived identity. Installation identity and permission checks belong to composition/Administration. */
export interface DiscordCommandIdentity {
  readonly actorId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly sourceRequestId: string;
}

/** A full private review may carry one bounded UTF-8 attachment so consent text never needs silent truncation. */
export type DiscordCommandResponse = string | {
  readonly content: string;
  readonly attachment: { readonly filename: string; readonly content: string };
};
