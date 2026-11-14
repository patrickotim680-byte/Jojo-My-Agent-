import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPersonName, MemorySystem } from './memory.js';

test('extractPersonName: relationship-word pattern', () => {
  assert.equal(extractPersonName('my sister Priya likes hiking'), 'Priya');
  assert.equal(extractPersonName('my friend Marcus just started a new job'), 'Marcus');
});

test('extractPersonName: leading-name pattern', () => {
  assert.equal(extractPersonName('Priya likes hiking on weekends'), 'Priya');
  assert.equal(extractPersonName('Marcus works at a hospital'), 'Marcus');
});

test('extractPersonName: no match on a plain fact', () => {
  assert.equal(extractPersonName('the wifi password is on the fridge'), null);
  assert.equal(extractPersonName(''), null);
  assert.equal(extractPersonName(undefined), null);
});

// Talks to MemorySystem's in-memory state directly (_indexPerson/recall),
// deliberately bypassing remember()'s _save() so this test never touches
// disk — see memory.js's constructor, which needs no I/O either.
test('MemorySystem: person-first recall finds a name-shaped fact', () => {
  const mem = new MemorySystem();
  mem.data.facts.push('my sister Priya likes hiking');
  mem._indexPerson('my sister Priya likes hiking');

  const result = mem.recall('priya');
  assert.match(result, /hiking/);
});

test('MemorySystem: recall falls back to flat fact search when no person matches', () => {
  const mem = new MemorySystem();
  mem.data.facts.push('the wifi password is on the fridge');

  const result = mem.recall('wifi');
  assert.match(result, /fridge/);
});

test('MemorySystem: recall reports no match cleanly', () => {
  const mem = new MemorySystem();
  const result = mem.recall('nonexistent-topic-xyz');
  assert.equal(result, 'No memories match that query.');
});

