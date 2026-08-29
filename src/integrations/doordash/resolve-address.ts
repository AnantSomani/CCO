import { err, ok, type Result } from '@/lib/result';

export type ResolvedDeliveryLocation = {
  printableAddress: string;
  lat: number;
  lng: number;
  source: 'saved' | 'found';
  addressId?: string;
  placeId?: string;
};

export type AddressCandidate = {
  place_id: string;
  description: string;
};

export type SavedDeliveryAddress = {
  id?: string;
  address_id?: string;
  address_link_id?: string;
  printable_address?: string | null;
  formatted_address?: string | null;
  address?: string | null;
  label?: string | null;
  lat: number;
  lng: number;
  is_default?: boolean;
};

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const tokens = (value: string): string[] =>
  normalize(value)
    .split(' ')
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));

const STOP_WORDS = new Set([
  'ca',
  'california',
  'united',
  'states',
  'usa',
  'st',
  'street',
  'ave',
  'avenue',
  'rd',
  'road',
  'dr',
  'drive',
  'blvd',
  'way',
  'ln',
  'lane',
]);

export const savedAddressLabel = (address: SavedDeliveryAddress): string | null =>
  address.printable_address ??
  address.formatted_address ??
  address.address ??
  address.label ??
  null;

export const savedAddressId = (address: SavedDeliveryAddress): string | undefined =>
  address.address_id ?? address.id ?? address.address_link_id;

export const addressLooksLike = (candidate: string, query: string): boolean => {
  const queryTokens = tokens(query);
  const haystack = normalize(candidate);
  if (queryTokens.length === 0) return false;
  const streetNumber = queryTokens.find((token) => /^\d+$/.test(token));
  if (streetNumber && !haystack.includes(streetNumber)) return false;
  const hits = queryTokens.filter((token) => haystack.includes(token)).length;
  return hits >= Math.min(3, queryTokens.length);
};

export const pickAddressCandidate = (
  candidates: AddressCandidate[],
  query: string,
): AddressCandidate | null => {
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort(
    (left, right) =>
      scoreCandidate(right.description, query) - scoreCandidate(left.description, query),
  );
  const best = ranked[0];
  const second = ranked[1];
  if (!best || !addressLooksLike(best.description, query)) return null;
  if (candidates.length === 1) return best;
  if (
    second &&
    scoreCandidate(best.description, query) <= scoreCandidate(second.description, query)
  ) {
    return null;
  }
  return best;
};

const scoreCandidate = (description: string, query: string): number => {
  const queryTokens = tokens(query);
  const haystack = normalize(description);
  return queryTokens.filter((token) => haystack.includes(token)).length;
};

export const matchSavedAddress = (
  addresses: SavedDeliveryAddress[],
  query: string,
): SavedDeliveryAddress | null => {
  const matches = addresses.filter((address) => {
    const label = savedAddressLabel(address);
    return label ? addressLooksLike(label, query) : false;
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

export const geocodeUsAddress = async (
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<{ lat: number; lng: number }, string>> => {
  const url = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
  url.searchParams.set('address', query);
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('format', 'json');
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return err('geocode_unavailable');
    const body = (await response.json()) as {
      result?: { addressMatches?: Array<{ coordinates?: { x?: number; y?: number } }> };
    };
    const match = body.result?.addressMatches?.[0]?.coordinates;
    if (typeof match?.y !== 'number' || typeof match?.x !== 'number') {
      return err('geocode_no_match');
    }
    return ok({ lat: match.y, lng: match.x });
  } catch {
    return err('geocode_unavailable');
  }
};
