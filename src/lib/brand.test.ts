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

  describe('live four-brand mapping (HW, PH, TH, AH)', () => {
    // The exact production mapping: each brand's dialed number resolves to its code.
    const s = source({
      GUIDED_BOOST_BRAND: 'HW',
      INBOUND_BRAND_NUMBERS: '+12318310814=HW,+12088125606=PH,+12086266299=TH,+17622403272=AH',
    });

    it('resolves the HW number to HW', () => {
      expect(resolveBrand('+12318310814', s)).toBe('HW');
    });

    it('resolves the PatagoniaHero number to PH', () => {
      expect(resolveBrand('+12088125606', s)).toBe('PH');
      // Also accepts a non-normalized form of the same number.
      expect(resolveBrand('+1 (208) 812-5606', s)).toBe('PH');
    });

    it('resolves the TrekkingHero number to TH', () => {
      expect(resolveBrand('+12086266299', s)).toBe('TH');
      expect(resolveBrand('+1 (208) 626-6299', s)).toBe('TH');
    });

    it('resolves the AdventureHero number to AH', () => {
      expect(resolveBrand('+17622403272', s)).toBe('AH');
      expect(resolveBrand('+1 (762) 240-3272', s)).toBe('AH');
    });

    it('still falls back to HW for an unmapped number', () => {
      expect(resolveBrand('+14155550123', s)).toBe('HW');
      expect(resolveBrand(null, s)).toBe('HW');
    });
  });
});
