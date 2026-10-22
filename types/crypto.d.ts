export function getManifestSignPayload(manifest: any): string;
export function decodePublicKey(input: string | Uint8Array | ArrayBuffer): Uint8Array;
export function verifyManifestSignature(manifest: any, publicKey: string | Uint8Array | ArrayBuffer): Promise<boolean>;
export function verifyManifestSignature(manifest: any, signature: string, publicKey: string | Uint8Array | ArrayBuffer): Promise<boolean>;
