import { assertSecureConfig } from '../common/config/assert-secure-config';
import { resolveAllowedOrigins } from '../common/config/allowed-origins';
import { RealtimeIoAdapter } from '../realtime/realtime-io.adapter';
import { TokenBucket } from '../realtime/socket-rate-limit';
import { ChatGateway } from './chat.gateway';
import { cleanDisplayName, cleanMessageText, contentMatchesDeclaredType } from './chat.sanitize';

const bytes = (...b: number[]) => Buffer.from(b);

describe('message text sanitising', () => {
  it('removes direction overrides that can disguise text or filenames', () => {
    expect(cleanMessageText('invoice‮fdp.exe')).toBe('invoicefdp.exe');
    expect(cleanMessageText('a⁦b⁩c')).toBe('abc');
  });

  it('removes control characters but keeps newlines, tabs and emoji joiners', () => {
    expect(cleanMessageText('a\u0000b\u0007c')).toBe('abc');
    expect(cleanMessageText('line1\nline2\tx')).toBe('line1\nline2\tx');
    const family = '👨‍👩‍👧';
    expect(cleanMessageText(family)).toBe(family);
  });

  it('also strips invisible characters from display names', () => {
    expect(cleanDisplayName('re​port﻿.pdf')).toBe('report.pdf');
  });
});

describe('attachment content checks', () => {
  it('accepts content that matches the declared type', () => {
    expect(contentMatchesDeclaredType(bytes(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg')).toBe(true);
    expect(contentMatchesDeclaredType(Buffer.from('%PDF-1.7 ...'), 'application/pdf')).toBe(true);
    expect(contentMatchesDeclaredType(bytes(0x50, 0x4b, 0x03, 0x04), 'application/zip')).toBe(true);
    expect(
      contentMatchesDeclaredType(
        bytes(0x50, 0x4b, 0x03, 0x04),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true);
    expect(contentMatchesDeclaredType(Buffer.from('a,b\n1,2'), 'text/csv')).toBe(true);
  });

  it('rejects HTML or script labelled as an image or PDF', () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect(contentMatchesDeclaredType(html, 'image/png')).toBe(false);
    expect(contentMatchesDeclaredType(html, 'application/pdf')).toBe(false);
    expect(contentMatchesDeclaredType(html, 'image/jpeg')).toBe(false);
  });

  it('rejects an executable posing as text, and unknown types', () => {
    expect(contentMatchesDeclaredType(Buffer.from([0x4d, 0x5a, 0x00, 0x00]), 'text/plain')).toBe(false);
    expect(contentMatchesDeclaredType(Buffer.from('x'), 'application/x-msdownload')).toBe(false);
  });
});

describe('TokenBucket', () => {
  it('allows a burst then refuses, and recovers over time', () => {
    const bucket = new TokenBucket(3, 1, 0);
    expect([1, 2, 3, 4].map(() => bucket.take(0))).toEqual([true, true, true, false]);
    expect(bucket.take(1000)).toBe(true);
    expect(bucket.take(1000)).toBe(false);
  });
});

describe('socket event rate limiting', () => {
  it('rejects events past the budget and drops a socket that keeps flooding', async () => {
    const chatService = { setReceiptPublisher: jest.fn(), resolveChannel: jest.fn() };
    const gateway = new ChatGateway(chatService as never);
    const disconnect = jest.fn();
    const client = {
      data: { ready: Promise.resolve(), userId: 'u1', roles: [] },
      rooms: new Set<string>(),
      disconnect,
      to: () => ({ emit: jest.fn() }),
      leave: jest.fn(),
    };
    const results: boolean[] = [];
    for (let i = 0; i < 80; i++) {
      results.push((await gateway.leave(client as never, { type: 'site', id: 's1' })).ok);
    }
    expect(results.slice(0, 30).every(Boolean)).toBe(true);
    expect(results.slice(35).every((ok) => !ok)).toBe(true);
    expect(disconnect).toHaveBeenCalledWith(true);
  });
});

describe('socket origin policy', () => {
  const adapter = new RealtimeIoAdapter({} as never, ['https://app.example.com']);

  it('allows the frontend and clients that send no Origin', () => {
    expect(adapter.isOriginAllowed('https://app.example.com')).toBe(true);
    expect(adapter.isOriginAllowed(undefined)).toBe(true);
  });

  it('rejects any other website (cross-site WebSocket hijacking)', () => {
    expect(adapter.isOriginAllowed('https://evil.example.net')).toBe(false);
    expect(adapter.isOriginAllowed('https://app.example.com.evil.net')).toBe(false);
  });

  it('keeps the same origin list the HTTP CORS policy uses', () => {
    expect(resolveAllowedOrigins('https://app.example.com')).toEqual(
      expect.arrayContaining(['https://app.example.com', 'http://localhost:5173']),
    );
    expect(resolveAllowedOrigins('https://app.example.com')).not.toContain('http://localhost:3000');
  });
});

describe('assertSecureConfig', () => {
  const strong = (c: string) => c.repeat(40);
  const prod = {
    NODE_ENV: 'production',
    JWT_ACCESS_SECRET: strong('a'),
    JWT_REFRESH_SECRET: strong('b'),
    CSRF_SECRET: strong('c'),
  } as NodeJS.ProcessEnv;

  it('passes with distinct, long secrets', () => {
    expect(() => assertSecureConfig(prod)).not.toThrow();
  });

  it('refuses short, missing, placeholder or reused secrets in production', () => {
    expect(() => assertSecureConfig({ ...prod, JWT_ACCESS_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => assertSecureConfig({ ...prod, CSRF_SECRET: undefined })).toThrow(/CSRF_SECRET is not set/);
    expect(() =>
      assertSecureConfig({ ...prod, JWT_REFRESH_SECRET: 'replace-with-a-different-long-random-string' }),
    ).toThrow(/placeholder/);
    expect(() => assertSecureConfig({ ...prod, JWT_REFRESH_SECRET: prod.JWT_ACCESS_SECRET })).toThrow(
      /different from each other/,
    );
  });

  it('does not block local development', () => {
    expect(() => assertSecureConfig({ NODE_ENV: 'development' })).not.toThrow();
  });
});
