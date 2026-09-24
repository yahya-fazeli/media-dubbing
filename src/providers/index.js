import { GeminiProvider } from './gemini-provider.js';
import { FakeProvider } from './fake-provider.js';
import { ProviderError, ErrorCode } from '../core/errors.js';
import { assertProvider } from './provider.js';

/**
 * Chooses the AI provider. Gemini is used whenever keys are configured; the
 * offline provider is used when explicitly requested or when no keys exist, so
 * the product still runs end-to-end in a fresh environment.
 */
export function createProvider(config, { logger, metrics, fetchImpl, random } = {}) {
  const forceFake = config.providers.fake.enabled;
  const hasKeys = config.providers.gemini.apiKeys.length > 0;

  if (forceFake || !hasKeys) {
    const provider = new FakeProvider(config, logger);
    return {
      provider: assertProvider(provider),
      kind: 'fake',
      reason: forceFake
        ? 'DUB_FAKE_PROVIDER is enabled.'
        : 'No Gemini API keys configured; using the deterministic offline provider.',
    };
  }

  const provider = new GeminiProvider(config, { logger, metrics, fetchImpl, random });
  return {
    provider: assertProvider(provider),
    kind: 'gemini',
    reason: `Gemini configured with ${config.providers.gemini.apiKeys.length} API key(s).`,
  };
}

/**
 * Raised when a provider is asked to do work it cannot do. Kept separate so the
 * pipeline can mark a specific stage as unsupported rather than failed.
 */
export function unsupportedProviderError(capability) {
  return new ProviderError(`The active provider does not support ${capability}`, {
    code: ErrorCode.PROVIDER_UNAVAILABLE,
    retryable: false,
    recoveryScope: 'none',
    recommendedAction: 'Configure a provider that supports this capability.',
  });
}

export { GeminiProvider, FakeProvider };
