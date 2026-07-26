/**
 * GET /api/geocode?address=…
 *
 * Address to coordinate, using only free geocoders. Exposed separately from `/api/score`
 * so a caller can resolve once and then score many times — a search page geocoding a
 * neighbourhood and then scoring listings within it should not pay for the lookup twice.
 */

import { ApiFailure, ERROR_CODES, handle, preflight } from "@/lib/api/respond";
import { geocode } from "@/lib/geocode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function OPTIONS(): Response {
  return preflight();
}

export async function GET(request: Request): Promise<Response> {
  return handle(
    request,
    async ({ url }) => {
      const address = url.searchParams.get("address")?.trim();
      if (!address) {
        throw new ApiFailure(400, ERROR_CODES.badRequest, "`address` is required.");
      }

      const result = await geocode(address);
      if (!result) {
        throw new ApiFailure(404, ERROR_CODES.notFound, `Could not geocode "${address}".`);
      }
      return result;
    },
    // Addresses do not move.
    { cacheSeconds: 86_400 }
  );
}
