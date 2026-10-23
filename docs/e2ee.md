# End-to-end encrypted chat: protocol for the apps

The server never sees a message, an attachment, a file name, or any key that can decrypt
them. It stores ciphertext and public keys, and enforces who may take part. **All
encryption, decryption and signing happens in the apps**, using the Web Crypto API (or the
equivalent primitives on mobile). This document is what both apps must implement.

## Primitives

| Purpose | Algorithm |
| --- | --- |
| Device encryption key (receives conversation keys) | ECDH, NIST P-256 |
| Device signing key (proves who sent a message) | ECDSA, P-256, SHA-256, raw `r‖s` signatures |
| Conversation key (one per *epoch*) | 256-bit AES-GCM key, random |
| Message and attachment encryption | AES-256-GCM, fresh random 12-byte IV every time |
| Key wrapping | ephemeral ECDH → HKDF-SHA-256 → AES-256-GCM |
| Key backup | passphrase → PBKDF2-SHA-256 (≥ 600 000 iterations) or Argon2id → AES-256-GCM |

Public keys are exported as **base64 SPKI**. Binary values are base64 on the wire.

## Concepts

- **Device**: one browser or phone. Each generates its own ECDH and ECDSA key pairs. Private
  keys are stored non-extractable where the platform allows, and never uploaded except in the
  passphrase-encrypted backup.
- **Epoch**: one generation of a conversation's shared key. Epochs count up from 1. A new
  epoch is created when somebody leaves or a device is revoked, so they cannot read what
  comes next. Old epochs are kept so history stays readable.
- **Wrap**: the epoch key encrypted for one device. Each member device gets its own wrap.
- **Members only**: once a conversation is encrypted, administrators and engineers who are
  not members of the project can no longer open it. This is intentional.

## Setting up a device (first login on a device)

1. Generate an ECDH pair and an ECDSA pair.
2. `POST /e2ee/devices` `{ label, encryptionKey, signingKey }` → `{ id, ... }`. Keep `id`.
3. Create the backup (see below) so history survives a lost device.

## Key backup and restore

The backup is the private keys, encrypted on the device with a passphrase the server never
sees. A forgotten passphrase means lost history; there is no server-side recovery.

- `PUT /e2ee/backup` `{ blob, salt, kdf: { algorithm, iterations }, version? }`
- `GET /e2ee/backup` → same fields. Rate limited (5/min) and audit logged.
- `DELETE /e2ee/backup`

To restore on a new device: log in, `GET /e2ee/backup`, derive the key from the passphrase,
decrypt, then register the new device (step 2 above). The restored key pair can be the
original device's, or a fresh pair for the new device; a fresh pair is safer, in which case
an existing device or the restored keys must share old epochs with it (see *New device*).

## Starting or rotating a conversation's key

1. `GET /chat/:type/:id/keys/status` →
   `{ encrypted, epoch, rotationRequired, missingDevices[], membersWithoutDevices[] }`.
2. `GET /chat/:type/:id/keys/directory` → every device of the members (and of former members
   whose messages are still in the history): `{ id, userId, label, encryptionKey, signingKey, revoked, member }`.
3. If `epoch` is 0, or `rotationRequired` is true:
   - generate a random 256-bit key,
   - for each **active** device of each **current** member (`!revoked && member`), wrap it:
     generate an ephemeral ECDH pair, derive an AES key with HKDF-SHA-256 from
     `ECDH(ephemeralPrivate, deviceEncryptionKey)` (info = `"ujenzi-e2ee-v1-wrap"`), AES-GCM
     encrypt the epoch key, with associated data `channelKey|epoch|deviceId`,
   - `POST /chat/:type/:id/keys/epochs` `{ epoch: current + 1, deviceId, wraps: [{ deviceId, wrappedKey, ephemeralKey, iv }] }`.
     Your own device must be among the wraps.
   - `409 STALE_KEY_EPOCH` means another member got there first: re-fetch status and use theirs.
