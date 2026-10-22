export type ChatChannelType = 'site' | 'inspection';

export interface ChatChannel {
  type: ChatChannelType;
  id: string;
}

export interface ResolvedChannel {
  type: ChatChannelType;
  siteId: string;
  inspectionId: string | null;
  /** Socket.io room every connected participant of this channel joins. */
  room: string;
}

export interface ChatAuthor {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface ChatMessageView {
  id: string;
  channelType: ChatChannelType;
  channelId: string;
  siteId: string;
  inspectionId: string | null;
  body: string;
  createdAt: string;
  author: ChatAuthor;
  replyTo: { id: string; body: string; authorName: string } | null;
}

export interface ChatMember {
  id: string;
  name: string;
  avatarUrl: string | null;
  /** Human label for why this person is in the project, e.g. "Engineer". */
  roleLabel: string;
  online: boolean;
}

export const CHAT_REPLY_PREVIEW_LENGTH = 140;

export function roomFor(type: ChatChannelType, id: string): string {
  return `chat:${type}:${id}`;
}
