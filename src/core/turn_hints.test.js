import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsCameraGrounding, inferUrgency } from './turn_hints.js';

test('needsCameraGrounding: detects deictic phrasing', () => {
  assert.equal(needsCameraGrounding("What's this?"), true);
  assert.equal(needsCameraGrounding('what am I looking at'), true);
  assert.equal(needsCameraGrounding('is this safe to eat'), true);
  assert.equal(needsCameraGrounding('look at that'), true);
});

test('needsCameraGrounding: false when there is already a resolvable referent', () => {
  assert.equal(needsCameraGrounding('what is this: https://example.com/photo.jpg'), false);
  assert.equal(needsCameraGrounding('what is this file /home/user/pics/dog.png'), false);
});

test('needsCameraGrounding: false for ordinary messages', () => {
  assert.equal(needsCameraGrounding('what is the capital of France'), false);
  assert.equal(needsCameraGrounding(''), false);
  assert.equal(needsCameraGrounding(undefined), false);
});

test('inferUrgency: flags short, clipped, exclaimed, repeated phrasing', () => {
  const r = inferUrgency('stop stop!');
  assert.equal(r.urgent, true);
  assert.ok(r.hint && r.hint.length > 0);
});

test('inferUrgency: does not flag an ordinary short greeting', () => {
  const r = inferUrgency('hey, how are you?');
  assert.equal(r.urgent, false);
  assert.equal(r.hint, undefined);
});

test('inferUrgency: does not flag a normal longer sentence', () => {
  const r = inferUrgency('Can you help me understand how photosynthesis works in plants?');
  assert.equal(r.urgent, false);
});

test('inferUrgency: empty text is never urgent', () => {
  assert.equal(inferUrgency('').urgent, false);
  assert.equal(inferUrgency(undefined).urgent, false);
});

