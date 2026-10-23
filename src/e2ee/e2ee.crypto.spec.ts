import { generateKeyPairSync, sign } from 'crypto';
import {
  isValidP256PublicKey,
  signedMessagePayload,
  SignedMessageFields,
  verifyMessageSignature,
} from './e2ee.crypto';

const spki = (key: import('crypto').KeyObject) =>
  key.export({ type: 'spki', format: 'der' }).toString('base64');

const fields: SignedMessageFields = {
  channelKey: 'chat:site:s1',
  keyEpoch: 2,
  clientId: 'c-1',
  authorId: 'u1',
  senderDeviceId: 'd1',
  iv: 'aXY=',
  ciphertext: 'Y2lwaGVy',
};

function signWith(privateKey: import('crypto').KeyObject, f: SignedMessageFields) {
  return sign('sha256', signedMessagePayload(f), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
}

describe('isValidP256PublicKey', () => {
  it('accepts a P-256 SPKI key', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(isValidP256PublicKey(spki(publicKey))).toBe(true);
  });

  it('rejects other curves, other key types and junk', () => {
    expect(isValidP256PublicKey(spki(generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey))).toBe(false);
    expect(isValidP256PublicKey(spki(generateKeyPairSync('ed25519').publicKey))).toBe(false);
    expect(isValidP256PublicKey('not a key')).toBe(false);
    expect(isValidP256PublicKey('')).toBe(false);
  });
});

describe('verifyMessageSignature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signingKey = spki(publicKey);
  const signature = signWith(privateKey, fields);

  it('accepts a signature from the registered device over the exact fields', () => {
    expect(verifyMessageSignature(signingKey, fields, signature)).toBe(true);
  });

  it.each([
    ['ciphertext', { ciphertext: 'dGFtcGVy' }],
    ['iv', { iv: 'eHg=' }],
    ['epoch', { keyEpoch: 1 }],
    ['conversation', { channelKey: 'chat:site:s2' }],
    ['author', { authorId: 'u2' }],
    ['device', { senderDeviceId: 'd2' }],
    ['client id', { clientId: 'c-2' }],
  ])('rejects the signature when the %s is changed', (_label, change) => {
    expect(verifyMessageSignature(signingKey, { ...fields, ...change }, signature)).toBe(false);
  });

  it('rejects a signature made by a different key', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(verifyMessageSignature(signingKey, fields, signWith(other.privateKey, fields))).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    expect(verifyMessageSignature('garbage', fields, signature)).toBe(false);
    expect(verifyMessageSignature(signingKey, fields, 'AAAA')).toBe(false);
    expect(verifyMessageSignature(signingKey, fields, '')).toBe(false);
  });
});
