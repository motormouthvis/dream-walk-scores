/**
 * GraphQL schema and resolvers.
 *
 * The REST surface is the primary one and covers everything; GraphQL exists because
 * clients embedding scores into an existing listing page usually want three numbers and a
 * sentence, not the full breakdown, and letting them ask for exactly that saves real
 * bytes on a page that already has too many.
 *
 * Deliberately small: three queries, no mutations, no subscriptions. There is nothing to
 * mutate — this service computes, it does not store user data.
 */

import { buildSchema, graphql, type GraphQLSchema } from "graphql";
import { geocode } from "@/lib/geocode";
import { isInUnitedStates } from "@/lib/geo";
import { getScore } from "@/lib/scoreService";
import type { ScoreResult } from "@/lib/types";

export const typeDefs = /* GraphQL */ `
  """
  A Walk, Bike and Transit score for one point, with the evidence behind it.
  """
  type Score {
    location: Location!
    walk: WalkScore!
    bike: BikeScore!
    transit: TransitScore!
    "How much to trust these numbers, driven by data coverage rather than by the score."
    confidence: String!
    "Reasons confidence is not 'high'. Empty when it is."
    confidenceNotes: [String!]!
    "Plain-language 'why this score'. AI-written when requested, templated otherwise."
    summary: String
    summaryFromAi: Boolean!
    provenance: Provenance!
  }

  type Location {
    lat: Float!
    lon: Float!
    address: String
    "The point snapped to the nearest walkable street, which is what was scored."
    snappedLat: Float
    snappedLon: Float
  }

  type WalkScore {
    score: Int
    description: String
    explanation: String
    rawPoints: Float!
    maxPoints: Float!
    categories: [CategoryBreakdown!]!
    pedestrianShape: PedestrianShape!
  }

  type CategoryBreakdown {
    category: String!
    label: String!
    maxPoints: Float!
    points: Float!
    "Walking distance to the closest amenity in this category, metres."
    nearestMeters: Int
    hits: [Amenity!]!
  }

  type Amenity {
    id: String!
    name: String!
    category: String!
    lat: Float!
    lon: Float!
    crowMeters: Int!
    walkMeters: Int!
    "True when walkMeters came from real network routing rather than an estimate."
    routed: Boolean!
    points: Float!
  }

  type PedestrianShape {
    "Intersections per square kilometre, street network only."
    intersectionDensity: Float
    avgBlockLengthMeters: Int
    "Multiplier applied to the raw score for street connectivity, in [0.90, 1.0]."
    penaltyFactor: Float!
  }

  type BikeScore {
    score: Int
    description: String
    explanation: String
    components: BikeComponents!
    infrastructure: BikeInfrastructure!
    hills: Hills!
  }

  type BikeComponents {
    infrastructure: Int
    hills: Int
    destinations: Int
    connectivity: Int
  }

  type BikeInfrastructure {
    protectedLaneMeters: Int!
    paintedLaneMeters: Int!
    lowStressMeters: Int!
    totalWayMeters: Int!
  }

  type Hills {
    meanGradePct: Float
    "85th-percentile grade — the climbs a rider actually notices."
    steepGradePct: Float
    reliefMeters: Float
  }

  type TransitScore {
    score: Int
    description: String
    explanation: String
    stopCount: Int!
    routeCount: Int!
    routes: [TransitRoute!]!
    "False when no feed covers this area, which is not the same as having no transit."
    hasCoverage: Boolean!
  }

  type TransitRoute {
    routeId: String!
    shortName: String
    longName: String
    agency: String
    mode: String!
    walkMeters: Int!
    tripsPerDay: Int
  }

  type Provenance {
    osmSnapshot: String
    gtfsSnapshot: String
    "'network' when distances were routed, 'circuity-estimate' when approximated."
    distanceModel: String!
    "'precomputed-grid', 'cache' or 'live'."
    source: String!
    computeMs: Int!
  }

  type GeocodeHit {
    lat: Float!
    lon: Float!
    displayName: String!
    score: Float!
    source: String!
  }

  type Query {
    "Score a coordinate."
    score(lat: Float!, lng: Float!, ai: Boolean = false): Score!

    "Geocode an address, then score it."
    scoreAddress(address: String!, ai: Boolean = false): Score!

    "Score up to 100 coordinates in one round trip."
    scoreBatch(points: [PointInput!]!, ai: Boolean = false): [Score!]!

    "Resolve an address to a coordinate without scoring it."
    geocode(address: String!): GeocodeHit
  }

  input PointInput {
    lat: Float!
    lng: Float!
  }
`;

let cachedSchema: GraphQLSchema | null = null;

function schema(): GraphQLSchema {
  cachedSchema ??= buildSchema(typeDefs);
  return cachedSchema;
}

/** Matches the `Score` type: `lon` is exposed rather than the internal `lng` spelling. */
function toGraphQL(result: ScoreResult): unknown {
  return result;
}

function assertCoverage(lat: number, lon: number): void {
  if (!isInUnitedStates(lat, lon)) {
    throw new Error("Dream Walk Scores currently covers the United States only.");
  }
}

/** Ceiling mirrors the REST batch endpoint. */
const MAX_BATCH = Number(process.env.BATCH_MAX_POINTS ?? 100);

const rootValue = {
  async score({ lat, lng, ai }: { lat: number; lng: number; ai?: boolean }) {
    assertCoverage(lat, lng);
    return toGraphQL(await getScore(lat, lng, { ai: ai ?? false }));
  },

  async scoreAddress({ address, ai }: { address: string; ai?: boolean }) {
    const hit = await geocode(address);
    if (!hit) throw new Error(`Could not geocode "${address}".`);
    assertCoverage(hit.lat, hit.lon);
    return toGraphQL(await getScore(hit.lat, hit.lon, { address: hit.displayName, ai: ai ?? false }));
  },

  async scoreBatch({ points, ai }: { points: { lat: number; lng: number }[]; ai?: boolean }) {
    if (points.length === 0) throw new Error("`points` must not be empty.");
    if (points.length > MAX_BATCH) {
      throw new Error(`A batch may contain at most ${MAX_BATCH} points; received ${points.length}.`);
    }
    for (const p of points) assertCoverage(p.lat, p.lng);

    // Sequential rather than parallel: a batch of cold points would otherwise fan out into
    // simultaneous Overpass queries, and the REST batch endpoint exists for that case with
    // proper concurrency control.
    const results = [];
    for (const point of points) {
      results.push(toGraphQL(await getScore(point.lat, point.lng, { ai: ai ?? false })));
    }
    return results;
  },

  async geocode({ address }: { address: string }) {
    return geocode(address);
  },
};

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
}

export async function executeGraphQL(request: GraphQLRequest) {
  return graphql({
    schema: schema(),
    source: request.query,
    rootValue,
    variableValues: request.variables ?? undefined,
    operationName: request.operationName ?? undefined,
  });
}
