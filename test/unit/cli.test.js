import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, helpText, BOOLEAN_FLAGS } from '../../src/cli/args.js';

test('parseArgs identifies the command and collects positionals', () => {
  const { command, positionals } = parseArgs(['create', 'video.mp4']);
  assert.equal(command, 'create');
  assert.deepEqual(positionals, ['video.mp4']);
});

test('parseArgs terminates options at a bare --', () => {
  const { command, flags, positionals } = parseArgs(['create', 'file.mp4', '--', '--not-a-flag']);
  assert.equal(command, 'create');
  assert.deepEqual(positionals, ['file.mp4', '--not-a-flag']);
  assert.deepEqual(Object.keys(flags), []);
});

test('parseArgs reads --flag value pairs and --flag=value forms identically', () => {
  const spaced = parseArgs(['create', 'a.mp4', '--to', 'fr']);
  assert.equal(spaced.flags.to, 'fr');

  const equals = parseArgs(['create', 'a.mp4', '--to=fr']);
  assert.equal(equals.flags.to, 'fr');
});

test('parseArgs treats declared boolean flags as true without consuming the next token', () => {
  const { flags } = parseArgs(['create', 'a.mp4', '--wait', '--to', 'es']);
  assert.equal(flags.wait, true);
  assert.equal(flags.to, 'es');
  for (const name of BOOLEAN_FLAGS) {
    assert.equal(parseArgs([`--${name}`]).flags[toCamel(name)], true);
  }
});

test('parseArgs treats an undeclared flag with no value as true', () => {
  const { flags } = parseArgs(['create', 'a.mp4', '--unknown']);
  assert.equal(flags.unknown, true);
});

test('parseArgs camel-cases hyphenated flag names', () => {
  const { flags } = parseArgs(['create', 'a.mp4', '--separate-vocals']);
  assert.equal(flags.separateVocals, true);
  assert.equal(flags['separate-vocals'], undefined);
});

test('parseArgs maps short flags onto their long equivalents', () => {
  const { flags } = parseArgs(['create', 'a.mp4', '-t', 'ja', '-f', 'en', '-w']);
  assert.equal(flags.to, 'ja');
  assert.equal(flags.from, 'en');
  assert.equal(flags.wait, true);
});

test('parseArgs ignores a flag-like value and leaves it unconsumed', () => {
  // `--to --wait` must not swallow the following flag as the language value.
  const { flags } = parseArgs(['create', 'a.mp4', '--to', '--wait']);
  assert.equal(flags.to, true);
  assert.equal(flags.wait, true);
});

test('parseArgs handles repeated flags by taking the last value', () => {
  const { flags } = parseArgs(['list', '--status', 'running', '--status', 'failed']);
  assert.equal(flags.status, 'failed');
});

test('parseArgs returns no command for an empty argv', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.command, null);
  assert.deepEqual(parsed.flags, {});
  assert.deepEqual(parsed.positionals, []);
});

test('helpText documents every command and the environment variables', () => {
  const text = helpText();
  for (const command of ['serve', 'create', 'start', 'resume', 'retry', 'cancel', 'status', 'list', 'doctor']) {
    assert.match(text, new RegExp(`\\b${command}\\b`), `help is missing ${command}`);
  }
  assert.match(text, /DUB_MEDIA_ENGINE/);
  assert.match(text, /GEMINI_API_KEYS/);
  assert.match(text, /DUB_API_TOKEN/);
});

function toCamel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
