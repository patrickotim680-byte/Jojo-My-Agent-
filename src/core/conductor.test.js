import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSensitiveTurn, Conductor } from './conductor.js';

test('isSensitiveTurn: flags possessive sensitive-category phrasing', () => {
  assert.equal(isSensitiveTurn('can you read my messages from yesterday'), true);
  assert.equal(isSensitiveTurn('what is my bank balance'), true);
  assert.equal(isSensitiveTurn('remind me about my medication schedule'), true);
});

test('isSensitiveTurn: does not flag unrelated use of the same bare words', () => {
  assert.equal(isSensitiveTurn('what is a healthy breakfast'), false);
  assert.equal(isSensitiveTurn('describe the bank of a river'), false);
  assert.equal(isSensitiveTurn('write a haiku about the ocean'), false);
});

test('isSensitiveTurn: case-insensitive and handles empty input', () => {
  assert.equal(isSensitiveTurn('WHAT IS MY BANK BALANCE'), true);
  assert.equal(isSensitiveTurn(''), false);
  assert.equal(isSensitiveTurn(undefined), false);
});

test('Conductor.classifyTask: surfaces the sensitive flag', () => {
  const conductor = new Conductor();
  const routing = conductor.classifyTask('what is my bank balance', 'fast');
  assert.equal(routing.sensitive, true);

  const routing2 = conductor.classifyTask('what is the capital of France', 'fast');
  assert.equal(routing2.sensitive, false);
});

