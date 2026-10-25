import { AsyncEntry } from '@napi-rs/keyring';

const SERVICE = 'atlassian-mcp';

/** The keychain entry holding the API token for one site and account. */
export function tokenEntry(site: string, email: string): AsyncEntry {
  return new AsyncEntry(SERVICE, `${email} ${site}`);
}

/** Atlassian API tokens, masked even when the exact secret is unknown. */
const TOKEN = /ATATT[\w=-]{8,}/g;

/**
 * "Basic" and a base64 run, with whitespace also as the escapes JSON uses for control characters
 * ("\n", "\u000b"), as in serialized tool output. Only runs that decode to a credential are masked.
 */
const BASIC = /Basic(?:\s|\\[bfnrt]|\\u00[01][0-9a-fA-F])+([A-Za-z0-9+/]{16,}={0,2})/g;

/** What ends readable text in a decoded credential: control characters and invalid UTF-8. */
// Matching control characters is the point of this pattern.
// oxlint-disable-next-line no-control-regex
const UNREADABLE = /[\u0000-\u001f\u007f\ufffd]/;

/**
 * A Basic credential is base64 of readable "user:password". Base64 decodes in groups of four
 * characters, so text glued onto the end only spoils the end: the readable start is what counts.
 * Words such as "Internationalization" after "Basic" decode to bytes that aren't readable text.
 */
function isBasicCredential(encoded: string): boolean {
  const readable = Buffer.from(encoded, 'base64').toString('utf8').split(UNREADABLE)[0] ?? '';
  return readable.length >= 8 && readable.includes(':');
}

/** Masks the given secrets and their base64 encodings. Safe on fragments of a larger text. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    // Masking a very short value would mangle unrelated text.
    if (secret.length < 4) {
      continue;
    }

    result = result.replaceAll(secret, '[redacted]');
    result = result.replaceAll(Buffer.from(secret).toString('base64'), '[redacted]');
  }

  return result;
}

/**
 * maskSecrets plus token-shaped strings. Use on complete text only: masking a token-shaped head
 * of a fragment would leave its tail to be joined, and no longer matched, later.
 */
export function redact(text: string, secrets: readonly string[]): string {
  return maskSecrets(text, secrets)
    .replace(TOKEN, '[redacted]')
    .replace(BASIC, (match, encoded: string) =>
      isBasicCredential(encoded) ? '[redacted]' : match,
    );
}
