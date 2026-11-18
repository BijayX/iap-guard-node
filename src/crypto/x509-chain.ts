import { X509Certificate, type KeyObject } from 'node:crypto';
import { base64Decode } from './base64url.js';
import { hasExtension, parseCertificate, type ParsedCertificate } from './der.js';

/** Marker OIDs Apple places on its StoreKit signing certificates. */
export const APPLE_LEAF_OID = '1.2.840.113635.100.6.11.1';
export const APPLE_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainError';
  }
}

export interface TrustedRoot {
  certificate: X509Certificate;
  parsed: ParsedCertificate;
}

/** Loads a trust anchor from PEM text or DER bytes. Throws on anything that isn't a certificate. */
export function loadRoot(input: string | Uint8Array): TrustedRoot {
  const data = typeof input === 'string' ? input : Buffer.from(input);
  const certificate = new X509Certificate(data);
  return { certificate, parsed: parseCertificate(certificate.raw) };
}

function validAt(parsed: ParsedCertificate, date: Date): boolean {
  const t = date.getTime();
  return parsed.notBefore.getTime() <= t && t <= parsed.notAfter.getTime();
}

function issuedBy(child: X509Certificate, issuer: X509Certificate): boolean {
  return (
    child.issuer === issuer.subject && child.checkIssued(issuer) && child.verify(issuer.publicKey)
  );
}

/**
 * Verifies an Apple `x5c` chain (SPEC §5.2 steps 2–7) and returns the leaf public key.
 *
 * - exactly three standard-base64 DER certificates; `x5c[2]` is never trusted
 * - intermediate signed by (and issued by the subject of) a configured root
 * - leaf signed by the intermediate; intermediate is a CA
 * - Apple marker OIDs read from each certificate's extensions
 * - leaf, intermediate and root valid at `effectiveDate`
 */
export function verifyAppleChain(
  x5c: unknown,
  roots: readonly TrustedRoot[],
  effectiveDate: Date,
): KeyObject {
  if (!Array.isArray(x5c) || x5c.length !== 3) {
    throw new ChainError('x5c must contain exactly three certificates');
  }
  const [leafDer, intermediateDer] = x5c.slice(0, 2).map((entry) => {
    const der = typeof entry === 'string' ? base64Decode(entry) : null;
    if (!der) throw new ChainError('x5c entries must be base64 DER certificates');
    return der;
  }) as [Buffer, Buffer];

  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  let leafInfo: ParsedCertificate;
  let intermediateInfo: ParsedCertificate;
  try {
    leaf = new X509Certificate(leafDer);
    intermediate = new X509Certificate(intermediateDer);
    leafInfo = parseCertificate(leafDer);
    intermediateInfo = parseCertificate(intermediateDer);
  } catch {
    throw new ChainError('x5c contains an unparseable certificate');
  }

  const root = roots.find((candidate) => issuedBy(intermediate, candidate.certificate));
  if (!root) throw new ChainError('intermediate is not signed by a trusted root');
  if (!intermediate.ca) throw new ChainError('intermediate is not a CA');
  if (!issuedBy(leaf, intermediate)) throw new ChainError('leaf is not signed by the intermediate');
  if (!hasExtension(leafInfo, APPLE_LEAF_OID)) throw new ChainError('leaf lacks the Apple OID');
  if (!hasExtension(intermediateInfo, APPLE_INTERMEDIATE_OID)) {
    throw new ChainError('intermediate lacks the Apple OID');
  }
  for (const info of [leafInfo, intermediateInfo, root.parsed]) {
    if (!validAt(info, effectiveDate)) throw new ChainError('certificate not valid at signedDate');
  }
  return leaf.publicKey;
}
