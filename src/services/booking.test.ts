import { describe, expect, it, vi } from 'vitest';
import { getAvailableSlots } from './booking.service.js';
import { fakeGuidedBoostClient } from '../testing/helpers.js';

const LEAD = 'L5';
const TZ = 'UTC';

// Availability spanning three distinct days (UTC → date key == the date).
const WINDOW = {
  slots: [
    { starts_at: '2026-12-01T10:00:00.000Z' },
    { starts_at: '2026-12-01T13:00:00.000Z' },
    { starts_at: '2026-12-02T09:00:00.000Z' },
    { starts_at: '2026-12-03T15:00:00.000Z' },
  ],
  mode: 'pool',
};

function slotsClient(window: unknown = WINDOW) {
  const getTeamSlots = vi.fn().mockResolvedValue(window);
  return { client: fakeGuidedBoostClient({ getTeamSlots }), getTeamSlots };
}

describe('getAvailableSlots — date-first flow', () => {
  it('requests team-slots with tz and NO from/to, and offers available DATES', async () => {
    const { client, getTeamSlots } = slotsClient();
    const result = await getAvailableSlots({ leadId: LEAD, timezone: TZ }, { client });

    // team-slots called with (leadId, tz) and no range argument.
    expect(getTeamSlots).toHaveBeenCalledTimes(1);
    expect(getTeamSlots.mock.calls[0]?.[0]).toBe(LEAD);
    expect(getTeamSlots.mock.calls[0]?.[1]).toBe(TZ);
    expect(getTeamSlots.mock.calls[0]?.[2]).toBeUndefined(); // no from/to range

    expect(result.available).toBe(true);
    if (result.available && result.mode === 'dates') {
      expect(result.dates.map((d) => d.date)).toEqual(['2026-12-01', '2026-12-02', '2026-12-03']);
      expect(result.dates[0]?.times_available).toBe(2);
    } else {
      expect.unreachable('expected dates mode');
    }
  });

  it('offers the TIMES for a chosen date', async () => {
    const { client } = slotsClient();
    const result = await getAvailableSlots(
      { leadId: LEAD, timezone: TZ, date: '2026-12-01' },
      { client },
    );

    expect(result.available).toBe(true);
    if (result.available && result.mode === 'times') {
      expect(result.date).toBe('2026-12-01');
      expect(result.slots).toHaveLength(2);
      // The exact CRM starts_at is preserved for booking.
      expect(result.slots[0]?.starts_at).toBe('2026-12-01T10:00:00.000Z');
      expect(result.slots[0]?.time).toContain('10:00');
    } else {
      expect.unreachable('expected times mode');
    }
  });

  it('reports no availability on a requested day with none', async () => {
    const { client } = slotsClient();
    const result = await getAvailableSlots(
      { leadId: LEAD, timezone: TZ, date: '2026-12-25' },
      { client },
    );
    expect(result.available).toBe(false);
    if (!result.available) expect(result.needs_date).toBe(true);
  });

  it('reports no availability when the CRM returns no slots', async () => {
    const { client } = slotsClient({ slots: [], mode: null });
    const result = await getAvailableSlots({ leadId: LEAD, timezone: TZ }, { client });
    expect(result.available).toBe(false);
  });

  it('asks for the timezone when it cannot be normalized', async () => {
    const { client, getTeamSlots } = slotsClient();
    const result = await getAvailableSlots({ leadId: LEAD, timezone: 'not-a-zone' }, { client });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.needs_timezone).toBe(true);
    expect(getTeamSlots).not.toHaveBeenCalled();
  });

  it('degrades to a spoken fallback when the CRM lookup throws', async () => {
    const getTeamSlots = vi.fn().mockRejectedValue(new Error('gb down'));
    const client = fakeGuidedBoostClient({ getTeamSlots });
    const result = await getAvailableSlots({ leadId: LEAD, timezone: TZ }, { client });
    expect(result.available).toBe(false);
  });
});