4. If only `missingDevices` is non-empty (new member or device, no departures), wrap the
   **existing** epoch key for those devices and `POST /chat/:type/:id/keys/wraps`
   `{ epoch, wraps }`. Do this for older epochs too if the person should read history.

`channelKey` is `chat:site:<siteId>` or `chat:inspection:<inspectionId>`.

Fetch your copies with `GET /chat/:type/:id/keys/mine` → `[{ epoch, createdByDeviceId, deviceId, wrappedKey, ephemeralKey, iv }]`,
unwrap with your device's ECDH private key, and cache the epoch keys.

Listen for the socket event `chat:keys` `{ channelType, channelId, epoch }` and re-fetch status.

The server refuses key operations from non-members, wraps for devices outside the
conversation, and out-of-order epochs.

## Sending a message

1. Build the content as JSON, e.g. `{ "text": "...", "attachments": [ ... ] }`, and encrypt it
   with the current epoch key. IV random; associated data `channelKey|epoch|authorId|clientId`.
2. Generate `clientId` (random, `[A-Za-z0-9_-]`, ≤ 64). It is required for encrypted
   messages and doubles as the offline-retry idempotency key.
3. Sign this exact UTF-8 string with the device's ECDSA key (SHA-256, raw `r‖s`):

   ```
   ujenzi-e2ee-v1|<channelKey>|<keyEpoch>|<clientId>|<authorId>|<senderDeviceId>|<iv>|<ciphertext>
   ```

   (`iv` and `ciphertext` exactly as sent, base64.)
4. `POST /chat/:type/:id/messages` with `ciphertext, iv, keyEpoch, senderDeviceId, signature,
   clientId` and **no `body`**. Optional `replyToId`.

The server rejects (with `error` codes where the app should react):

| Status / `error` | Meaning | App action |
| --- | --- | --- |
| 409 `KEYS_NOT_INITIALISED` | no key yet | publish epoch 1, retry |
| 409 `KEY_ROTATION_REQUIRED` | someone who left (or a revoked device) still holds the key | publish a new epoch, retry |
| 409 `STALE_KEY_EPOCH` | encrypted under an old epoch | fetch status, re-encrypt, retry |
| 403 signature invalid / unknown device | not signed by one of your active devices | do not retry |
| 400 plaintext in an encrypted conversation | downgrade attempt | encrypt |

### Attachments

Encrypt each file with its own random AES-256-GCM key and IV **before** upload. Send the
upload as `application/octet-stream`. Put the real file name, MIME type, file key, IV and a
SHA-256 of the uploaded ciphertext inside the encrypted message JSON. The server stores only
opaque bytes (name `encrypted`). On download, check the SHA-256, then decrypt.

## Receiving a message

Messages with an `e2ee` object have an empty `body`:

```json
{ "e2ee": { "ciphertext": "...", "iv": "...", "keyEpoch": 2, "senderDeviceId": "...", "signature": "..." } }
```

1. **Verify the signature first**, using the sender device's `signingKey` from the directory
   and the same string as above. Never trust `author` alone: every member holds the
   conversation key, so only the signature proves who wrote a message.
   Check the device belongs to `author.id`. Show a warning, not the text, on failure.
2. Decrypt with the epoch key for `keyEpoch`.
3. A message **without** `e2ee` in an encrypted conversation is plaintext that should not be
   there (legacy history, or tampering). Show it marked "not encrypted".

Reply previews, notifications and push messages carry no text for encrypted messages
(`"Sent a message"`); the app builds previews locally after decrypting.

## What the server can and cannot see

Can: who is in a conversation, who sent each message and when, message and attachment sizes,
delivery and read state, device public keys.
Cannot: message text, attachment names, types or contents, any private or conversation key.

Limits, by design of this scheme: no forward secrecy within an epoch (compromise of an epoch
key exposes that epoch's messages), and a malicious server could withhold or reorder
messages or hand out a substitute device key. Verify device fingerprints out of band for
high-stakes conversations.

## Server configuration

`CHAT_E2EE_MODE`: `optional` (default) makes a conversation encrypted and members-only once
its first key is published. `required` makes every conversation encrypted. Set `required`
once both apps ship.
