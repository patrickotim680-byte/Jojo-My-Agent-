import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProbablyEcho, endedWithQuestion, spawnCancelable } from './voice_barge_in_utils.js';

test('endedWithQuestion: detects a trailing question mark', () => {
  assert.equal(endedWithQuestion('Want me to keep going?'), true);
  assert.equal(endedWithQuestion('Want me to keep going? '), true); // trailing space
});

test('endedWithQuestion: false for a completed statement', () => {
  assert.equal(endedWithQuestion("Done — that's deployed."), false);
  assert.equal(endedWithQuestion(''), false);
  assert.equal(endedWithQuestion(undefined), false);
});

test('isProbablyEcho: flags near-identical text as echo', () => {
  const spoken = "I've queued the deploy, want me to notify the team when it's done?";
  const heard = "queued the deploy notify the team when its done";
  assert.equal(isProbablyEcho(heard, spoken), true);
});

test('isProbablyEcho: does not flag an unrelated interruption', () => {
  const spoken = "I've queued the deploy, want me to notify the team when it's done?";
  const heard = 'actually stop, cancel that';
  assert.equal(isProbablyEcho(heard, spoken), false);
});

test('isProbablyEcho: empty strings never count as echo', () => {
  assert.equal(isProbablyEcho('', 'anything'), false);
  assert.equal(isProbablyEcho('anything', ''), false);
});

test('spawnCancelable: resolves with stdout on success', async () => {
  const { promise } = spawnCancelable(process.execPath, ['-e', 'process.stdout.write("hello")']);
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, 'hello');
  assert.equal(result.killed, false);
});

test('spawnCancelable: cancel() kills the child and marks the result as killed', async () => {
  const { promise, cancel } = spawnCancelable(
    process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write("too late"), 5000)'],
  );
  cancel();
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.killed, true);
});

