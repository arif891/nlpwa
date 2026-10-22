# Cryptographic Verification Plugin (`nlpwa/crypto`)

Shared Web Crypto utilities for detached Ed25519 signature signing and verification. Ensures update manifests are strictly cryptographically verified before any file is downloaded or staged.

---

## Capabilities

- **Pure Web Crypto:** Uses standard native `crypto.subtle` in browsers/Service Workers and `node:crypto` in Node.js.
- **Detached Ed25519 Signatures:** Manifest files are signed with high-performance, compact Ed25519 curves.
- **Canonical Serialization:** Deterministically canonicalizes JSON keys before hashing and signing, preventing spacing/ordering signature mismatches.

---

## Automated Build-Time Signing (CLI / CI)

When running `nlpwa update`, manifests are signed automatically if a private key is found in `.env.nlpwa` or the `NLPWA_PRIVATE_KEY` environment variable:

```bash
# Generate keypair and configure automatically:
npx nlpwa keys:generate

# Or initialize with signing enabled:
npx nlpwa init --sign

# Update manifests (automatically signs info.json & version.json):
npx nlpwa update --dir ./dist
```

---

## Runtime Verification (Browser / Service Worker)

In `nlpwa.config.js`:

```javascript
export default {
  // Public key in SPKI PEM, 64-char Hex, or Base64 format
  publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...
-----END PUBLIC KEY-----`,
};
```

When `publicKey` is configured, the Service Worker automatically validates update manifests before staging.

You can also call the verification helper directly in any Web Crypto environment:

```javascript
import { verifyManifestSignature } from 'nlpwa/crypto';

// Verifies manifest.signature against the public key
const isValid = await verifyManifestSignature(manifest, publicKey);

if (!isValid) {
  throw new Error('Manifest signature verification failed! Untrusted CDN response.');
}
```
