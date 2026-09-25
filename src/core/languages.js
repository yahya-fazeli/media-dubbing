/**
 * Shared language registry and validation helpers.
 *
 * `auto` is a request mode, not a language code. It is valid only as a source
 * language; the transcription provider replaces it with a concrete BCP-47 code
 * before translation begins.
 */

export const AUTO_DETECT_LANGUAGE = 'auto';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'fa', name: 'Persian' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ru', name: 'Russian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'id', name: 'Indonesian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'sv', name: 'Swedish' },
  { code: 'uk', name: 'Ukrainian' },
];

const LANGUAGE_CODE_RE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;

export function isAutoDetectLanguage(value) {
  return value === AUTO_DETECT_LANGUAGE;
}

export function isLanguageCode(value) {
  return typeof value === 'string' && LANGUAGE_CODE_RE.test(value);
}
