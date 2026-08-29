import { describe, expect, it, vi } from 'vitest';
import {
  addressLooksLike,
  geocodeUsAddress,
  matchSavedAddress,
  pickAddressCandidate,
} from '@/integrations/doordash/resolve-address';
import { err, ok } from '@/lib/result';

describe('resolve-address', () => {
  it('matches a saved address that shares the street number and name', () => {
    const matched = matchSavedAddress(
      [
        {
          address_id: 'addr-sf',
          printable_address: '100 Test Street, San Francisco, CA 94105',
          lat: 37.789,
          lng: -122.394,
          is_default: true,
        },
        {
          address_id: 'addr-foxhurst',
          printable_address: '1056 Foxhurst Way, San Jose, CA 95120',
          lat: 37.221,
          lng: -121.86,
          is_default: false,
        },
      ],
      '1056 Foxhurst Way, San Jose, CA 95120',
    );

    expect(matched?.address_id).toBe('addr-foxhurst');
  });

  it('picks a single DoorDash find candidate that looks like the typed address', () => {
    const picked = pickAddressCandidate(
      [
        {
          place_id: 'place-foxhurst',
          description: '1056 Foxhurst Way, San Jose, California 95120, United States',
        },
      ],
      '1056 Foxhurst Way, San Jose, CA 95120',
    );

    expect(picked?.place_id).toBe('place-foxhurst');
    expect(
      addressLooksLike(
        '1056 Foxhurst Way, San Jose, California 95120, United States',
        '1056 Foxhurst Way, San Jose, CA 95120',
      ),
    ).toBe(true);
  });

  it('asks the user when two find candidates score the same', () => {
    expect(
      pickAddressCandidate(
        [
          { place_id: 'a', description: '1056 Foxhurst Way, San Jose, CA 95120' },
          { place_id: 'b', description: '1056 Foxhurst Way, San Jose, California 95120' },
        ],
        '1056 Foxhurst Way, San Jose, CA 95120',
      ),
    ).toBeNull();
  });

  it('geocodes a US address through the Census locator', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: { addressMatches: [{ coordinates: { x: -121.86, y: 37.221 } }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      geocodeUsAddress('1056 Foxhurst Way, San Jose, CA 95120', fetchImpl),
    ).resolves.toEqual(ok({ lat: 37.221, lng: -121.86 }));
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('geocoding.geo.census.gov');
  });

  it('returns a stable error when Census has no match', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ result: { addressMatches: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(geocodeUsAddress('not a real place', fetchImpl)).resolves.toEqual(
      err('geocode_no_match'),
    );
  });
});
