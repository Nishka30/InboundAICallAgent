import { describe, expect, it } from 'vitest';
import { parseBrandMap, resolveBrand } from './brand.js';
import type { Env } from '../config/env.js';

function source(over: Partial<Env>): Env {
  return { GUIDED_BOOST_BRAND: 'HW', INBOUND_BRAND_NUMBERS: undefined, ...over } as Env;
}

describe('parseBrandMap', () => {
  it('parses comma-separated e164=brand pairs (normalized)', () => {
    const map = parseBrandMap('+12318310814=HW,+1 (555) 000-0001=TH');
    expect(map.get('+12318310814')).toBe('HW');
    expect(map.get('+15550000001')).toBe('TH');
  });

  it('is empty for undefined / blank input', () => {
    expect(parseBrandMap(undefined).size).toBe(0);
    expect(parseBrandMap('   ').size).toBe(0);
  });

  it('skips malformed entries', () => {
    const map = parseBrandMap('=HW,+12318310814=,garbage,+12318310814=HW');
    expect(map.size).toBe(1);
    expect(map.get('+12318310814')).toBe('HW');
  });
});

describe('resolveBrand', () => {
  it('uses the default brand when no mapping is configured (single-brand mode)', () => {
    expect(resolveBrand('+12318310814', source({}))).toBe('HW');
    expect(resolveBrand(null, source({}))).toBe('HW');
  });

  it('resolves the brand from the dialed number when mapped', () => {
    const s = source({ INBOUND_BRAND_NUMBERS: '+12318310814=HW,+15550000002=TH' });
    expect(resolveBrand('+15550000002', s)).toBe('TH');
    expect(resolveBrand('+12318310814', s)).toBe('HW');
  });

  it('falls back to the default brand (not a wrong guess) for an unmapped dialed number', () => {
    const s = source({ GUIDED_BOOST_BRAND: 'HW', INBOUND_BRAND_NUMBERS: '+15550000002=TH' });
    // +19999999999 is not in the map → default HW (with a logged warning), never TH.
    expect(resolveBrand('+19999999999', s)).toBe('HW');
  });
});
