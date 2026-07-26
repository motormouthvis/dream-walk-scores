/**
 * Unit tests for the pure scoring logic.
 *
 * Everything here runs offline against synthetic inputs. The point is to pin down the
 * behaviours that are easy to break silently during a calibration pass — the shape of the
 * decay curve, the slot-assignment rule, and the null-versus-zero distinction — as
 * opposed to the absolute score values, which are supposed to move when constants are
 * retuned and are validated against reference data by `scripts/calibrate.ts`.
 *
 *   npx tsx --test tests/scoring.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { haversineMeters, pointToSegmentMeters, snapToGrid, isInUnitedStates } from "@/lib/geo";
import { bikeDecayWeight, band, circuityFactor, decayWeight, pedestrianPenaltyFactor } from "@/lib/scoring/decay";
import { MAX_RAW_POINTS, METERS_PER_MILE, WALK_BANDS } from "@/lib/scoring/constants";
import { calculateWalkScore, categoryPointsRatio, type ScorableAmenity } from "@/lib/scoring/walk";
import { calculateTransitScore, frequencyFactor, gtfsRouteTypeToMode, transitDecay } from "@/lib/scoring/transit";
import { calculateBikeScore, hillScore, infrastructureScore } from "@/lib/scoring/bike";
import { classify, bikeStress, isStreet } from "@/lib/osm/tags";
import { extractAddress } from "@/lib/embed/addressExtract";
import { mergeTransitSources } from "@/lib/transit/merge";
import { buildGraph, networkShape, snapToNetwork, dijkstra } from "@/lib/network";
import type { OsmElement } from "@/lib/osm/overpass";

function amenity(over: Partial<ScorableAmenity> = {}): ScorableAmenity {
  return {
    id: "osm:node/1",
    name: "Test",
    category: "grocery",
    lat: 0,
    lon: 0,
    crowMeters: 100,
    walkMeters: 100,
    quality: 1,
    routed: true,
    ...over,
  };
}

describe("geo", () => {
  it("measures a known distance", () => {
    // One degree of latitude is close to 111 km everywhere.
    const meters = haversineMeters(40, -74, 41, -74);
    assert.ok(Math.abs(meters - 111_195) < 500, `got ${meters}`);
  });

  it("returns zero for identical points", () => {
    assert.equal(haversineMeters(40.7, -74, 40.7, -74), 0);
  });

  it("projects a point onto a segment and clamps at the ends", () => {
    // A point beyond the far endpoint should snap to that endpoint, not past it.
    const hit = pointToSegmentMeters(0, 0.002, 0, 0, 0, 0.001);
    assert.ok(Math.abs(hit.lon - 0.001) < 1e-9);
  });

  it("snaps nearby coordinates into the same grid cell", () => {
    const a = snapToGrid(40.75801, -73.98551, 100);
    const b = snapToGrid(40.75809, -73.98559, 100);
    assert.deepEqual(a, b);
  });

  it("recognises US territory and rejects everything else", () => {
    assert.ok(isInUnitedStates(40.758, -73.9855));
    assert.ok(isInUnitedStates(21.3, -157.8), "Hawaii");
    assert.ok(isInUnitedStates(61.2, -149.9), "Alaska");
    assert.ok(!isInUnitedStates(51.5, -0.12), "London");
  });
});

describe("distance decay", () => {
  it("gives full weight inside a five-minute walk", () => {
    assert.equal(decayWeight(0), 1);
    assert.equal(decayWeight(0.25 * METERS_PER_MILE), 1);
  });

  it("gives no weight past a thirty-minute walk", () => {
    assert.equal(decayWeight(1.5 * METERS_PER_MILE), 0);
    assert.equal(decayWeight(10_000), 0);
  });

  it("decreases monotonically", () => {
    let previous = 1.0001;
    for (let meters = 0; meters <= 2600; meters += 50) {
      const weight = decayWeight(meters);
      assert.ok(weight <= previous, `weight rose at ${meters} m`);
      previous = weight;
    }
  });

  it("stays generous just past a five-minute walk", () => {
    // This range governs urban scores: in a dense neighbourhood the first amenity in each
    // category is always close, and it is the later slots that sit around here.
    // Steepening this section pushes city scores down by ten points or more.
    const nearby = decayWeight(0.4 * METERS_PER_MILE);
    assert.ok(nearby >= 0.85, `0.4-mile weight was ${nearby}`);
  });

  it("falls away sharply beyond three quarters of a mile", () => {
    // This range governs suburban scores, where the nearest supermarket sits. Flattening
    // it inflates them by twenty points or more.
    assert.ok(decayWeight(0.75 * METERS_PER_MILE) <= 0.5);
    assert.ok(decayWeight(METERS_PER_MILE) <= 0.25);
  });

  it("is more forgiving for cycling than for walking", () => {
    const meters = METERS_PER_MILE;
    assert.ok(bikeDecayWeight(meters) > decayWeight(meters));
    assert.equal(bikeDecayWeight(0.9 * METERS_PER_MILE), 1);
  });

  it("rejects nonsense input rather than propagating NaN", () => {
    assert.equal(decayWeight(Number.NaN), 0);
    assert.equal(decayWeight(-5), 0);
  });
});

describe("pedestrian penalty", () => {
  it("does not penalise a dense, short-block grid", () => {
    // Midtown Manhattan measures about 52 intersections/km² over the street network.
    assert.equal(pedestrianPenaltyFactor(52, 126), 0.99);
  });

  it("penalises a sparse network with long blocks", () => {
    assert.ok(pedestrianPenaltyFactor(8, 400) <= 0.9 + 1e-9);
  });

  it("never docks more than ten per cent", () => {
    for (const density of [0, 5, 20, 50, 500]) {
      for (const block of [10, 100, 300, 5000]) {
        const factor = pedestrianPenaltyFactor(density, block);
        assert.ok(factor >= 0.9 - 1e-9 && factor <= 1, `factor ${factor}`);
      }
    }
  });

  it("assumes a middling penalty when the network is unknown", () => {
    const factor = pedestrianPenaltyFactor(null, null);
    assert.ok(factor > 0.9 && factor < 1);
  });

  it("estimates greater circuity in sparser networks", () => {
    assert.ok(circuityFactor(5) > circuityFactor(60));
    assert.ok(circuityFactor(60) >= 1.2);
  });
});

describe("walk score", () => {
  it("returns zero when there is nothing nearby", () => {
    const result = calculateWalkScore({ amenities: [], intersectionDensity: 50, avgBlockLengthMeters: 100 });
    assert.equal(result.score, 0);
    assert.equal(result.rawPoints, 0);
  });

  it("approaches 100 when every category is on the doorstep", () => {
    const amenities: ScorableAmenity[] = [];
    for (const category of ["grocery", "restaurants", "shopping", "coffee", "banks", "parks", "schools", "books", "entertainment"] as const) {
      // Ten of each covers even the restaurants category's ten weighted slots.
      for (let i = 0; i < 10; i++) {
        amenities.push(amenity({ id: `${category}-${i}`, category, walkMeters: 100, crowMeters: 100 }));
      }
    }
    const result = calculateWalkScore({ amenities, intersectionDensity: 60, avgBlockLengthMeters: 90 });
    assert.equal(result.score, 100);
    assert.ok(Math.abs(result.rawPoints - MAX_RAW_POINTS) < 0.01);
  });

  it("gives the highest-weight slot to the best amenity, not the closest", () => {
    // A supermarket slightly further out should claim the 3-point grocery slot ahead of a
    // corner store, otherwise a neighbourhood with a real supermarket is understated.
    const withSupermarket = calculateWalkScore({
      amenities: [
        amenity({ id: "corner", category: "grocery", quality: 0.45, walkMeters: 100 }),
        amenity({ id: "super", category: "grocery", quality: 1.0, walkMeters: 300 }),
      ],
      intersectionDensity: 60,
      avgBlockLengthMeters: 90,
    });
    const cornerOnly = calculateWalkScore({
      amenities: [amenity({ id: "corner", category: "grocery", quality: 0.45, walkMeters: 100 })],
      intersectionDensity: 60,
      avgBlockLengthMeters: 90,
    });
    assert.ok(withSupermarket.rawPoints > cornerOnly.rawPoints);
  });

  it("weights a nearer amenity above a further identical one", () => {
    const near = calculateWalkScore({
      amenities: [amenity({ walkMeters: 200 })],
      intersectionDensity: 60,
      avgBlockLengthMeters: 90,
    });
    const far = calculateWalkScore({
      amenities: [amenity({ walkMeters: 1800 })],
      intersectionDensity: 60,
      avgBlockLengthMeters: 90,
    });
    assert.ok(near.rawPoints > far.rawPoints);
  });

  it("ignores amenities beyond the walk cutoff", () => {
    const result = calculateWalkScore({
      amenities: [amenity({ walkMeters: 3000 })],
      intersectionDensity: 60,
      avgBlockLengthMeters: 90,
    });
    assert.equal(result.rawPoints, 0);
    assert.equal(result.categories.find((c) => c.category === "grocery")?.hits.length, 0);
  });

  it("caps a category at its available slots", () => {
    // Coffee has two slots; twenty cafés cannot earn more than two cafés' worth.
    const many = Array.from({ length: 20 }, (_, i) =>
      amenity({ id: `cafe-${i}`, category: "coffee", walkMeters: 100 })
    );
    const result = calculateWalkScore({ amenities: many, intersectionDensity: 60, avgBlockLengthMeters: 90 });
    const coffee = result.categories.find((c) => c.category === "coffee");
    assert.equal(coffee?.hits.length, 2);
    assert.ok(Math.abs((coffee?.points ?? 0) - 2) < 0.01);
  });

  it("reports hits nearest first", () => {
    const result = calculateWalkScore({
      amenities: [
        amenity({ id: "a", category: "restaurants", walkMeters: 800 }),
        amenity({ id: "b", category: "restaurants", walkMeters: 200 }),
      ],
      intersectionDensity: 60,
      avgBlockLengthMeters: 90,
    });
    const hits = result.categories.find((c) => c.category === "restaurants")?.hits ?? [];
    assert.equal(hits[0].id, "b");
  });

  it("produces a ratio in [0,1] for the bike destinations component", () => {
    const ratio = categoryPointsRatio([amenity()], bikeDecayWeight);
    assert.ok(ratio > 0 && ratio <= 1);
    assert.equal(categoryPointsRatio([], bikeDecayWeight), 0);
  });
});

describe("score bands", () => {
  it("labels the top of the scale a walker's paradise", () => {
    assert.equal(band(WALK_BANDS, 95).label, "Walker's Paradise");
  });

  it("labels the bottom of the scale car-dependent", () => {
    assert.equal(band(WALK_BANDS, 5).label, "Car-Dependent");
  });

  it("covers every score without a gap", () => {
    for (let score = 0; score <= 100; score++) {
      assert.ok(band(WALK_BANDS, score).label.length > 0);
    }
  });
});

describe("transit score", () => {
  it("reports no score rather than zero when no feed covers the area", () => {
    const result = calculateTransitScore({ routes: [], stopCount: 0, hasCoverage: false });
    // The distinction matters: "we don't know" must not read as "there is no transit".
    assert.equal(result.score, null);
    assert.equal(result.hasCoverage, false);
  });

  it("reports zero when the area is covered but has no service", () => {
    const result = calculateTransitScore({ routes: [], stopCount: 0, hasCoverage: true });
    assert.equal(result.score, 0);
  });

  it("values frequency with diminishing returns", () => {
    assert.ok(frequencyFactor(72) > frequencyFactor(18));
    assert.ok(frequencyFactor(400) - frequencyFactor(200) < frequencyFactor(72) - frequencyFactor(18));
    assert.equal(frequencyFactor(0), 0);
    assert.ok(frequencyFactor(null) > 0, "unknown frequency should not zero out a route");
  });

  it("values rail above a bus at the same frequency and distance", () => {
    const base = { shortName: "1", longName: null, agency: null, walkMeters: 200, tripsPerDay: 100 };
    const rail = calculateTransitScore({
      routes: [{ ...base, routeId: "r", mode: "subway" }],
      stopCount: 1,
      hasCoverage: true,
    });
    const bus = calculateTransitScore({
      routes: [{ ...base, routeId: "b", mode: "bus" }],
      stopCount: 1,
      hasCoverage: true,
    });
    assert.ok((rail.score ?? 0) > (bus.score ?? 0));
  });

  it("gives a lone infrequent bus a small but non-zero score", () => {
    // A linear normalisation would round this to zero, erasing a real distinction.
    const result = calculateTransitScore({
      routes: [
        { routeId: "b", shortName: "12", longName: null, agency: null, mode: "bus", walkMeters: 300, tripsPerDay: 18 },
      ],
      stopCount: 1,
      hasCoverage: true,
    });
    assert.ok((result.score ?? 0) > 0 && (result.score ?? 0) < 25, `got ${result.score}`);
  });

  it("drops routes beyond the transit walk limit", () => {
    assert.equal(transitDecay(2000), 0);
    const result = calculateTransitScore({
      routes: [
        { routeId: "b", shortName: "12", longName: null, agency: null, mode: "bus", walkMeters: 2000, tripsPerDay: 100 },
      ],
      stopCount: 0,
      hasCoverage: true,
    });
    assert.equal(result.routeCount, 0);
  });

  it("maps GTFS route types, including extended ones", () => {
    assert.equal(gtfsRouteTypeToMode(1), "subway");
    assert.equal(gtfsRouteTypeToMode(3), "bus");
    assert.equal(gtfsRouteTypeToMode(715), "bus");
    assert.equal(gtfsRouteTypeToMode(99999), "unknown");
  });
});

describe("transit source merge", () => {
  const gtfsRoute = {
    routeId: "feed1:R",
    shortName: "R",
    longName: "Broadway Local",
    agency: "MTA",
    mode: "subway" as const,
    walkMeters: 300,
    tripsPerDay: 900,
  };

  it("collapses the same route published in several agency feeds", () => {
    const merged = mergeTransitSources(
      {
        routes: [gtfsRoute, { ...gtfsRoute, routeId: "feed2:R", walkMeters: 240, tripsPerDay: 1304 }],
        stopCount: 10,
        hasCoverage: true,
      },
      { routes: [], stopCount: 0, hasCoverage: true }
    );
    assert.equal(merged.routes.length, 1);
    // Each feed only knows its own stops, so both figures are lower bounds.
    assert.equal(merged.routes[0].walkMeters, 240);
    assert.equal(merged.routes[0].tripsPerDay, 1304);
  });

  it("keeps OSM routes that GTFS does not cover", () => {
    const merged = mergeTransitSources(
      { routes: [gtfsRoute], stopCount: 5, hasCoverage: true },
      {
        routes: [
          { routeId: "osm:1", shortName: "Q", longName: null, agency: null, mode: "subway", walkMeters: 250, tripsPerDay: null },
        ],
        stopCount: 8,
        hasCoverage: true,
      }
    );
    assert.equal(merged.routes.length, 2);
    assert.equal(merged.stopCount, 8);
  });

  it("does not let OSM overwrite a GTFS route's real frequency", () => {
    const merged = mergeTransitSources(
      { routes: [gtfsRoute], stopCount: 5, hasCoverage: true },
      {
        routes: [{ ...gtfsRoute, routeId: "osm:9", tripsPerDay: null, agency: null }],
        stopCount: 5,
        hasCoverage: true,
      }
    );
    assert.equal(merged.routes.length, 1);
    assert.equal(merged.routes[0].tripsPerDay, 900);
  });

  it("falls back to OSM when no feed covers the point", () => {
    const osm = {
      routes: [
        { routeId: "osm:1", shortName: "5", longName: null, agency: null, mode: "bus" as const, walkMeters: 300, tripsPerDay: null },
      ],
      stopCount: 3,
      hasCoverage: true,
    };
    assert.equal(mergeTransitSources(null, osm).routes.length, 1);
  });
});

describe("bike score", () => {
  const flatHills = { meanGradePct: 0.5, steepGradePct: 0.8, reliefMeters: 4 };
  const noInfra = { protectedLaneMeters: 0, paintedLaneMeters: 0, lowStressMeters: 0, totalWayMeters: 0 };

  it("scores flat terrain at the top and steep terrain at the bottom", () => {
    assert.equal(hillScore(flatHills), 100);
    assert.equal(hillScore({ meanGradePct: 9, steepGradePct: 12, reliefMeters: 200 }), 0);
  });

  it("judges terrain on the steep tail rather than the average", () => {
    // A mostly flat area with one hard climb should not read as gently rolling.
    const spiky = hillScore({ meanGradePct: 1, steepGradePct: 7, reliefMeters: 90 });
    const even = hillScore({ meanGradePct: 1, steepGradePct: 1, reliefMeters: 10 });
    assert.ok((spiky ?? 100) < (even ?? 0));
  });

  it("returns null for terrain when elevation was unavailable", () => {
    assert.equal(hillScore({ meanGradePct: null, steepGradePct: null, reliefMeters: null }), null);
  });

  it("returns null infrastructure when there is no network at all", () => {
    assert.equal(infrastructureScore(noInfra), null);
  });

  it("rewards protected lanes more than painted ones", () => {
    const withProtected = infrastructureScore({
      protectedLaneMeters: 3000, paintedLaneMeters: 0, lowStressMeters: 0, totalWayMeters: 20000,
    });
    const withPainted = infrastructureScore({
      protectedLaneMeters: 0, paintedLaneMeters: 3000, lowStressMeters: 0, totalWayMeters: 20000,
    });
    assert.ok((withProtected ?? 0) > (withPainted ?? 0));
  });

  it("re-normalises over the components it could measure", () => {
    // With elevation missing the score must still be produced from the other three,
    // rather than treating unknown terrain as flat or as a zero.
    const withHills = calculateBikeScore({
      infrastructure: { protectedLaneMeters: 3000, paintedLaneMeters: 2000, lowStressMeters: 5000, totalWayMeters: 20000 },
      hills: flatHills,
      destinationRatio: 0.6,
      intersectionDensity: 50,
    });
    const withoutHills = calculateBikeScore({
      infrastructure: { protectedLaneMeters: 3000, paintedLaneMeters: 2000, lowStressMeters: 5000, totalWayMeters: 20000 },
      hills: { meanGradePct: null, steepGradePct: null, reliefMeters: null },
      destinationRatio: 0.6,
      intersectionDensity: 50,
    });
    assert.notEqual(withoutHills.score, null);
    assert.equal(withoutHills.components.hills, null);
    assert.ok((withoutHills.score ?? 0) < (withHills.score ?? 0), "flat terrain should have helped");
  });

  it("returns null when nothing at all could be measured", () => {
    const result = calculateBikeScore({
      infrastructure: noInfra,
      hills: { meanGradePct: null, steepGradePct: null, reliefMeters: null },
      destinationRatio: 0,
      intersectionDensity: null,
    });
    // Destinations is always measurable, so a zero ratio still yields a score of 0.
    assert.equal(result.score, 0);
  });
});

describe("OSM tag classification", () => {
  it("classifies a supermarket as full-strength grocery", () => {
    const rule = classify({ shop: "supermarket", name: "Key Food" });
    assert.equal(rule?.category, "grocery");
    assert.equal(rule?.quality, 1);
  });

  it("counts a convenience store as weaker grocery rather than dropping it", () => {
    // In rural areas the corner store genuinely is the grocery store.
    const rule = classify({ shop: "convenience" });
    assert.equal(rule?.category, "grocery");
    assert.ok((rule?.quality ?? 1) < 1);
  });

  it("takes the strongest match when a feature fits several rules", () => {
    const rule = classify({ shop: "bakery", amenity: "cafe" });
    assert.equal(rule?.category, "coffee");
  });

  it("skips features that are closed, disused or private", () => {
    assert.equal(classify({ shop: "supermarket", "disused:shop": "supermarket" }), null);
    assert.equal(classify({ amenity: "cafe", access: "private" }), null);
    assert.equal(classify({ leisure: "park", abandoned: "yes" }), null);
  });

  it("ignores tags it does not score", () => {
    assert.equal(classify({ highway: "residential" }), null);
    assert.equal(classify(undefined), null);
  });

  it("grades cycling comfort by infrastructure type", () => {
    assert.equal(bikeStress({ highway: "cycleway" }), "protected");
    assert.equal(bikeStress({ highway: "secondary", cycleway: "track" }), "protected");
    assert.equal(bikeStress({ highway: "secondary", cycleway: "lane" }), "painted");
    assert.equal(bikeStress({ highway: "residential" }), "lowStress");
    assert.equal(bikeStress({ highway: "primary" }), "highStress");
  });

  it("excludes service roads and footways from the street network", () => {
    // Counting parking aisles as streets is what makes a mall look like a city grid.
    assert.ok(isStreet("residential"));
    assert.ok(isStreet("primary"));
    assert.ok(!isStreet("service"));
    assert.ok(!isStreet("footway"));
    assert.ok(!isStreet(undefined));
  });
});

describe("street network", () => {
  /** A 3×3 lattice of streets with 100 m spacing, plus one service driveway. */
  function lattice(): OsmElement[] {
    const step = 0.0009; // ~100 m
    const ways: OsmElement[] = [];
    let id = 1;

    for (let row = 0; row < 3; row++) {
      ways.push({
        type: "way",
        id: id++,
        tags: { highway: "residential" },
        geometry: Array.from({ length: 3 }, (_, col) => ({ lat: row * step, lon: col * step })),
      });
    }
    for (let col = 0; col < 3; col++) {
      ways.push({
        type: "way",
        id: id++,
        tags: { highway: "residential" },
        geometry: Array.from({ length: 3 }, (_, row) => ({ lat: row * step, lon: col * step })),
      });
    }
    // A driveway hanging off the middle of the grid; it must not create an intersection.
    ways.push({
      type: "way",
      id: id++,
      tags: { highway: "service" },
      geometry: [
        { lat: step, lon: step },
        { lat: step, lon: step + step / 2 },
      ],
    });
    return ways;
  }

  it("shares nodes between crossing ways", () => {
    const graph = buildGraph(lattice());
    // 9 lattice points plus the driveway's free end.
    assert.equal(graph.nodes.length, 10);
  });

  it("counts only street junctions as intersections", () => {
    const graph = buildGraph(lattice());
    const shape = networkShape(graph, 0.0009, 0.0009, 500);
    // The centre node has street degree 4; the four edge midpoints have degree 3.
    assert.equal(shape.intersectionCount, 5);
  });

  it("measures block length between intersections", () => {
    const graph = buildGraph(lattice());
    const shape = networkShape(graph, 0.0009, 0.0009, 500);
    assert.ok(shape.avgBlockLengthMeters !== null);

    // Four 100 m runs between adjacent junctions, and four 200 m runs that turn a corner
    // at a lattice corner (degree 2, so not a junction) before reaching the next one.
    assert.ok(
      Math.abs((shape.avgBlockLengthMeters as number) - 150) < 25,
      `got ${shape.avgBlockLengthMeters} m`
    );
  });

  it("routes around the grid rather than through it", () => {
    const graph = buildGraph(lattice());
    const snap = snapToNetwork(graph, 0, 0);
    assert.ok(snap);
    const distances = dijkstra(graph, (snap as NonNullable<typeof snap>).seeds, 5000);

    // The far corner of a 200 m × 200 m lattice is 400 m away along the streets, even
    // though the straight line is only ~283 m. Routing rather than measuring crow-flies
    // is the whole reason a walkable grid scores differently from a cul-de-sac.
    const corner = graph.nodes.findIndex((n) => n.lat > 0.0017 && n.lon > 0.0017);
    assert.ok(corner >= 0);
    assert.ok(distances[corner] > 380 && distances[corner] < 420, `got ${distances[corner]}`);

    const crow = haversineMeters(0, 0, graph.nodes[corner].lat, graph.nodes[corner].lon);
    assert.ok(distances[corner] > crow, "network distance must exceed the straight line");
  });

  it("copes with an empty network", () => {
    const graph = buildGraph([]);
    assert.equal(snapToNetwork(graph, 0, 0), null);
    assert.equal(networkShape(graph, 0, 0, 500).avgBlockLengthMeters, null);
  });
});

