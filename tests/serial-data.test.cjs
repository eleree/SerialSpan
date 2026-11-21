const { test } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../static/js/serial-data.js');
const replay = require('../static/js/rx-replay.js');

test('binary bytes round trip without text encoding', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    assert.deepEqual(data.fromBase64(data.toBase64(bytes)), bytes);
});

test('HEX accepts whole bytes and rejects malformed input', () => {
    assert.deepEqual([...data.parseSendInput('00 aF 80', true, false)], [0, 175, 128]);
    for (const input of ['F', 'ABC', '12345', 'FG', '0x41', '41 Q2', '']) {
        assert.throws(() => data.parseSendInput(input, true, false));
    }
});

test('HEX display preserves leading zeroes and uppercase byte boundaries', () => {
    assert.equal(data.formatHex(new Uint8Array([0, 1, 15, 16, 175, 255])), '00 01 0F 10 AF FF');
    assert.equal(data.formatHex(new Uint8Array()), '');
});

test('CR is appended as a byte after HEX or text conversion', () => {
    assert.deepEqual([...data.parseSendInput('41', true, true)], [65, 13]);
    assert.deepEqual([...data.parseSendInput('AT', false, true)], [65, 84, 13]);
    assert.deepEqual(data.parseSendInput('中文', false, false), new TextEncoder().encode('中文'));
});

test('send limit applies to encoded bytes including CR', () => {
    assert.equal(data.parseSendInput('A'.repeat(16384), false, false).length, 16384);
    assert.throws(() => data.parseSendInput('A'.repeat(16384), false, true));
    assert.throws(() => data.parseSendInput('中'.repeat(6000), false, false));
});

test('RX replay cache preserves ordered bytes and reports evicted sequence gaps', () => {
    const buffer = replay.create('stream-a');
    replay.append(buffer, [0, 255]);
    replay.append(buffer, [65, 13]);
    const result = replay.resume(buffer, 0, 2);
    assert.equal(result.streamId, 'stream-a');
    assert.deepEqual(result.frames.map(frame => [...frame.data]), [[0, 255], [65, 13]]);
    assert.equal(result.gapFrom, 0);
    assert.equal(result.gapTo, 0);

    for (let i = 0; i < replay.MAX_FRAMES + 1; i++) replay.append(buffer, [i & 255]);
    const overflow = replay.resume(buffer, 0, buffer.sequence);
    assert.equal(overflow.gapFrom, 1);
    assert.equal(overflow.gapTo, 3);
    assert.equal(overflow.frames[0].sequence, 4);
    assert.ok(buffer.bytes <= replay.MAX_BYTES);
    assert.ok(buffer.frames.length <= replay.MAX_FRAMES);
});

test('RX replay byte budget remains available across small native serial reads', () => {
    const buffer = replay.create('stream-small-reads');
    const chunk = new Uint8Array(169);
    for (let i = 0; i < Math.ceil(replay.MAX_BYTES / chunk.length); i++) replay.append(buffer, chunk);
    const result = replay.resume(buffer, 0, buffer.sequence);
    assert.ok(buffer.bytes >= replay.MAX_BYTES - chunk.length);
    assert.ok(buffer.frames.length > 6000);
    assert.equal(result.gapFrom, 1);
    assert.equal(result.gapTo, 1);
    assert.equal(result.frames.length, buffer.frames.length);
});

test('RX replay upload budget has a bounded burst and refills at a fixed rate', () => {
    const budget = replay.createReplayBudget(1000);
    assert.equal(replay.replayBudgetDelay(budget, replay.MAX_REPLAY_BURST_BYTES, 1000), 0);
    assert.equal(replay.replayBudgetDelay(budget, 1024, 1000), 8);
    assert.equal(replay.replayBudgetDelay(budget, 1024, 1008), 0);
    assert.equal(replay.replayBudgetDelay(budget, 1024, 1008), 8);
    assert.equal(replay.replayBudgetDelay(budget, 1024, 1016), 0);
});

test('RX replay cache expires old bytes without confusing a new stream', () => {
    const buffer = replay.create('stream-old');
    replay.append(buffer, [1, 2], 1000);
    replay.append(buffer, [3], 2000);
    const result = replay.resume(buffer, 0, 2, 2000 + replay.MAX_AGE_MS);
    assert.equal(result.gapFrom, 1);
    assert.equal(result.gapTo, 2);
    assert.deepEqual(result.frames, []);
    assert.equal(buffer.frames.length, 0);
    assert.notEqual(replay.create('stream-new').streamId, buffer.streamId);
});

test('RX replay cache enforces its byte cap even when many full serial frames are retained', () => {
    const buffer = replay.create('stream-bytes');
    const bytes = new Uint8Array(16 * 1024);
    for (let i = 0; i < 65; i++) replay.append(buffer, bytes, i);
    assert.ok(buffer.bytes <= replay.MAX_BYTES);
    assert.ok(buffer.frames.length < 65);
    const result = replay.resume(buffer, 0, buffer.sequence, 65);
    assert.ok(result.gapFrom > 0);
    assert.ok(result.frames.every(frame => frame.sequence > result.gapTo));
});
