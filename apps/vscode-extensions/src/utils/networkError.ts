/** Node TLS codes raised when a proxy (Zscaler etc.) re-signs HTTPS with a CA Node doesn't trust. */
const CERT_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
]);

export const CERT_HINT =
  'Your network is inspecting HTTPS traffic (for example Zscaler) and its certificate is not trusted. Ask IT for the root certificate and either install it in the system trust store or set NODE_EXTRA_CA_CERTS to its .pem file, then restart.';

/** fetch() reports TLS failures as a bare "fetch failed"; the real code is on `cause`. */
function causeCode(error: unknown): string | undefined {
  let e: any = error;
  for (let i = 0; e && i < 4; i++, e = e.cause) {
    if (typeof e.code === 'string') return e.code;
  }
  return undefined;
}

/** The error's message, plus a hint when it is really an untrusted-certificate failure. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = causeCode(error);
  return code && CERT_CODES.has(code) ? `${message} (${code}). ${CERT_HINT}` : message;
}
