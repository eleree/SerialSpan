// Bounded, in-memory receive history for a single Local serial stream.
(function (root) {
    const MAX_BYTES = 1024 * 1024;
    const MAX_FRAMES = 8192;
    const MAX_AGE_MS = 30_000;
    const MAX_REPLAY_BYTES_PER_SECOND = 128 * 1024;
    const MAX_REPLAY_BURST_BYTES = 32 * 1024;

    function newStreamId() {
        const bytes = new Uint8Array(16);
        root.crypto.getRandomValues(bytes);
        return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    }

    function create(streamId = newStreamId()) {
        return { streamId, sequence: 0, bytes: 0, frames: [], warnedEviction: false };
    }

    function prune(buffer, now = Date.now()) {
        let removedFrames = 0, removedBytes = 0;
        while (buffer.frames.length && now - buffer.frames[0].at >= MAX_AGE_MS) {
            const frame = buffer.frames.shift();
            buffer.bytes -= frame.data.length;
            removedFrames++;
            removedBytes += frame.data.length;
        }
        return { removedFrames, removedBytes };
    }

    function append(buffer, data, now = Date.now()) {
        const expired = prune(buffer, now);
        const frame = { streamId: buffer.streamId, sequence: ++buffer.sequence, at: now, data: Uint8Array.from(data) };
        buffer.frames.push(frame);
        buffer.bytes += frame.data.length;
        let removedFrames = expired.removedFrames, removedBytes = expired.removedBytes;
        while (buffer.frames.length > MAX_FRAMES || buffer.bytes > MAX_BYTES) {
            const removed = buffer.frames.shift();
            buffer.bytes -= removed.data.length;
            removedFrames++;
            removedBytes += removed.data.length;
        }
        return { frame, removedFrames, removedBytes };
    }

    function resume(buffer, afterSequence, throughSequence, now = Date.now()) {
        prune(buffer, now);
        const oldest = buffer.frames.length ? buffer.frames[0].sequence : buffer.sequence + 1;
        const gapTo = Math.min(throughSequence, oldest - 1);
        return {
            streamId: buffer.streamId,
            throughSequence,
            gapFrom: afterSequence + 1 <= gapTo ? afterSequence + 1 : 0,
            gapTo: afterSequence + 1 <= gapTo ? gapTo : 0,
            frames: buffer.frames.filter(frame => frame.sequence > afterSequence && frame.sequence <= throughSequence)
        };
    }

    function createReplayBudget(now = Date.now()) {
        return { tokens: MAX_REPLAY_BURST_BYTES, updatedAt: now };
    }

    function replayBudgetDelay(budget, bytes, now = Date.now()) {
        const elapsed = Math.max(0, now - budget.updatedAt);
        budget.tokens = Math.min(MAX_REPLAY_BURST_BYTES, budget.tokens + elapsed * MAX_REPLAY_BYTES_PER_SECOND / 1000);
        budget.updatedAt = now;
        if (budget.tokens >= bytes) {
            budget.tokens -= bytes;
            return 0;
        }
        const delay = Math.ceil((bytes - budget.tokens) * 1000 / MAX_REPLAY_BYTES_PER_SECOND);
        budget.tokens = 0;
        return delay;
    }

    const api = { MAX_BYTES, MAX_FRAMES, MAX_AGE_MS, MAX_REPLAY_BYTES_PER_SECOND, MAX_REPLAY_BURST_BYTES,
        create, append, prune, resume, createReplayBudget, replayBudgetDelay };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.RxReplay = api;
})(globalThis);
