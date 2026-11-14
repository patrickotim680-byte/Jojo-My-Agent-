import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from './registry.js';

// A fake stand-in for send_whatsapp_message — registered under the exact
// gated tool name so ToolRegistry's name-based gate applies, without pulling
// in the real WhatsApp/Baileys dependency chain just to test the gate logic.
function fakeGatedTool(sentLog) {
  return {
    name: 'send_whatsapp_message',
    declaration: {
      name: 'send_whatsapp_message',
      description: 'fake test double',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    async execute(args) {
      sentLog.push(args.text);
      return `sent: ${args.text}`;
    },
  };
}

test('ToolRegistry: gated tool executes immediately when the turn is reversible', async () => {
  const registry = new ToolRegistry();
  const sent = [];
  registry.registerMany([fakeGatedTool(sent)], 'test');

  const result = await registry.execute('send_whatsapp_message', { text: 'hi' }, { turnReversible: true });
  assert.equal(result, 'sent: hi');
  assert.deepEqual(sent, ['hi']);
});

test('ToolRegistry: gated tool is held pending when the turn is irreversible', async () => {
  const registry = new ToolRegistry();
  const sent = [];
  registry.registerMany([fakeGatedTool(sent)], 'test');

  const result = await registry.execute('send_whatsapp_message', { text: 'hi' }, { turnReversible: false });
  assert.match(result, /holding/i);
  assert.match(result, /approval_id="/);
  assert.deepEqual(sent, []); // never actually ran
});

test('ToolRegistry: a held call proceeds once re-called with approval_id + human_approved', async () => {
  const registry = new ToolRegistry();
  const sent = [];
  registry.registerMany([fakeGatedTool(sent)], 'test');

  const held = await registry.execute('send_whatsapp_message', { text: 'hi' }, { turnReversible: false });
  const approvalId = held.match(/approval_id="([^"]+)"/)?.[1];
  assert.ok(approvalId, 'expected an approval_id in the held response');

  const result = await registry.execute(
    'send_whatsapp_message',
    { text: 'hi', approval_id: approvalId, human_approved: true },
    { turnReversible: false },
  );
  assert.equal(result, 'sent: hi');
  assert.deepEqual(sent, ['hi']);
});

test('ToolRegistry: getDeclarations() adds approval_id/human_approved only to gated tools', () => {
  const registry = new ToolRegistry();
  const sent = [];
  registry.registerMany([fakeGatedTool(sent)], 'test');
  registry.registerMany([{
    name: 'harmless_test_tool',
    declaration: { name: 'harmless_test_tool', description: 'd', parameters: { type: 'object', properties: {} } },
    async execute() { return 'ok'; },
  }], 'test');

  const decls = registry.getDeclarations();
  const gated = decls.find(d => d.name === 'send_whatsapp_message');
  const ungated = decls.find(d => d.name === 'harmless_test_tool');

  assert.ok(gated.parameters.properties.approval_id);
  assert.ok(gated.parameters.properties.human_approved);
  assert.equal(ungated.parameters.properties.approval_id, undefined);
});

