import { PolicyError, VerificationError } from '../core/errors/index.js';
import type { Clock } from '../core/clock.js';
import type { GoogleVerifyInput, Purchase } from '../core/types.js';
import type { ResolvedGoogleConfig } from './google.config.js';
import { normalizeGoogleProduct, normalizeGoogleSubscription } from './google.normalizer.js';
import type { PlayDeveloperApi } from './play-developer-api.js';

/** SPEC §6.4: stateless verification of a Google Play purchase token. */
export class GooglePurchaseVerifier {
  constructor(
    private readonly config: ResolvedGoogleConfig,
    private readonly api: PlayDeveloperApi,
    private readonly products: ReadonlySet<string> | null,
    private readonly clock: Clock,
  ) {}

  /** Fetches current state for a token and normalizes it, without any policy checks. */
  async fetch(type: GoogleVerifyInput['type'], token: string): Promise<Purchase> {
    if (type === 'subscription') {
      return normalizeGoogleSubscription(
        token,
        await this.api.getSubscription(token),
        this.clock(),
      );
    }
    const body = await this.api.getProduct(token);
    return normalizeGoogleProduct(token, body, this.clock(), this.config.consumableProductIds);
  }

  async verify(input: GoogleVerifyInput): Promise<Purchase> {
    const purchase = await this.fetch(input.type, input.purchaseToken);

    if (input.productId !== undefined && !purchase.productIds.includes(input.productId)) {
      throw new VerificationError('PRODUCT_MISMATCH', 'Purchase token is for a different product', {
        platform: 'google',
        details: { productId: input.productId },
      });
    }
    if (purchase.environment === 'sandbox' && !this.config.allowTestPurchases) {
      throw new PolicyError('ENVIRONMENT_NOT_ALLOWED', 'Test purchases are not allowed', {
        platform: 'google',
        details: { environment: 'sandbox' },
      });
    }
    if (this.products && !purchase.productIds.every((id) => this.products?.has(id) === true)) {
      throw new PolicyError('UNKNOWN_PRODUCT', 'Product is not in the allowlist', {
        platform: 'google',
        details: { productId: purchase.productId },
      });
    }
    return purchase;
  }
}
