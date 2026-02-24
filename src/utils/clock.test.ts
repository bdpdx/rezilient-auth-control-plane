import { describe, test } from 'node:test';
import assert from 'node:assert';
import { SystemClock, FixedClock } from './clock';

describe('SystemClock', () => {
    test('now() returns Date near current time', () => {
        const clock = new SystemClock();
        const before = Date.now();
        const result = clock.now();
        const after = Date.now();
        assert.ok(result instanceof Date);
        assert.ok(result.getTime() >= before);
        assert.ok(result.getTime() <= after);
    });
});

describe('FixedClock', () => {
    test('constructor parses ISO datetime', () => {
        const clock = new FixedClock('2026-01-15T10:00:00.000Z');
        const result = clock.now();
        assert.strictEqual(
            result.toISOString(),
            '2026-01-15T10:00:00.000Z'
        );
    });

    test('now() returns fixed time on repeated calls', () => {
        const clock = new FixedClock('2026-01-15T10:00:00.000Z');
        const t1 = clock.now();
        const t2 = clock.now();
        assert.strictEqual(
            t1.toISOString(),
            t2.toISOString()
        );
    });

    test('advanceSeconds moves time forward', () => {
        const clock = new FixedClock('2026-01-15T10:00:00.000Z');
        clock.advanceSeconds(60);
        assert.strictEqual(
            clock.now().toISOString(),
            '2026-01-15T10:01:00.000Z'
        );
    });

    test('advanceSeconds is cumulative', () => {
        const clock = new FixedClock('2026-01-15T10:00:00.000Z');
        clock.advanceSeconds(30);
        clock.advanceSeconds(30);
        assert.strictEqual(
            clock.now().toISOString(),
            '2026-01-15T10:01:00.000Z'
        );
    });

    test('set jumps to specified time', () => {
        const clock = new FixedClock('2026-01-15T10:00:00.000Z');
        clock.set('2026-06-01T00:00:00.000Z');
        assert.strictEqual(
            clock.now().toISOString(),
            '2026-06-01T00:00:00.000Z'
        );
    });

    test('set can move backward', () => {
        const clock = new FixedClock('2026-06-01T00:00:00.000Z');
        clock.set('2025-01-01T00:00:00.000Z');
        assert.strictEqual(
            clock.now().toISOString(),
            '2025-01-01T00:00:00.000Z'
        );
    });

    test('advance then set replaces advance', () => {
        const clock = new FixedClock('2026-01-15T10:00:00.000Z');
        clock.advanceSeconds(3600);
        clock.set('2026-01-15T10:00:00.000Z');
        assert.strictEqual(
            clock.now().toISOString(),
            '2026-01-15T10:00:00.000Z'
        );
    });

    test('now() returns independent Date copies', () => {
        const clock = new FixedClock('2026-01-15T10:00:00.000Z');
        const d1 = clock.now();
        d1.setFullYear(1999);
        const d2 = clock.now();
        assert.strictEqual(
            d2.toISOString(),
            '2026-01-15T10:00:00.000Z'
        );
    });
});
