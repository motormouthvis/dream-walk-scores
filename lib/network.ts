/**
 * Pedestrian street network: graph construction, routing, and shape metrics.
 *
 * Walking distance is not straight-line distance, and the gap between them is exactly
 * what separates a walkable grid from a subdivision where the shop you can see across the
 * fence is a twenty-minute walk away. We build a routable graph from OSM ways and run a
 * single Dijkstra pass from the query point, which gives true network distance to every
 * amenity for the cost of one shortest-path computation.
 *
 * The same graph yields intersection density and mean block length, the two inputs to the
 * pedestrian-friendliness penalty.
 */

import { haversineMeters, pointToSegmentMeters } from "@/lib/geo";
import type { OsmElement } from "@/lib/osm/overpass";
import { bikeStress, isStreet, type BikeStress } from "@/lib/osm/tags";

export interface GraphNode {
  lat: number;
  lon: number;
  /** Indices into `Graph.edges`. */
  edges: number[];
}

export interface GraphEdge {
  a: number;
  b: number;
  meters: number;
  stress: BikeStress;
  highway: string;
  /** True for real streets; false for service roads, driveways, footways and paths. */
  street: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Coordinates are stored by OSM at 1e-7 degrees, so exact string keys dedupe shared nodes. */
function nodeKey(lat: number, lon: number): string {
  return `${lat.toFixed(7)},${lon.toFixed(7)}`;
}

export function buildGraph(elements: OsmElement[]): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const index = new Map<string, number>();

  const nodeId = (lat: number, lon: number): number => {
    const key = nodeKey(lat, lon);
    const existing = index.get(key);
    if (existing !== undefined) return existing;
    const id = nodes.length;
    nodes.push({ lat, lon, edges: [] });
    index.set(key, id);
    return id;
  };

