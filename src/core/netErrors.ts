/**
 * Classifies a failed fetch into something a person can act on.
 *
 * Node's fetch rejects with a generic "fetch failed" and hides the real reason
 * in `cause` - a TLS verification code, a DNS failure, a refused connection.
 * Those need very different responses, and none of them is ever "turn off
 * certificate checking": this module only explains, it never relaxes anything.
 */

export interface NetworkFailure {
  code: 'certificate_error' | 'network_error';
  message: string;
  hint?: string;
}

const CERTIFICATE_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_SIGNATURE_FAILURE',
  'HOSTNAME_MISMATCH',
]);

const NETWORK_HINTS: Record<string, string> = {
  ENOTFOUND: 'The host name does not resolve. Check the URL, VPN and DNS.',
  EAI_AGAIN: 'DNS lookup failed temporarily. Check the network or VPN connection.',
  ECONNREFUSED: 'Nothing is listening at that address. Is the server running, and is the port right?',
  ECONNRESET: 'The connection was reset. A proxy or firewall may be interfering.',
  ETIMEDOUT: 'The connection timed out. Check the network, VPN or proxy.',
  UND_ERR_CONNECT_TIMEOUT: 'The connection timed out. Check the network, VPN or proxy.',
  EHOSTUNREACH: 'The host is unreachable from this machine.',
  ENETUNREACH: 'The network is unreachable from this machine.',
};

function causeChain(err: unknown): Array<{ code?: string; message?: string }> {
  const chain: Array<{ code?: string; message?: string }> = [];
  let current = err as { code?: unknown; message?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 5; depth++) {
    chain.push({
      code: typeof current.code === 'string' ? current.code : undefined,
      message: typeof current.message === 'string' ? current.message : undefined,
    });
    current = current.cause as typeof current;
  }
  return chain;
}

export function describeNetworkFailure(err: unknown): NetworkFailure {
  const chain = causeChain(err);
  const certificate = chain.find((link) => link.code && CERTIFICATE_CODES.has(link.code));
  if (certificate) {
    return {
      code: 'certificate_error',
      message: `TLS certificate could not be verified (${certificate.code})`,
      hint:
        'The server presented a certificate this machine does not trust. If your organisation uses ' +
        'its own certificate authority, install it in the OS trust store or set NODE_EXTRA_CA_CERTS ' +
        'for VS Code. Certificate checking is never disabled.',
    };
  }
  const network = chain.find((link) => link.code && NETWORK_HINTS[link.code]);
  if (network) {
    return {
      code: 'network_error',
      message: `network error (${network.code})`,
      hint: NETWORK_HINTS[network.code!],
    };
  }
  const deepest = [...chain].reverse().find((link) => link.message)?.message;
  return {
    code: 'network_error',
    message: deepest ?? 'network request failed',
    hint: 'Check the URL and the network connection.',
  };
}
