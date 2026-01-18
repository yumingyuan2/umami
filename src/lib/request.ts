import { z } from 'zod';
import { checkAuth } from '@/lib/auth';
import { DEFAULT_PAGE_SIZE, FILTER_COLUMNS } from '@/lib/constants';
import { getAllowedUnits, getMinimumUnit, maxDate, parseDateRange } from '@/lib/date';
import { fetchWebsite } from '@/lib/load';
import { filtersArrayToObject } from '@/lib/params';
import { badRequest, unauthorized } from '@/lib/response';
import type { QueryFilters } from '@/lib/types';
import { getWebsiteSegment } from '@/queries/prisma';

export async function parseRequest(
  request: Request,
  schema?: any,
  options?: { skipAuth: boolean },
): Promise<any> {
  const url = new URL(request.url);
  let query = Object.fromEntries(url.searchParams);
  let body = await getJsonBody(request);
  let error: () => undefined | undefined;
  let auth = null;

  if (schema) {
    const isGet = request.method === 'GET';
    const result = schema.safeParse(isGet ? query : body);

    if (!result.success) {
      error = () => badRequest(z.treeifyError(result.error));
    } else if (isGet) {
      query = result.data;
    } else {
      body = result.data;
    }
  }

  if (!options?.skipAuth && !error) {
    auth = await checkAuth(request);

    if (!auth) {
      error = () => unauthorized();
    }
  }

  return { url, query, body, auth, error };
}

export async function getJsonBody(request: Request) {
  try {
    const headers = Object.fromEntries(request.headers);

    // Log headers to debug environment issues
    console.log('[RequestDebug] Headers:', JSON.stringify(headers));
    console.log('[RequestDebug] Method:', request.method, 'URL:', request.url);

    // Try to clone first
    let req = request;
    try {
      req = request.clone();
    } catch (e) {
      console.warn('[RequestDebug] Clone failed, using original request', e);
    }

    let text;
    try {
      text = await req.text();
    } catch (textError) {
      console.warn(
        '[RequestDebug] Failed to read text from cloned request, trying original',
        textError,
      );
      // Fallback: If clone failed to produce a readable stream (e.g. platform specific issue), try original
      if (req !== request) {
        try {
          text = await request.text();
        } catch (origError) {
          console.error('[RequestDebug] Failed to read text from original request', origError);
        }
      }
    }

    console.log('[RequestDebug] Raw Body Text:', text ? text.substring(0, 1000) : '<empty>');

    if (!text) {
      return undefined;
    }

    try {
      return JSON.parse(text);
    } catch (jsonErr) {
      console.error('[RequestDebug] JSON Parse Error:', jsonErr);
      return undefined;
    }
  } catch (e) {
    console.error('[RequestDebug] Body Read Error:', e);
    return undefined;
  }
}

export function getRequestDateRange(query: Record<string, string>) {
  const { startAt, endAt, unit, timezone } = query;

  const startDate = new Date(+startAt);
  const endDate = new Date(+endAt);

  return {
    startDate,
    endDate,
    timezone,
    unit: getAllowedUnits(startDate, endDate).includes(unit)
      ? unit
      : getMinimumUnit(startDate, endDate),
  };
}

export function getRequestFilters(query: Record<string, any>) {
  const result: Record<string, any> = {};

  for (const key of Object.keys(FILTER_COLUMNS)) {
    const value = query[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

export async function setWebsiteDate(websiteId: string, data: Record<string, any>) {
  const website = await fetchWebsite(websiteId);

  if (website?.resetAt) {
    data.startDate = maxDate(data.startDate, new Date(website?.resetAt));
  }

  return data;
}

export async function getQueryFilters(
  params: Record<string, any>,
  websiteId?: string,
): Promise<QueryFilters> {
  const dateRange = getRequestDateRange(params);
  const filters = getRequestFilters(params);

  if (websiteId) {
    await setWebsiteDate(websiteId, dateRange);

    if (params.segment) {
      const segmentParams = (await getWebsiteSegment(websiteId, params.segment))
        ?.parameters as Record<string, any>;

      Object.assign(filters, filtersArrayToObject(segmentParams.filters));
    }

    if (params.cohort) {
      const cohortParams = (await getWebsiteSegment(websiteId, params.cohort))
        ?.parameters as Record<string, any>;

      const { startDate, endDate } = parseDateRange(cohortParams.dateRange);

      const cohortFilters = cohortParams.filters.map(({ name, ...props }) => ({
        ...props,
        name: `cohort_${name}`,
      }));

      cohortFilters.push({
        name: `cohort_${cohortParams.action.type}`,
        operator: 'eq',
        value: cohortParams.action.value,
      });

      Object.assign(filters, {
        ...filtersArrayToObject(cohortFilters),
        cohort_startDate: startDate,
        cohort_endDate: endDate,
      });
    }
  }

  return {
    ...dateRange,
    ...filters,
    page: params?.page,
    pageSize: params?.pageSize ? params?.pageSize || DEFAULT_PAGE_SIZE : undefined,
    orderBy: params?.orderBy,
    sortDescending: params?.sortDescending,
    search: params?.search,
    compare: params?.compare,
  };
}
