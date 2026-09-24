import { ValidationError } from '../core/errors.js';

/**
 * Provider contract. Three capabilities are needed: transcription, translation,
 * and speech synthesis. Each method receives a cancellation token via
 * `options.signal` and must honor prompt cancellation.
 *
 * Implementations must never persist credentials and must not include key
 * material in thrown errors or logs.
 */

export const ProviderCapability = {
  TRANSCRIBE: 'transcribe',
  TRANSLATE: 'translate',
  SYNTHESIZE: 'synthesize',
  SEPARATE: 'separate',
};

export function assertProvider(provider) {
  const missing = [];
  if (typeof provider?.name !== 'string' || !provider.name) missing.push('name');
  for (const method of [ProviderCapability.TRANSCRIBE, ProviderCapability.TRANSLATE, ProviderCapability.SYNTHESIZE]) {
    if (typeof provider?.[method] !== 'function') missing.push(method);
  }
  if (missing.length) throw new TypeError(`Provider is missing: ${missing.join(', ')}`);
  return provider;
}

export function assertLanguage(code, label = 'language') {
  if (!code || typeof code !== 'string' || !/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(code)) {
    throw new ValidationError(`Invalid ${label} code: ${JSON.stringify(code)}`);
  }
  return code;
}

export function assertNonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value;
}
