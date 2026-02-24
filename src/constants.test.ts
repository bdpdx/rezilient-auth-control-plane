import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isServiceScope } from './constants';

describe('isServiceScope', () => {
    test('returns true for reg', () => {
        assert.strictEqual(isServiceScope('reg'), true);
    });

    test('returns true for rrs', () => {
        assert.strictEqual(isServiceScope('rrs'), true);
    });

    test('returns false for unknown string', () => {
        assert.strictEqual(isServiceScope('unknown'), false);
    });

    test('returns false for empty string', () => {
        assert.strictEqual(isServiceScope(''), false);
    });
});
