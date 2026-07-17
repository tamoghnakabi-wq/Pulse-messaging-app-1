declare module '@shared/e2e-media-crypto' {
  export const MEDIA_E2E_PREFIX_V1: string;
  export const MEDIA_E2E_PREFIX_V2: string;
  export const MEDIA_MAGIC: Uint8Array;
  export const MEDIA_FORMAT_VERSION: number;
  export const MEDIA_CHUNK_SIZE: number;

  export function isE2EMediaMeta(meta?: string | null): boolean;

  export interface EncryptMediaResult {
    ciphertext: ArrayBuffer;
    e2eMeta: string;
    originalName: string;
    mimeType: string;
    plaintextSize: number;
    contentHash: string;
    ciphertextHash: string;
  }

  export interface DecryptMediaResult {
    plaintext: ArrayBuffer;
    originalName: string;
    mimeType: string;
    size: number;
    contentHash: string;
  }

  export function encryptMediaWithConversationKey(
    conversationKey: CryptoKey,
    plaintextBuf: ArrayBuffer,
    opts?: { originalName?: string; mimeType?: string }
  ): Promise<EncryptMediaResult>;

  export function decryptMediaWithConversationKey(
    conversationKey: CryptoKey,
    ciphertext: ArrayBuffer,
    e2eMeta: string
  ): Promise<DecryptMediaResult | null>;
}
