import { describe, expect, it } from 'vitest';
import { isE164, maskPhone, normalizePhoneToE164 } from './phone.js';

describe('normalizePhoneToE164', () => {
  it('keeps a valid E.164 number', () => {
    expect(normalizePhoneToE164('+12318310814')).toBe('+12318310814');
  });

  it('strips spaces, dashes and parentheses', () => {
    expect(normalizePhoneToE164('+1 (231) 831-0814')).toBe('+12318310814');
  });

  it('converts a leading 00 international prefix to +', () => {
    expect(normalizePhoneToE164('0049 171 1234567')).toBe('+491711234567');
  });

  it('rejects a bare national number with no country code', () => {
    expect(normalizePhoneToE164('2318310814')).toBeNull();
  });

  it('rejects empty / nullish input', () => {
    expect(normalizePhoneToE164('')).toBeNull();
    expect(normalizePhoneToE164(null)).toBeNull();
    expect(normalizePhoneToE164(undefined)).toBeNull();
  });

  it('rejects an obviously invalid number', () => {
    expect(normalizePhoneToE164('+0')).toBeNull();
    expect(normalizePhoneToE164('+abc')).toBeNull();
  });
});

describe('isE164', () => {
  it('validates format', () => {
    expect(isE164('+12318310814')).toBe(true);
    expect(isE164('12318310814')).toBe(false);
  });
});

describe('maskPhone', () => {
  it('reveals only the last two digits', () => {
    expect(maskPhone('+12318310814')).toBe('***14');
    expect(maskPhone(null)).toBe('(none)');
  });
});