  for (const el of elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const highway = el.tags?.["highway"] ?? "unknown";
    const stress = bikeStress(el.tags);
    const street = isStreet(highway);

    for (let i = 1; i < el.geometry.length; i++) {
      const p = el.geometry[i - 1];
      const q = el.geometry[i];
      const meters = haversineMeters(p.lat, p.lon, q.lat, q.lon);
      // Zero-length segments appear in real OSM data and would create self-loops.
      if (meters <= 0) continue;

      const a = nodeId(p.lat, p.lon);
      const b = nodeId(q.lat, q.lon);
      if (a === b) continue;

      const edgeId = edges.length;
      edges.push({ a, b, meters, stress, highway, street });
      nodes[a].edges.push(edgeId);
      nodes[b].edges.push(edgeId);
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Priority queue
// ---------------------------------------------------------------------------

/** Binary min-heap keyed by distance. Plain array of (dist, node) pairs kept flat. */
class MinHeap {
  private dist: number[] = [];
  private node: number[] = [];

  get size(): number {
    return this.dist.length;
  }

  push(d: number, n: number): void {
    this.dist.push(d);
    this.node.push(n);
    let i = this.dist.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.dist[parent] <= this.dist[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { d: number; n: number } | null {
    if (this.dist.length === 0) return null;
    const d = this.dist[0];
    const n = this.node[0];
    const lastD = this.dist.pop() as number;
    const lastN = this.node.pop() as number;

    if (this.dist.length > 0) {
      this.dist[0] = lastD;
      this.node[0] = lastN;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.dist.length && this.dist[l] < this.dist[smallest]) smallest = l;
        if (r < this.dist.length && this.dist[r] < this.dist[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return { d, n };
  }

  private swap(i: number, j: number): void {
    [this.dist[i], this.dist[j]] = [this.dist[j], this.dist[i]];
    [this.node[i], this.node[j]] = [this.node[j], this.node[i]];
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface SnapResult {
  /** Graph node indices to seed the search from, with their offset distances. */
  seeds: { node: number; meters: number }[];
  /** The point on the network closest to the query, which is what we actually score. */
  lat: number;
  lon: number;
  /** Distance from the query point to the network, metres. */
  offsetMeters: number;
}

/**
 * Snap a coordinate onto the network.
 *
 * We snap to the nearest *edge* rather than the nearest node, because a house in the
 * middle of a long block is metres from the street but potentially a hundred metres from
 * either intersection. Both endpoints of that edge seed the search with the correct
 * partial distances.
 */
export function snapToNetwork(graph: Graph, lat: number, lon: number): SnapResult | null {
  let bestEdge = -1;
  let bestMeters = Infinity;
  let bestLat = lat;
  let bestLon = lon;

  for (let i = 0; i < graph.edges.length; i++) {
    const e = graph.edges[i];
    const a = graph.nodes[e.a];
    const b = graph.nodes[e.b];
    const hit = pointToSegmentMeters(lat, lon, a.lat, a.lon, b.lat, b.lon);
    if (hit.meters < bestMeters) {
      bestMeters = hit.meters;
      bestEdge = i;
      bestLat = hit.lat;
      bestLon = hit.lon;
    }
  }

  if (bestEdge === -1) return null;

  const e = graph.edges[bestEdge];
  const a = graph.nodes[e.a];
  const b = graph.nodes[e.b];

  return {
    seeds: [
      { node: e.a, meters: haversineMeters(bestLat, bestLon, a.lat, a.lon) },
      { node: e.b, meters: haversineMeters(bestLat, bestLon, b.lat, b.lon) },
    ],
    lat: bestLat,
    lon: bestLon,
    offsetMeters: bestMeters,
  };
}

/**
 * Shortest network distance from the seeds to every reachable node within `maxMeters`.
 *
 * Returns a Float64Array of distances indexed by node, with `Infinity` for unreachable
 * nodes. Bounding the search keeps this fast: at 1.5 miles a dense urban graph settles in
 * a few milliseconds.
 */
export function dijkstra(graph: Graph, seeds: { node: number; meters: number }[], maxMeters: number): Float64Array {
  const dist = new Float64Array(graph.nodes.length).fill(Infinity);
  const heap = new MinHeap();

  for (const seed of seeds) {
    if (seed.meters < dist[seed.node]) {
      dist[seed.node] = seed.meters;
      heap.push(seed.meters, seed.node);
    }
  }

  while (heap.size > 0) {
    const top = heap.pop();
    if (!top) break;
    const { d, n } = top;
    // Stale heap entry from a since-improved node.
    if (d > dist[n]) continue;
    if (d > maxMeters) continue;

    for (const edgeId of graph.nodes[n].edges) {
      const e = graph.edges[edgeId];
      const other = e.a === n ? e.b : e.a;
      const nd = d + e.meters;
      if (nd < dist[other] && nd <= maxMeters) {
        dist[other] = nd;
        heap.push(nd, other);
      }
    }
  }

  return dist;
}

/**
 * Spatial index over graph nodes so that snapping thousands of amenities to the network
 * does not become O(amenities × nodes).
 */
export class NodeIndex {
  private buckets = new Map<string, number[]>();
  private readonly cellDeg: number;

  constructor(
    private graph: Graph,
    cellMeters = 100
  ) {
    this.cellDeg = cellMeters / 111_320;
    for (let i = 0; i < graph.nodes.length; i++) {
      const n = graph.nodes[i];
      const key = this.key(n.lat, n.lon);
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(i);
      else this.buckets.set(key, [i]);
    }
  }

  private key(lat: number, lon: number): string {
    return `${Math.floor(lat / this.cellDeg)}:${Math.floor(lon / this.cellDeg)}`;
  }

  /** Nearest graph node to a point, searching outward in rings until one is found. */
  nearest(lat: number, lon: number, maxRings = 6): { node: number; meters: number } | null {
    const baseLat = Math.floor(lat / this.cellDeg);
    const baseLon = Math.floor(lon / this.cellDeg);

    let best = -1;
    let bestMeters = Infinity;

    for (let ring = 0; ring <= maxRings; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          // Only walk the perimeter of each ring; the interior was covered already.
          if (ring > 0 && Math.abs(dy) !== ring && Math.abs(dx) !== ring) continue;
          const bucket = this.buckets.get(`${baseLat + dy}:${baseLon + dx}`);
          if (!bucket) continue;
          for (const i of bucket) {
            const n = this.graph.nodes[i];
            const m = haversineMeters(lat, lon, n.lat, n.lon);
            if (m < bestMeters) {
              bestMeters = m;
              best = i;
            }
          }
        }
      }
      // One full empty ring past a hit means nothing closer can exist.
      if (best !== -1 && ring > 0) break;
    }

    return best === -1 ? null : { node: best, meters: bestMeters };
  }
}

// ---------------------------------------------------------------------------
// Network shape metrics
// ---------------------------------------------------------------------------

export interface NetworkShape {
  intersectionDensity: number | null;
  avgBlockLengthMeters: number | null;
  intersectionCount: number;
  /** Total walkable way length within the radius, metres. */
  wayMeters: number;
}

/**
 * Intersection density and mean block length within `radiusMeters` of a point.
 *
 * Measured over the *street* subgraph only. Parking aisles, driveways, alleys and park
 * footpaths are all real ways that a pedestrian can walk on — and they stay in the
 * routing graph for exactly that reason — but counting their junctions as intersections
 * makes a shopping-mall parking lot look like a dense urban grid and inverts every
 * connectivity metric derived from it.
 *
 * An "intersection" is a node where three or more streets meet: a T junction counts, a
 * bend in the road does not. A "block" is the run of street between two consecutive
 * intersections, recovered by walking the degree-2 chains between them.
 */
export function networkShape(graph: Graph, lat: number, lon: number, radiusMeters: number): NetworkShape {
  const withinRadius = (i: number): boolean =>
    haversineMeters(lat, lon, graph.nodes[i].lat, graph.nodes[i].lon) <= radiusMeters;

  // Street-only adjacency, built once and reused by both metrics below.
  const streetDegree = new Uint16Array(graph.nodes.length);
  const streetEdges: number[][] = Array.from({ length: graph.nodes.length }, () => []);

  for (let i = 0; i < graph.edges.length; i++) {
    const e = graph.edges[i];
    if (!e.street) continue;
    streetDegree[e.a] += 1;
    streetDegree[e.b] += 1;
    streetEdges[e.a].push(i);
    streetEdges[e.b].push(i);
  }

  let intersectionCount = 0;
  const isIntersection = new Uint8Array(graph.nodes.length);

  for (let i = 0; i < graph.nodes.length; i++) {
    if (streetDegree[i] >= 3) {
      isIntersection[i] = 1;
      if (withinRadius(i)) intersectionCount += 1;
    }
  }

  // Total walkable length keeps every way, since it describes what a pedestrian can use.
  let wayMeters = 0;
  for (const e of graph.edges) {
    if (withinRadius(e.a) || withinRadius(e.b)) wayMeters += e.meters;
  }

  const areaSqKm = (Math.PI * radiusMeters * radiusMeters) / 1_000_000;
  const intersectionDensity = areaSqKm > 0 ? intersectionCount / areaSqKm : null;

  const blockLengths: number[] = [];
  const visitedEdge = new Uint8Array(graph.edges.length);

  for (let start = 0; start < graph.nodes.length; start++) {
    if (!isIntersection[start] || !withinRadius(start)) continue;

    for (const firstEdge of streetEdges[start]) {
      if (visitedEdge[firstEdge]) continue;

      let edgeId = firstEdge;
      let current = start;
      let length = 0;
      let guard = 0;

      for (;;) {
        if (visitedEdge[edgeId]) break;
        visitedEdge[edgeId] = 1;

        const e = graph.edges[edgeId];
        length += e.meters;
        const next = e.a === current ? e.b : e.a;

        // Reached another intersection, a dead end, or ran too far — the block ends.
        if (isIntersection[next] || streetDegree[next] !== 2) break;
        if (++guard > 500) break;

        const continuation = streetEdges[next].find((id) => id !== edgeId);
        if (continuation === undefined) break;
        edgeId = continuation;
        current = next;
      }

      if (length > 0) blockLengths.push(length);
    }
  }

  const avgBlockLengthMeters =
    blockLengths.length > 0 ? blockLengths.reduce((a, b) => a + b, 0) / blockLengths.length : null;

  return {
    intersectionDensity,
    avgBlockLengthMeters,
    intersectionCount,
    wayMeters,
  };
}
