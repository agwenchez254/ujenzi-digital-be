import { createPublicKey, verify } from 'crypto';

/**
 * Everything the server does with cryptography is verification of public keys and
 * signatures. It never holds a key that can decrypt a message.
 */

/** True for a base64 SPKI-encoded NIST P-256 public key (what WebCrypto exports for ECDH / ECDSA). */
export function isValidP256PublicKey(base64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}

export interface SignedMessageFields {
  channelKey: string;
  keyEpoch: number;
  clientId: string;
  authorId: string;
  senderDeviceId: string;
  iv: string;
  ciphertext: string;
}

/**
 * The exact bytes a sending device signs. Binding the channel, epoch, author and device
 * stops a valid ciphertext being replayed into another conversation, another epoch, or
 * under another person's name.
 */
export function signedMessagePayload(fields: SignedMessageFields): Buffer {
  return Buffer.from(
    [
      'ujenzi-e2ee-v1',
      fields.channelKey,
      fields.keyEpoch,
      fields.clientId,
      fields.authorId,
      fields.senderDeviceId,
      fields.iv,
      fields.ciphertext,
    ].join('|'),
    'utf8',
  );
}

/** Verifies an ECDSA P-256 / SHA-256 signature in WebCrypto's raw (r || s) format. */
export function verifyMessageSignature(
  signingKeyBase64: string,
  fields: SignedMessageFields,
  signatureBase64: string,
): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(signingKeyBase64, 'base64'), format: 'der', type: 'spki' });
    return verify(
      'sha256',
      signedMessagePayload(fields),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}
