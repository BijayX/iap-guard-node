/**
 * Minimal DER reader — just enough of X.690 to walk an X.509 certificate
 * (RFC 5280 §4.1) and read its validity period and extensions. Every read is bounds-checked;
 * malformed input throws `DerError`.
 */

export class DerError extends Error {
  constructor(message: string) {
    super(`Malformed DER: ${message}`);
    this.name = 'DerError';
  }
}

export const Tag = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  OID: 0x06,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  /** `[0] EXPLICIT` — TBSCertificate.version */
  CONTEXT_0: 0xa0,
  /** `[3] EXPLICIT` — TBSCertificate.extensions */
  CONTEXT_3: 0xa3,
} as const;

export interface DerElement {
  tag: number;
  /** Content octets (no tag/length). */
  value: Buffer;
  /** Whole encoding, tag + length + content. */
  raw: Buffer;
}

/** Reads one TLV at `offset`. Only definite lengths (DER) and single-byte tags are accepted. */
export function readElement(input: Buffer, offset = 0): DerElement {
  if (offset + 2 > input.length) throw new DerError('truncated header');
  const tag = input[offset] ?? 0;
  if ((tag & 0x1f) === 0x1f) throw new DerError('multi-byte tags are not supported');
  let lengthByte = input[offset + 1] ?? 0;
  let cursor = offset + 2;
  let length: number;
  if (lengthByte < 0x80) {
    length = lengthByte;
  } else {
    const count = lengthByte & 0x7f;
    if (count === 0 || count > 4) throw new DerError('unsupported length encoding');
    if (cursor + count > input.length) throw new DerError('truncated length');
    length = 0;
    for (let i = 0; i < count; i++) {
      lengthByte = input[cursor + i] ?? 0;
      length = length * 256 + lengthByte;
    }
    cursor += count;
  }
  const end = cursor + length;
  if (end > input.length) throw new DerError('length exceeds input');
  return { tag, value: input.subarray(cursor, end), raw: input.subarray(offset, end) };
}

/** Children of a constructed element (SEQUENCE, SET, explicit context tags). */
export function children(element: DerElement): DerElement[] {
  if ((element.tag & 0x20) === 0) throw new DerError('element is not constructed');
  const out: DerElement[] = [];
  let offset = 0;
  while (offset < element.value.length) {
    const child = readElement(element.value, offset);
    out.push(child);
    offset += child.raw.length;
  }
  return out;
}

function expect(element: DerElement | undefined, tag: number, what: string): DerElement {
  if (element?.tag !== tag) throw new DerError(`expected ${what}`);
  return element;
}

/** Dotted-decimal form of an OBJECT IDENTIFIER's content octets. */
export function decodeOid(value: Buffer): string {
  if (value.length === 0) throw new DerError('empty OID');
  const arcs: number[] = [];
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    const byte = value[i] ?? 0;
    n = n * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(n);
      n = 0;
    } else if (i === value.length - 1) {
      throw new DerError('truncated OID');
    }
  }
  // The first sub-identifier packs the first two arcs (X.690 §8.19.4).
  const first = arcs[0] ?? 0;
  const head = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  return [...head, ...arcs.slice(1)].join('.');
}

/** UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSSZ) → Date. */
export function decodeTime(element: DerElement): Date {
  const text = element.value.toString('latin1');
  let match: RegExpExecArray | null;
  let year: number;
  if (element.tag === Tag.UTC_TIME) {
    match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
    if (!match) throw new DerError('invalid UTCTime');
    const yy = Number(match[1]);
    year = yy >= 50 ? 1900 + yy : 2000 + yy; // RFC 5280 §4.1.2.5.1
  } else if (element.tag === Tag.GENERALIZED_TIME) {
    match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
    if (!match) throw new DerError('invalid GeneralizedTime');
    year = Number(match[1]);
  } else {
    throw new DerError('expected a time');
  }
  const [, , mo, d, h, mi, s] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, mo - 1, d, h, mi, s));
}

export interface CertificateExtension {
  oid: string;
  critical: boolean;
  /** Content of `extnValue` (the inner DER, without the OCTET STRING wrapper). */
  value: Buffer;
}

export interface ParsedCertificate {
  notBefore: Date;
  notAfter: Date;
  extensions: CertificateExtension[];
}

/**
 * Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
 * TBSCertificate ::= SEQUENCE {
 *   version [0] EXPLICIT OPTIONAL, serialNumber, signature, issuer, validity, subject,
 *   subjectPublicKeyInfo, issuerUniqueID [1] OPTIONAL, subjectUniqueID [2] OPTIONAL,
 *   extensions [3] EXPLICIT OPTIONAL }
 */
export function parseCertificate(der: Buffer): ParsedCertificate {
  const certificate = readElement(der);
  if (certificate.tag !== Tag.SEQUENCE || certificate.raw.length !== der.length) {
    throw new DerError('certificate is not a single SEQUENCE');
  }
  const tbs = expect(children(certificate)[0], Tag.SEQUENCE, 'TBSCertificate');
  const fields = children(tbs);
  let index = fields[0]?.tag === Tag.CONTEXT_0 ? 1 : 0;
  expect(fields[index++], Tag.INTEGER, 'serialNumber');
  expect(fields[index++], Tag.SEQUENCE, 'signature algorithm');
  expect(fields[index++], Tag.SEQUENCE, 'issuer');
  const validity = children(expect(fields[index++], Tag.SEQUENCE, 'validity'));
  expect(fields[index++], Tag.SEQUENCE, 'subject');
  expect(fields[index++], Tag.SEQUENCE, 'subjectPublicKeyInfo');
  const [notBefore, notAfter] = validity;
  if (!notBefore || !notAfter) throw new DerError('incomplete validity');

  const extensions: CertificateExtension[] = [];
  const wrapper = fields.slice(index).find((field) => field.tag === Tag.CONTEXT_3);
  if (wrapper) {
    const list = expect(children(wrapper)[0], Tag.SEQUENCE, 'Extensions');
    for (const extension of children(list)) {
      const parts = children(expect(extension, Tag.SEQUENCE, 'Extension'));
      const oid = decodeOid(expect(parts[0], Tag.OID, 'extnID').value);
      const hasCritical = parts[1]?.tag === Tag.BOOLEAN;
      const critical = hasCritical && (parts[1]?.value[0] ?? 0) !== 0;
      const value = expect(parts[hasCritical ? 2 : 1], Tag.OCTET_STRING, 'extnValue').value;
      extensions.push({ oid, critical, value });
    }
  }
  return { notBefore: decodeTime(notBefore), notAfter: decodeTime(notAfter), extensions };
}

export function hasExtension(certificate: ParsedCertificate, oid: string): boolean {
  return certificate.extensions.some((extension) => extension.oid === oid);
}