describe("embed address extraction", () => {
  it("prefers JSON-LD postal addresses", () => {
    const result = extractAddress({
      jsonLd: [
        JSON.stringify({
          "@type": "SingleFamilyResidence",
          address: {
            "@type": "PostalAddress",
            streetAddress: "1500 N 23rd St",
            addressLocality: "Fort Pierce",
            addressRegion: "FL",
            postalCode: "34950",
          },
        }),
      ],
    });
    assert.equal(result?.source, "json-ld");
    assert.ok(result?.address.includes("1500 N 23rd St"));
  });

  it("recovers an address from a listing URL slug", () => {
    const result = extractAddress({
      pageUrl: "https://example.com/homes/1500-n-23rd-st-fort-pierce-fl-34950",
    });
    assert.equal(result?.source, "url-slug");
    assert.ok(/1500 n 23rd st/i.test(result?.address ?? ""));
  });

  it("reads an address out of the page title", () => {
    const result = extractAddress({ pageTitle: "742 Evergreen Terrace, Springfield, OR 97477 | For Sale" });
    assert.ok(result?.address.startsWith("742 Evergreen Terrace"));
  });

  it("survives malformed JSON-LD", () => {
    const result = extractAddress({
      jsonLd: ["{not json"],
      pageTitle: "1500 N 23rd St, Fort Pierce, FL",
    });
    assert.equal(result?.source, "title");
  });

  it("returns nothing rather than guessing", () => {
    // A false positive shows a score for the wrong house, which is worse than showing none.
    assert.equal(extractAddress({ pageTitle: "Homes for sale in Florida" }), null);
    assert.equal(extractAddress({}), null);
  });
});
