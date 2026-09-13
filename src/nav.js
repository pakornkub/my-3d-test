// nav.js -- floor navigation for the office.
//
// export/obstacles.json already lists 58 axis-aligned boxes in three.js space, so there is
// no need for a navmesh: bake a coarse XZ occupancy grid once, A* across it, then pull the
// path straight again so the character walks a diagonal instead of a staircase.

const SQRT2 = Math.SQRT2;

export class NavGrid {
  /**
   * @param bounds {minX, maxX, minZ, maxZ}
   * @param cell   metres per cell
   * @param isBlocked (x, z) => truthy when a character standing there would clip something
   */
  constructor(bounds, cell, isBlocked) {
    this.b = bounds;
    this.cell = cell;
    this.cols = Math.ceil((bounds.maxX - bounds.minX) / cell);
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
    this.blocked = new Uint8Array(this.cols * this.rows);
    this.isBlocked = isBlocked;
    this.bake();
  }

  bake() {
    let n = 0;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const { x, z } = this.centre(c, r);
        if (this.isBlocked(x, z)) { this.blocked[r * this.cols + c] = 1; n++; }
      }
    }
    this.blockedCount = n;
    return this;
  }

  centre(c, r) {
    return { x: this.b.minX + (c + 0.5) * this.cell, z: this.b.minZ + (r + 0.5) * this.cell };
  }

  cellAt(x, z) {
    return {
      c: Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.b.minX) / this.cell))),
      r: Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.b.minZ) / this.cell))),
    };
  }

  free(c, r) {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows && !this.blocked[r * this.cols + c];
  }

  /** Nearest free cell to (c, r), searched in rings. Used when a goal lands inside furniture. */
  nearestFree(c, r, maxRings = 6) {
    if (this.free(c, r)) return { c, r };
    for (let k = 1; k <= maxRings; k++) {
      for (let dr = -k; dr <= k; dr++) {
        for (let dc = -k; dc <= k; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== k) continue;
          if (this.free(c + dc, r + dr)) return { c: c + dc, r: r + dr };
        }
      }
    }
    return null;
  }

  /** Bresenham-ish walk; true when every cell on the segment is free. */
  lineOfSight(a, b) {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (this.cell * 0.5));
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const { c, r } = this.cellAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (!this.free(c, r)) return false;
    }
    return true;
  }

  /**
   * @returns array of {x, z} waypoints from `from` to `to` (inclusive of `to`), or null.
   * The final waypoint is always the exact goal even when its cell is blocked -- several
   * chair approach spots sit closer to a desk than the inflation radius allows.
   */
  findPath(from, to) {
    const sRaw = this.cellAt(from.x, from.z);
    const gRaw = this.cellAt(to.x, to.z);
    const s = this.nearestFree(sRaw.c, sRaw.r);
    const g = this.nearestFree(gRaw.c, gRaw.r);
    if (!s || !g) return null;
    if (s.c === g.c && s.r === g.r) return [{ x: to.x, z: to.z }];

    const N = this.cols * this.rows;
    const startI = s.r * this.cols + s.c;
    const goalI = g.r * this.cols + g.c;
    const gScore = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const open = [startI];
    const fScore = new Float32Array(N).fill(Infinity);
    const inOpen = new Uint8Array(N);
    const closed = new Uint8Array(N);

    const h = (i) => {
      const c = i % this.cols, r = (i / this.cols) | 0;
      const dc = Math.abs(c - g.c), dr = Math.abs(r - g.r);
      return (dc + dr) + (SQRT2 - 2) * Math.min(dc, dr);   // octile
    };
    gScore[startI] = 0;
    fScore[startI] = h(startI);
    inOpen[startI] = 1;

    while (open.length) {
      let best = 0;
      for (let i = 1; i < open.length; i++) if (fScore[open[i]] < fScore[open[best]]) best = i;
      const cur = open.splice(best, 1)[0];
      inOpen[cur] = 0;
      if (cur === goalI) return this.#rebuild(came, cur, from, to);
      closed[cur] = 1;

      const c = cur % this.cols, r = (cur / this.cols) | 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dc && !dr) continue;
          const nc = c + dc, nr = r + dr;
          if (!this.free(nc, nr)) continue;
          // no cutting a diagonal through a blocked corner
          if (dc && dr && (!this.free(c + dc, r) || !this.free(c, r + dr))) continue;
          const ni = nr * this.cols + nc;
          if (closed[ni]) continue;
          const tentative = gScore[cur] + (dc && dr ? SQRT2 : 1);
          if (tentative < gScore[ni]) {
            came[ni] = cur;
            gScore[ni] = tentative;
            fScore[ni] = tentative + h(ni);
            if (!inOpen[ni]) { open.push(ni); inOpen[ni] = 1; }
          }
        }
      }
    }
    return null;
  }

  #rebuild(came, cur, from, to) {
    const cells = [];
    for (let i = cur; i !== -1; i = came[i]) cells.push(i);
    cells.reverse();
    const pts = cells.map((i) => this.centre(i % this.cols, (i / this.cols) | 0));
    pts.unshift({ x: from.x, z: from.z });
    pts.push({ x: to.x, z: to.z });
    return this.smooth(pts);
  }

  /**
   * String-pulling: from each kept point, jump as far ahead as line of sight allows.
   * The very last point is the caller's exact goal, which may legitimately sit in a
   * blocked cell (chair approach spots hug the desks), so it is never tested.
   */
  smooth(pts) {
    if (pts.length <= 2) return pts;
    const last = pts.length - 1;
    const out = [pts[0]];
    let i = 0;
    while (i < last) {
      let j = last - 1;
      while (j > i + 1 && !this.lineOfSight(pts[i], pts[j])) j--;
      if (j <= i) j = i + 1;
      out.push(pts[j]);
      i = j;
    }
    if (out[out.length - 1] !== pts[last]) out.push(pts[last]);
    return out;
  }

  /**
   * seats.json's `approach` points were generated as `seat - forward * 0.75`, which is right
   * for a free-standing chair and wrong for anything backed against a wall: four of the
   * sixteen land inside furniture (all three sofa cushions, and MC2 inside MC1 + the table).
   * Rather than trust the file, re-derive any unreachable one: scan free cells in a ring
   * around the seat and keep the one most squarely in front of or behind it.
   *
   * Mutates seat.three.approach and returns a table for logging.
   */
  repairApproaches(seats) {
    const rows = [];
    for (const [name, s] of seats) {
      const a = s.three.approach;
      if (!this.isBlocked(a[0], a[2])) { rows.push({ name, src: 'seats.json', x: a[0], z: a[2] }); continue; }
      const [sx, , sz] = s.three.seat;
      const f = s.three.forward ?? [0, 0, -1];
      let best = null;
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (!this.free(c, r)) continue;
          const { x, z } = this.centre(c, r);
          const dx = x - sx, dz = z - sz;
          const d = Math.hypot(dx, dz);
          if (d < 0.35 || d > 1.7) continue;
          const dot = (dx * -f[0] + dz * -f[2]) / d;   // +1 behind the seat, -1 in front
          if (Math.abs(dot) < 0.7) continue;           // never walk up to a chair sideways
          const cost = d - 0.8 * Math.abs(dot) - 0.25 * dot;
          if (!best || cost < best.cost) best = { cost, x, z };
        }
      }
      if (best) {
        s.three.approach = [best.x, 0, best.z];
        rows.push({ name, src: 'repaired', x: best.x, z: best.z });
      } else {
        rows.push({ name, src: 'FAILED', x: a[0], z: a[2] });
      }
    }
    return rows;
  }

  /** Debug helper: a flat mesh-friendly list of blocked cell centres. */
  blockedCells() {
    const out = [];
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        if (this.blocked[r * this.cols + c]) out.push(this.centre(c, r));
    return out;
  }
}
