import { ConfigLayer } from '@basemaps/config';
import { extractYearRangeFromTitle } from '@basemaps/shared';
import { LambdaHttpRequest, LambdaHttpResponse } from '@linzjs/lambda';

export const FilterNames = {
  DateBefore: 'date[before]',
  DateAfter: 'date[after]',
};

export function getFilters(req: LambdaHttpRequest): Record<string, string | undefined> {
  return {
    [FilterNames.DateBefore]: req.query.get(FilterNames.DateBefore) ?? undefined,
    [FilterNames.DateAfter]: req.query.get(FilterNames.DateAfter) ?? undefined,
  };
}
/**
 * Convert the year range into full ISO date year range
 *
 * Expand to the full year of jan 1st 00:00 -> Dec 31st 23:59
 */
export function yearRangeToInterval(x: [number] | [number, number]): [Date, Date] {
  if (x.length === 1) return [new Date(`${x[0]}-01-01T00:00:00.000Z`), new Date(`${x[0]}-12-31T23:59:59.999Z`)];
  return [new Date(`${x[0]}-01-01T00:00:00.000Z`), new Date(`${x[1]}-12-31T23:59:59.999Z`)];
}

function parseDateAsIso(s: string | null): Date | null {
  if (s == null) return null;
  const date = new Date(s);
  if (isNaN(date.getTime())) throw new LambdaHttpResponse(400, `Invalid date format: "${s}"`);
  return date;
}

export function filterLayers(req: LambdaHttpRequest, layers: ConfigLayer[]): ConfigLayer[] {
  const dateAfterQuery = req.query.get(FilterNames.DateAfter);
  const dateBeforeQuery = req.query.get(FilterNames.DateBefore);

  if (dateAfterQuery == null && dateBeforeQuery == null) return layers;
  const dateAfter = parseDateAsIso(dateAfterQuery);
  const dateBefore = parseDateAsIso(dateBeforeQuery);

  const filtered = layers.filter((l) => {
    if (l.title == null) return false;
    const yearRange = extractYearRangeFromTitle(l.title);
    if (yearRange == null) return false;

    const ranges = yearRangeToInterval(yearRange);
    const startYear = ranges[0];
    const endYear = ranges[1];
    return (dateAfter == null || endYear >= dateAfter) && (dateBefore == null || startYear <= dateBefore);
  });

  // Trace that layers have been filtered
  req.set('layerFilter', {
    [FilterNames.DateBefore]: dateBefore?.toISOString(),
    [FilterNames.DateAfter]: dateAfter?.toISOString(),
    layerCount: layers.length,
    filterCount: filtered.length,
  });
  return filtered;
}
