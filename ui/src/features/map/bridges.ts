import type { GraphRel } from "../../ipc/generated/GraphRel";
import { type MapEdge, type MapModel, nodeOf } from "./model";

/** An edge drawn in place of a path through hidden kinds (spec H63). */
export interface BridgeEdge {
  from: string;
  to: string;
  rel: GraphRel;
  /** The hidden kinds passed, in walk order, unique. */
  via: string[];
}

const TRAFFIC: ReadonlySet<GraphRel> = new Set(["routes", "selects"]);
const USES: ReadonlySet<GraphRel> = new Set([
  "mounts",
  "env",
  "runsAs",
  "claims",
  "class",
]);

interface Lifted {
  owner: string;
  via: string[];
}

interface Exit {
  to: string;
  rel: GraphRel;
  via: string[];
}

const unique = (list: readonly string[]) => [...new Set(list)];

/**
 * The bridges of the view: ownership lifted to the nearest shown owner, traffic carried
 * through hidden nodes, and use edges of hidden nodes passed to their shown owner. Nodes
 * outside `viewIds` take no part. Every walk is iterative and stops at a node it has
 * already met, so owner cycles and long chains end.
 */
export function bridgeEdges(
  model: MapModel,
  viewIds: readonly string[],
  shown: ReadonlySet<string>,
): BridgeEdge[] {
  const view = new Set(viewIds);
  const isHidden = (id: string) => view.has(id) && !shown.has(id);
  if (!viewIds.some((id) => !shown.has(id))) return [];
  const kind = (id: string) => nodeOf(model, id).kind;

  /** The first `owns` edge into `id` from the view. */
  const ownerOf = (id: string): string | null =>
    (model.incoming.get(id) ?? []).find(
      (e) => e.rel === "owns" && view.has(e.from),
    )?.from ?? null;

  // The nearest shown owner of a hidden node, and the hidden kinds on the way.
  const lifted = new Map<string, Lifted | null>();
  const lift = (start: string): Lifted | null => {
    const known = lifted.get(start);
    if (known !== undefined) return known;
    const chain: string[] = [];
    const onChain = new Set<string>();
    let end: Lifted | null = null;
    for (let id: string | null = start; id !== null; ) {
      chain.push(id);
      onChain.add(id);
      const owner = ownerOf(id);
      if (owner === null || onChain.has(owner)) break;
      if (shown.has(owner)) {
        end = { owner, via: [] };
        break;
      }
      const memo = lifted.get(owner);
      if (memo !== undefined) {
        end = memo;
        break;
      }
      id = owner;
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      end = end
        ? { owner: end.owner, via: unique([kind(chain[i]), ...end.via]) }
        : null;
      lifted.set(chain[i], end);
    }
    return lifted.get(start) ?? null;
  };

  const hops = (id: string) =>
    (model.outgoing.get(id) ?? []).filter(
      (e) => TRAFFIC.has(e.rel) && view.has(e.to),
    );

  // Where traffic into a hidden node comes out, found depth first with an explicit stack.
  const exits = new Map<string, Exit[]>();
  const exitsOf = (start: string): Exit[] => {
    const done = exits.get(start);
    if (done) return done;
    const onStack = new Set<string>([start]);
    const stack = [{ id: start, edges: hops(start), next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.next < frame.edges.length) {
        const to = frame.edges[frame.next].to;
        frame.next += 1;
        if (isHidden(to) && !exits.has(to) && !onStack.has(to)) {
          onStack.add(to);
          stack.push({ id: to, edges: hops(to), next: 0 });
        }
        continue;
      }
      stack.pop();
      onStack.delete(frame.id);
      exits.set(frame.id, exitsFrom(frame.id, frame.edges));
    }
    return exits.get(start) ?? [];
  };
  const exitsFrom = (id: string, out: MapEdge[]): Exit[] => {
    if (out.length === 0) {
      const up = lift(id);
      return up ? [{ to: up.owner, rel: "selects", via: up.via }] : [];
    }
    const found = new Map<string, Exit>();
    const add = (exit: Exit) => {
      const key = `${exit.to}|${exit.rel}`;
      const had = found.get(key);
      if (had) had.via = unique([...had.via, ...exit.via]);
      else found.set(key, exit);
    };
    for (const e of out) {
      if (shown.has(e.to)) {
        add({ to: e.to, rel: e.rel, via: [kind(id)] });
        continue;
      }
      // A node still on the stack is part of a cycle and gives nothing here.
      for (const next of exits.get(e.to) ?? []) {
        add({
          to: next.to,
          rel: next.rel,
          via: unique([kind(id), ...next.via]),
        });
      }
    }
    return [...found.values()];
  };

  const raw: BridgeEdge[] = [];
  for (const id of viewIds) {
    if (!shown.has(id)) continue;
    const owner = ownerOf(id);
    if (owner === null || !isHidden(owner)) continue;
    const up = lift(owner);
    if (up) raw.push({ from: up.owner, to: id, rel: "owns", via: up.via });
  }
  for (const e of model.edges) {
    if (TRAFFIC.has(e.rel) && shown.has(e.from) && isHidden(e.to)) {
      for (const exit of exitsOf(e.to)) {
        raw.push({ from: e.from, to: exit.to, rel: exit.rel, via: exit.via });
      }
    } else if (USES.has(e.rel) && isHidden(e.from) && shown.has(e.to)) {
      const up = lift(e.from);
      if (up) raw.push({ from: up.owner, to: e.to, rel: e.rel, via: up.via });
    }
  }

  const real = new Set(model.edges.map((e) => `${e.from}|${e.to}`));
  const merged = new Map<string, BridgeEdge>();
  for (const b of raw) {
    if (b.from === b.to) continue;
    if (real.has(`${b.from}|${b.to}`) || real.has(`${b.to}|${b.from}`))
      continue;
    const key = `${b.from}|${b.to}`;
    const had = merged.get(key);
    if (had) had.via = unique([...had.via, ...b.via]);
    else merged.set(key, { ...b, via: [...b.via] });
  }
  return [...merged.values()];
}
