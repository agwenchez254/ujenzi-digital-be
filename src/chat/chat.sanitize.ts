import { CHAT_INLINE_IMAGE_TYPES } from './chat.types';

// Control characters other than tab / newline / carriage return, and DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// Bidirectional overrides and isolates: they reorder the characters around them, which
// lets "invoice‮fdp.exe" display as "invoiceexe.pdf" or makes a message read as
// though somebody else wrote it. Zero-width joiners are left alone (emoji, Persian).
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

// Filenames are shown in the UI next to trusted content, so they also lose invisible characters.
const INVISIBLE_CHARS = /[​-‏⁠-⁤﻿]/g;

/** Message text as stored: no control or direction-spoofing characters. Never alters visible text. */
export function cleanMessageText(text: string): string {
  return text.replace(CONTROL_CHARS, '').replace(BIDI_CONTROLS, '');
}

/** A name shown to users (e.g. an attachment filename). */
export function cleanDisplayName(text: string): string {
  return cleanMessageText(text).replace(INVISIBLE_CHARS, '');
}

const startsWith = (buffer: Buffer, bytes: number[], offset = 0) =>
  buffer.length >= offset + bytes.length &&
  bytes.every((byte, i) => buffer[offset + i] === byte);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

const ZIP = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]];
const OLE = [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]];

const SIGNATURES: Record<string, (buffer: Buffer) => boolean> = {
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/gif': (b) => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')),
  'image/webp': (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  // The PDF spec tolerates a little junk before the header.
  'application/pdf': (b) => b.subarray(0, 1024).includes('%PDF-'),
  'application/zip': (b) => ZIP.some((sig) => startsWith(b, sig)),
  'application/msword': (b) => OLE.some((sig) => startsWith(b, sig)),
  'application/vnd.ms-excel': (b) => OLE.some((sig) => startsWith(b, sig)),
  'application/vnd.ms-powerpoint': (b) => OLE.some((sig) => startsWith(b, sig)),
  'text/plain': (b) => !b.subarray(0, 8000).includes(0),
  'text/csv': (b) => !b.subarray(0, 8000).includes(0),
};

// Modern Office files are ZIP containers.
for (const type of [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]) {
  SIGNATURES[type] = SIGNATURES['application/zip'];
}

/**
 * The browser-supplied Content-Type is attacker-controlled, so check the bytes really
 * are what they claim. Unknown types never match.
 */
export function contentMatchesDeclaredType(buffer: Buffer, declaredType: string): boolean {
  return SIGNATURES[declaredType]?.(buffer) ?? false;
}

export const isInlineImage = (type: string) => CHAT_INLINE_IMAGE_TYPES.includes(type);
