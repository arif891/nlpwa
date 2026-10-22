# Cryptographic Verification Plugin (`nlpwa/crypto`)

Shared Web Crypto utilities for detached Ed25519 signature signing and verification. Ensures update manifests are strictly cryptographically verified before any file is downloaded or staged.

---

## Capabilities

- **Pure Web Crypto:** Uses standard native `crypto.subtle` in browsers/Service Workers and `node:crypto` in Node.js.
- **Detached Ed25519 Signatures:** Manifest files are signed with high-performance, compact Ed25519 curves.
- **Canonical Serialization:** Deterministically canonicalizes JSON keys before hashing and signing, preventing spacing/ordering signature mismatches.

---

## Build-Time Signing (Node.js / CI)

```javascript
import { signManifestSync } from 'nlpwa/crypto';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('dist/api/update/info.json', 'utf8'));
const privateKeyPem = process.env.NLPWA_SIGNING_PRIVATE_KEY;

// Signs manifest and attaches manifest.signature
const signedManifest = signManifestSync(manifest, privateKeyPem);
fs.writeFileSync('dist/api/update/info.json', JSON.stringify(signedManifest, null, 2));
```

---

## Runtime Verification (Browser / Service Worker)

In `nlpwa.config.js`:

```javascript
export default {
  security: {
    // Public key in SPKI PEM or base64 format
    publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...
-----END PUBLIC KEY-----`,
  },
};
```

Or call the verification helper directly:

```javascript
import { verifyManifestSignature } from 'nlpwa/crypto';

const isValid = await verifyManifestSignature(manifest, manifest.signature, publicKey);
if (!isValid) {
  throw new Error('Manifest signature verification failed! Untrusted CDN response.');
}
```
