import { ErrorCode, IapError, type IapErrorOptions } from './iap-error.js';

export { ErrorCode, IapError, type IapErrorOptions } from './iap-error.js';

/** Missing or invalid configuration. Thrown at construction time where possible. */
export class ConfigurationError extends IapError {
  declare readonly code: typeof ErrorCode.CONFIGURATION_ERROR;

  constructor(message: string, options?: IapErrorOptions) {
    super(ErrorCode.CONFIGURATION_ERROR, message, options);
  }
}

/** Invalid input, caught before any request. */
export class ValidationError extends IapError {
  declare readonly code: typeof ErrorCode.VALIDATION_ERROR;
  /** Field name → messages, e.g. `{ userId: ['must be a non-empty string'] }`. */
  readonly fields: Readonly<Record<string, readonly string[]>>;

  constructor(message: string, fields: Record<string, string[]> = {}, options?: IapErrorOptions) {
    super(ErrorCode.VALIDATION_ERROR, message, {
      ...options,
      details: { ...options?.details, fields },
    });
    this.fields = Object.freeze({ ...fields });
  }

  /** Build from a field map; the message summarises the first problem. */
  static fromFields(fields: Record<string, string[]>, options?: IapErrorOptions): ValidationError {
    const [field, messages] = Object.entries(fields)[0] ?? ['input', ['is invalid']];
    return new ValidationError(`Invalid ${field}: ${messages[0] ?? 'is invalid'}`, fields, options);
  }
}

/** The store rejected our credentials (Apple API key, Google service account). */
export class AuthenticationError extends IapError {
  declare readonly code: typeof ErrorCode.AUTHENTICATION_FAILED;

  constructor(message: string, options?: IapErrorOptions) {
    super(ErrorCode.AUTHENTICATION_FAILED, message, options);
  }
}

export interface StoreApiErrorOptions extends IapErrorOptions {
  statusCode?: number | null;
  responseBody?: unknown;
  retryable?: boolean;
}

/** The store API answered with something unexpected (429, 5xx, unknown 4xx, malformed body). */
export class StoreApiError extends IapError {
  declare readonly code: typeof ErrorCode.STORE_API_ERROR;
  readonly statusCode: number | null;
  readonly responseBody: unknown;
  /** True when trying again later may succeed (429 / 5xx). */
  readonly retryable: boolean;

  constructor(message: string, options: StoreApiErrorOptions = {}) {
    const statusCode = options.statusCode ?? null;
    super(ErrorCode.STORE_API_ERROR, message, {
      ...options,
      details: { ...options.details, statusCode },
    });
    this.statusCode = statusCode;
    this.responseBody = options.responseBody;
    this.retryable =
      options.retryable ?? (statusCode === null || statusCode === 429 || statusCode >= 500);
  }
}

/** The request never got a response: DNS, connection reset, TLS failure or timeout. */
export class NetworkError extends IapError {
  declare readonly code: typeof ErrorCode.NETWORK_ERROR | typeof ErrorCode.TIMEOUT;

  constructor(message: string, options: IapErrorOptions & { timeout?: boolean } = {}) {
    super(options.timeout === true ? ErrorCode.TIMEOUT : ErrorCode.NETWORK_ERROR, message, options);
  }
}

export type VerificationErrorCode =
  | typeof ErrorCode.INVALID_SIGNATURE
  | typeof ErrorCode.WRONG_APP
  | typeof ErrorCode.PRODUCT_MISMATCH
  | typeof ErrorCode.INVALID_NOTIFICATION;

/** The proof or webhook is not genuine, not for this app, or malformed. Never grant access. */
export class VerificationError extends IapError {
  declare readonly code: VerificationErrorCode;

  // Narrows `code` to this class's codes.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(code: VerificationErrorCode, message: string, options?: IapErrorOptions) {
    super(code, message, options);
  }
}

export type PolicyErrorCode =
  | typeof ErrorCode.ENVIRONMENT_NOT_ALLOWED
  | typeof ErrorCode.UNKNOWN_PRODUCT
  | typeof ErrorCode.FAMILY_SHARING_NOT_ALLOWED;

/** Genuine purchase, refused by your configuration. */
export class PolicyError extends IapError {
  declare readonly code: PolicyErrorCode;

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(code: PolicyErrorCode, message: string, options?: IapErrorOptions) {
    super(code, message, options);
  }
}

/** The store does not know this transaction id / purchase token. */
export class PurchaseNotFoundError extends IapError {
  declare readonly code: typeof ErrorCode.PURCHASE_NOT_FOUND;

  constructor(message: string, options?: IapErrorOptions) {
    super(ErrorCode.PURCHASE_NOT_FOUND, message, options);
  }
}

export type OwnershipErrorCode = typeof ErrorCode.ALREADY_OWNED | typeof ErrorCode.ACCOUNT_MISMATCH;

/** The purchase belongs to another app user. The message never reveals who. */
export class OwnershipError extends IapError {
  declare readonly code: OwnershipErrorCode;

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(code: OwnershipErrorCode, message: string, options?: IapErrorOptions) {
    super(code, message, options);
  }
}

/** Type guard for any error raised by this library. */
export function isIapError(error: unknown): error is IapError {
  return error instanceof IapError;
}
