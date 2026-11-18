import { ConfigurationError, PolicyError, PurchaseNotFoundError } from '../core/errors/index.js';
import { arr, isRecord, num, str, type JsonObject } from '../core/guards.js';
import type { AppleVerifyInput, Environment, Purchase } from '../core/types.js';
import type { ResolvedAppleConfig } from './apple.config.js';
import { normalizeAppleTransaction } from './apple.normalizer.js';
import type { AppStoreServerApi } from './app-store-server-api.js';
import { toEnvironment, type SignedDataVerifier } from './signed-data-verifier.js';

/** SPEC §5.4: stateless verification of an Apple purchase proof. */
export class ApplePurchaseVerifier {
  constructor(
    private readonly config: ResolvedAppleConfig,
    private readonly signed: SignedDataVerifier,
    private readonly api: AppStoreServerApi | null,
    private readonly products: ReadonlySet<string> | null,
  ) {}

  async verify(input: AppleVerifyInput): Promise<Purchase> {
    const tx = await this.obtainTransaction(input);
    const purchase = await this.latestState(tx);

    if (purchase.familyShared && !this.config.allowFamilySharing) {
      throw new PolicyError(
        'FAMILY_SHARING_NOT_ALLOWED',
        'Family Sharing purchases are not allowed',
        {
          platform: 'apple',
        },
      );
    }
    if (this.products && !this.products.has(purchase.productId)) {
      throw new PolicyError('UNKNOWN_PRODUCT', 'Product is not in the allowlist', {
        platform: 'apple',
        details: { productId: purchase.productId },
      });
    }
    return purchase;
  }

  private async obtainTransaction(input: AppleVerifyInput): Promise<JsonObject> {
    if ('signedTransaction' in input) return this.signed.verifyTransaction(input.signedTransaction);

    if (!this.api) {
      throw new ConfigurationError('apple.api is required to verify by transactionId', {
        platform: 'apple',
      });
    }
    // Apple's documented approach: production first, then sandbox on "not found".
    const environments = (['production', 'sandbox'] as const).filter((env) =>
      this.config.environments.includes(env),
    );
    let notFound: PurchaseNotFoundError | undefined;
    for (const environment of environments) {
      try {
        const signedTransaction = await this.api.getTransactionInfo(
          input.transactionId,
          environment,
        );
        return this.signed.verifyTransaction(signedTransaction);
      } catch (error) {
        if (!(error instanceof PurchaseNotFoundError)) throw error;
        notFound = error;
      }
    }
    /* v8 ignore next -- environments is never empty */
    throw notFound ?? new PurchaseNotFoundError('Transaction id not found', { platform: 'apple' });
  }

  /**
   * Auto-renewable subscriptions with the Server API configured: replace the client's
   * (possibly old) transaction by the latest verified state and numeric status.
   */
  private async latestState(tx: JsonObject): Promise<Purchase> {
    if (!this.api || tx.type !== 'Auto-Renewable Subscription') {
      return normalizeAppleTransaction(tx);
    }
    const environment: Environment = toEnvironment(tx.environment) ?? 'production';
    let response: JsonObject;
    try {
      response = await this.api.getAllSubscriptionStatuses(
        str(tx.transactionId) ?? '',
        environment,
      );
    } catch (error) {
      if (error instanceof PurchaseNotFoundError) return normalizeAppleTransaction(tx);
      throw error;
    }
    const item = arr(response.data)
      .flatMap((group) => (isRecord(group) ? arr(group.lastTransactions) : []))
      .find(
        (candidate): candidate is JsonObject =>
          isRecord(candidate) && candidate.originalTransactionId === tx.originalTransactionId,
      );
    if (!item) return normalizeAppleTransaction(tx);

    const latest = this.signed.verifyTransaction(item.signedTransactionInfo);
    const renewalInfo =
      item.signedRenewalInfo === undefined
        ? null
        : this.signed.verifyRenewalInfo(item.signedRenewalInfo);
    return normalizeAppleTransaction(latest, { renewalInfo, status: num(item.status) ?? null });
  }
}
