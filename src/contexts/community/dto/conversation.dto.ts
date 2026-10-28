/** Current conversation admission, channel settings and bounded operational views; no private message content in status. */
export type ConversationAdmission = 'admitted' | 'duplicate' | 'ignored' | 'busy';
export interface ChannelReplySettingsDto {
  channelId: string; mode: 'silent' | 'direct' | 'proactive'; rowRevision: number;
}
/** Only the released direct and silent modes can be configured. */
export interface ChannelReplySettingsUpdate {
  channelId: string; mode: 'silent' | 'direct'; expectedRowRevision: number | null;
}
export interface CommunityOperationalStatus {
  pendingRequests: number; readyDeliveries: number; unknownDeliveries: number;
}
