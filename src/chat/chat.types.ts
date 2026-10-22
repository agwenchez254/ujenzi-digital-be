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

export interface ChatAttachmentView {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
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
  attachments: ChatAttachmentView[];
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

/** Limits applied to files sent in chat. */
export const CHAT_MAX_FILES = 5;
export const CHAT_MAX_FILE_BYTES = 15 * 1024 * 1024;

// Raster images are shown inline; everything else is only ever downloaded.
// SVG and HTML are deliberately absent: both can carry script.
export const CHAT_INLINE_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

export const CHAT_ALLOWED_FILE_TYPES = new Set([
  ...CHAT_INLINE_IMAGE_TYPES,
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip',
]);

export function roomFor(type: ChatChannelType, id: string): string {
  return `chat:${type}:${id}`;
}
