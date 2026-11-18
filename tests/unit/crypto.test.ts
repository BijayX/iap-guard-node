import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { APPLE_ROOT_CA_G3_PEM } from '../../src/index.js';
import { base64Decode, base64urlDecode, base64urlEncode } from '../../src/crypto/base64url.js';
import {
  DerError,
  children,
  decodeOid,
  decodeTime,
  hasExtension,
  parseCertificate,
  readElement,
} from '../../src/crypto/der.js';
import { decodeJwt, jwkToPublicKey, signJwt, verifySignature } from '../../src/crypto/jwt.js';
import { APPLE_INTERMEDIATE_OID, APPLE_LEAF_OID } from '../../src/crypto/x509-chain.js';
import { appleJws } from '../helpers/fixtures.js';

const x5c = JSON.parse(
  Buffer.from(
    (appleJws.transactions.subscriptionActive.jws as string).split('.')[0]!,
    'base64url',
  ).toString(),
).x5c as string[];
const der = (b64: string) => Buffer.from(b64, 'base64');

describe('DER reader', () => {
  it('finds the Apple marker OIDs in the TBSCertificate extensions', () => {
    const leaf = parseCertificate(der(x5c[0]!));
    const intermediate = parseCertificate(der(x5c[1]!));
    expect(hasExtension(leaf, APPLE_LEAF_OID)).toBe(true);
    expect(hasExtension(leaf, APPLE_INTERMEDIATE_OID)).toBe(false);
    expect(hasExtension(intermediate, APPLE_INTERMEDIATE_OID)).toBe(true);
    const basicConstraints = leaf.extensions.find((e) => e.oid === '2.5.29.19');
    expect(basicConstraints?.critical).toBe(true);
    expect(leaf.extensions.find((e) => e.oid === '2.5.29.14')?.critical).toBe(false);
  });

  it('reads the validity period', () => {
    const leaf = parseCertificate(der(x5c[0]!));
    expect(leaf.notBefore.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(leaf.notAfter.toISOString()).toBe('2028-01-01T00:00:00.000Z');
  });

  it('parses the real Apple Root CA - G3 (no Apple marker OIDs on the root)', () => {
    const root = parseCertificate(new X509Certificate(APPLE_ROOT_CA_G3_PEM).raw);
    expect(root.notAfter.toISOString()).toBe('2039-04-30T18:19:06.000Z');
    expect(hasExtension(root, APPLE_LEAF_OID)).toBe(false);
    expect(root.extensions.map((e) => e.oid)).toContain('2.5.29.19');
  });

  it('does not match an OID that only appears outside the extensions (no substring search)', () => {
    // A certificate whose *subject* uses the Apple leaf OID as an attribute type and which has
    // no extensions at all: a byte search would find the OID, a structural walk must not.
    const appleOid = tlv(0x06, Buffer.from('2a864886f76364060b01', 'hex'));
    expect(decodeOid(readElement(appleOid).value)).toBe(APPLE_LEAF_OID);
    const subject = tlv(0x30, tlv(0x31, tlv(0x30, appleOid, tlv(0x05))));
    const cert = certificate({ subject });
    expect(cert.includes(appleOid)).toBe(true);
    const parsed = parseCertificate(cert);
    expect(parsed.extensions).toEqual([]);
    expect(hasExtension(parsed, APPLE_LEAF_OID)).toBe(false);

    // Same certificate with the OID as a real extension (no `critical` field) is found.
    const extension = tlv(0x30, appleOid, tlv(0x04, tlv(0x05)));
    const withExtension = parseCertificate(
      certificate({ subject, extensions: tlv(0xa3, tlv(0x30, extension)) }),
    );
    expect(withExtension.extensions).toEqual([
      { oid: APPLE_LEAF_OID, critical: false, value: tlv(0x05) },
    ]);
  });

  it('parses a v1 certificate (no [0] version) with GeneralizedTime validity', () => {
    const parsed = parseCertificate(certificate({ version: false, generalized: true }));
    expect(parsed.notAfter.toISOString()).toBe('2050-01-01T00:00:00.000Z');
  });

  it('decodes OIDs with multi-byte arcs and the 2.x form', () => {
    expect(decodeOid(Buffer.from('2a864886f70d010101', 'hex'))).toBe('1.2.840.113549.1.1.1');
    expect(decodeOid(Buffer.from('8837', 'hex'))).toBe('2.999');
    expect(decodeOid(Buffer.from('550403', 'hex'))).toBe('2.5.4.3');
    expect(decodeOid(Buffer.from('00', 'hex'))).toBe('0.0');
    expect(() => decodeOid(Buffer.alloc(0))).toThrow(DerError);
    expect(() => decodeOid(Buffer.from('2a86', 'hex'))).toThrow('truncated OID');
  });

  it('decodes UTCTime (both centuries) and GeneralizedTime', () => {
    const t = (tag: number, text: string) =>
      decodeTime({ tag, value: Buffer.from(text), raw: Buffer.alloc(0) });
    expect(t(0x17, '491231235959Z').toISOString()).toBe('2049-12-31T23:59:59.000Z');
    expect(t(0x17, '500101000000Z').toISOString()).toBe('1950-01-01T00:00:00.000Z');
    expect(t(0x18, '20391231000000Z').toISOString()).toBe('2039-12-31T00:00:00.000Z');
    expect(() => t(0x17, '2501010000Z')).toThrow('invalid UTCTime');
    expect(() => t(0x18, '2025')).toThrow('invalid GeneralizedTime');
    expect(() => t(0x02, '1')).toThrow('expected a time');
  });

  it.each([
    ['truncated header', '30'],
    ['multi-byte tag', '1f8101'],
    ['indefinite length', '3080'],
    ['oversized length-of-length', '308500000000010000'],
    ['truncated long length', '3082'],
    ['length beyond input', '300500'],
  ])('rejects %s', (_name, hex) => {
    expect(() => readElement(Buffer.from(hex, 'hex'))).toThrow(DerError);
  });

  it('reads long-form lengths', () => {
    const body = Buffer.alloc(200, 1);
    const element = readElement(Buffer.concat([Buffer.from([0x04, 0x81, 200]), body]));
    expect(element.value.length).toBe(200);
  });

  it('refuses to list children of a primitive element', () => {
    expect(() => children(readElement(Buffer.from('020101', 'hex')))).toThrow('not constructed');
  });

  it.each([
    ['not a SEQUENCE', '020101'],
    ['trailing bytes', '3000' + '00'],
    ['empty TBSCertificate', '30023000'],
    ['TBS without validity', '300a3008020101300030003000'],
  ])('parseCertificate rejects %s', (_name, hex) => {
    expect(() => parseCertificate(Buffer.from(hex, 'hex'))).toThrow(DerError);
  });

  it('parseCertificate rejects an incomplete validity', () => {
    const empty = tlv(0x30);
    const tbs = tlv(0x30, tlv(0x02, Buffer.from([1])), empty, empty, empty, empty, empty);
    expect(() => parseCertificate(tlv(0x30, tbs))).toThrow('incomplete validity');
  });
});

/** Minimal DER encoder for synthetic certificates. */
function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  const length = body.length < 0x80 ? Buffer.from([body.length]) : Buffer.from([0x81, body.length]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

function certificate(options: {
  subject?: Buffer;
  extensions?: Buffer;
  version?: boolean;
  generalized?: boolean;
}): Buffer {
  const time = options.generalized
    ? (text: string) => tlv(0x18, Buffer.from(`20${text}`))
    : (text: string) => tlv(0x17, Buffer.from(text));
  const name = tlv(0x30);
  const tbs = tlv(
    0x30,
    ...(options.version === false ? [] : [tlv(0xa0, tlv(0x02, Buffer.from([2])))]),
    tlv(0x02, Buffer.from([1])),
    tlv(0x30, tlv(0x06, Buffer.from('2a8648ce3d040302', 'hex'))),
    name,
    tlv(0x30, time('250101000000Z'), time('500101000000Z')),
    options.subject ?? name,
    tlv(0x30),
    ...(options.extensions ? [options.extensions] : []),
  );
  return tlv(0x30, tbs, tlv(0x30), tlv(0x03, Buffer.from([0])));
}

describe('base64 helpers', () => {
  it('base64url round-trips and rejects foreign characters', () => {
    expect(base64urlDecode(base64urlEncode('héllo'))?.toString()).toBe('héllo');
    expect(base64urlDecode('ab+/')).toBeNull();
    expect(base64urlDecode('abcde')).toBeNull(); // impossible length
    expect(base64urlDecode('ab==')).toBeNull(); // padding is not base64url
  });

  it('standard base64 accepts padding and whitespace, rejects url-safe and junk', () => {
    expect(base64Decode('aGk=')?.toString()).toBe('hi');
    expect(base64Decode('aG\nk=')?.toString()).toBe('hi');
    expect(base64Decode('aGk')?.toString()).toBe('hi');
    expect(base64Decode('a-_b')).toBeNull();
    expect(base64Decode('%%%')).toBeNull();
    expect(base64Decode('')).toBeNull();
    expect(base64Decode('abcde')).toBeNull();
  });
});

describe('JWT helpers', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecOther = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

  it('signs and verifies ES256 with raw r||s signatures', () => {
    const jwt = signJwt('ES256', { alg: 'ES256' }, { a: 1 }, ec.privateKey);
    const decoded = decodeJwt(jwt)!;
    expect(decoded.signature).toHaveLength(64);
    expect(verifySignature('ES256', decoded.signingInput, decoded.signature, ec.publicKey)).toBe(
      true,
    );
    expect(verifySignature('ES256', decoded.signingInput, decoded.signature, rsa.publicKey)).toBe(
      false,
    );
    expect(
      verifySignature('ES256', decoded.signingInput, Buffer.alloc(64), ecOther.publicKey),
    ).toBe(false);
    expect(verifySignature('RS256', decoded.signingInput, decoded.signature, ec.publicKey)).toBe(
      false,
    );
  });

  it('signs and verifies RS256; JWK → KeyObject', () => {
    const jwt = signJwt('RS256', { alg: 'RS256' }, { b: 2 }, rsa.privateKey);
    const decoded = decodeJwt(jwt)!;
    const key = jwkToPublicKey(rsa.publicKey.export({ format: 'jwk' }));
    expect(key).not.toBeNull();
    expect(verifySignature('RS256', decoded.signingInput, decoded.signature, key!)).toBe(true);
    expect(verifySignature('RS256', `${decoded.signingInput}x`, decoded.signature, key!)).toBe(
      false,
    );
  });

  it('jwkToPublicKey returns null for junk', () => {
    expect(jwkToPublicKey('nope')).toBeNull();
    expect(jwkToPublicKey({ kty: 'nope' })).toBeNull();
  });

  it.each([
    ['two segments', 'a.b'],
    ['empty header', '.e30.'],
    ['array payload', `${base64urlEncode('{}')}.${base64urlEncode('[]')}.`],
    ['bad base64url', 'e30.e3+.x'],
    ['header not JSON', `${base64urlEncode('x')}.${base64urlEncode('{}')}.`],
  ])('decodeJwt rejects %s', (_name, token) => {
    expect(decodeJwt(token)).toBeNull();
  });

  it('verifySignature returns false instead of throwing on bad input', () => {
    const decoded = decodeJwt(signJwt('RS256', { alg: 'RS256' }, {}, rsa.privateKey))!;
    expect(verifySignature('RS256', decoded.signingInput, Buffer.alloc(0), rsa.publicKey)).toBe(
      false,
    );
    expect(verifySignature('RS256', decoded.signingInput, decoded.signature, rsa.privateKey)).toBe(
      true,
    );
  });
});
