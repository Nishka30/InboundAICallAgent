import { describe, expect, it } from 'vitest';
import { verifyRetellSignature } from './webhookVerify.js';
import { signRetell } from '../../testing/helpers.js';

const KEY = 'secret_key';
const BODY = JSON.stringify({ event: 'call_started', call: { call_id: 'abc' } });

describe('verifyRetellSignature', () => {
  it('accepts a correctly signed body', () => {
    const now = Date.now();
    const sig = signRetell(BODY, KEY, now);
    expect(verifyRetellSignature(BODY, KEY, sig, { now })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const now = Date.now();
    const sig = signRetell(BODY, KEY, now);
    expect(verifyRetellSignature(`${BODY} `, KEY, sig, { now })).toBe(false);
  });

  it('rejects a wrong key', () => {
    const now = Date.now();
    const sig = signRetell(BODY, KEY, now);
    expect(verifyRetellSignature(BODY, 'other_key', sig, { now })).toBe(false);
  });

  it('rejects a malformed signature header', () => {
    expect(verifyRetellSignature(BODY, KEY, 'not-a-signature')).toBe(false);
    expect(verifyRetellSignature(BODY, KEY, '')).toBe(false);
  });

  it('rejects a stale timestamp outside the replay window', () => {
    const past = Date.now() - 10 * 60 * 1000;
    const sig = signRetell(BODY, KEY, past);
    expect(verifyRetellSignature(BODY, KEY, sig, { now: Date.now() })).toBe(false);
  });

  it('rejects when the api key is missing', () => {
    const sig = signRetell(BODY, KEY);
    expect(verifyRetellSignature(BODY, '', sig)).toBe(false);
  });
});
