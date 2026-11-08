(function (global) {
"use strict";
var DOOR_HEAD = 2.05;
var WIN_SILL = 0.90;
var WIN_HEAD = 2.10;
var FRAME_W = 0.05;         
var FRAME_PROUD = 0.012;    
var JUNCTION_TOL = 0.06;    
var CONF_WALL = 0.5;        
var CONF_TIERS = {proxy: 0.88, box: 0.31, ghost: 0.15};
var OPENING_TIERS = {cut: 0.31, ghost: 0.05};
var GHOST_OPENING_T = 0.012;
function openingTier(conf, tiers) {
  var t = tiers || OPENING_TIERS;
  if (conf == null) return "cut";
  var c = Number(conf);
  if (c >= t.cut) return "cut";
  if (c >= t.ghost) return "ghost";
  return "drop";
}
function furnitureTier(conf, tiers) {
  var t = tiers || CONF_TIERS;
  if (conf == null) return "proxy";            
  var c = Number(conf);
  if (c >= t.proxy) return "proxy";
  if (c >= t.box) return "box";
  if (c >= t.ghost) return "ghost";
  return "drop";
}
var TIER_ORDER = ["drop", "ghost", "box", "proxy"];
function objectTier(f, tiers) {
  var tier = furnitureTier(f.confidence, tiers);
  if (String(f.size_source || "") !== "prior") return tier;
  var i = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.min(Math.max(i, TIER_ORDER.indexOf("ghost")), TIER_ORDER.indexOf("box"))];
}
function snapTiersToCurve(tiers, calibration) {
  var ys = (calibration.y || []).map(Number).slice().sort(function (a, b) { return a - b; });
  var uniq = ys.filter(function (v, i) { return i === 0 || Math.abs(v - ys[i - 1]) > 1e-12; });
  var out = {}, notes = [];
  if (!uniq.length) return {tiers: tiers, notes: notes};
  Object.keys(tiers).forEach(function (k) {
    var v = tiers[k], below = uniq.filter(function (u) { return u <= v; });
    var snapped = below.length ? below[below.length - 1] : uniq[0];
    out[k] = snapped;
    if (Math.abs(snapped - v) > 1e-9)
      notes.push("tier '" + k + "' " + v.toFixed(3) + " -> " + snapped.toFixed(3) +
                 " (nearest level the curve produces)");
    if (snapped >= uniq[uniq.length - 1] - 1e-9)
      notes.push("tier '" + k + "' sits at the curve's ceiling " + snapped.toFixed(3) +
                 "; it cannot discriminate there");
  });
  return {tiers: out, notes: notes};
}
var END_BRIDGE = 0.60;      
var ON_WALL_TOL = 0.25;     
var GAP_LINE_TOL = 0.35;    
var GAP_COS_TOL = 0.94;     
var GAP_MAX_W = 2.60;       
var SEAL_TRY = [0.75, 1.5, 2.5];  
var OPEN_FRAC = 0.25;       
var SEAL_FRAC = 0.30;       
var DEFAULT_THICK = 0.10;
var DEFAULT_H = 2.50;
var FLOOR_T = 0.06;         
var PLATE_MARGIN = 0.15;    
var RASTER = 0.02;          
var GAP_CLOSE = 0.10;       
var MAX_CELLS = 1.6e6;      
var COL = {
  "floor":        [0.86, 0.82, 0.74],
  "wall":         [0.93, 0.92, 0.90],
  "wall-lintel":  [0.93, 0.92, 0.90],
  "wall-sill":    [0.93, 0.92, 0.90],
  "wall-header":  [0.93, 0.92, 0.90],
  "partition":    [0.85, 0.87, 0.90],
  "glass":        [0.62, 0.82, 0.92],
  "column":       [0.80, 0.80, 0.82],
  "unverified":   [0.95, 0.80, 0.60],
  "sloped":       [0.93, 0.92, 0.90],
  "door-frame":   [0.55, 0.36, 0.22],
  "door-leaf":    [0.72, 0.50, 0.32],
  "window-frame": [0.98, 0.98, 0.98],
  "window-pane":  [0.60, 0.85, 0.95],
  "furniture":    [0.36, 0.55, 0.80],
  "furniture-ghost": [0.60, 0.70, 0.85],
  "opening-ghost": [0.95, 0.62, 0.30],
  "proxy-table":  [0.62, 0.44, 0.28],
  "proxy-sofa":   [0.36, 0.45, 0.62],
  "proxy-chair":  [0.45, 0.42, 0.40],
  "proxy-bed":    [0.75, 0.72, 0.80],
  "proxy-tv":     [0.16, 0.17, 0.20]
};
var ALPHA = {"glass": 0.45, "window-pane": 0.35, "unverified": 0.55, "furniture-ghost": 0.4,
             "opening-ghost": 0.5};
function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function mul(a, k) { return [a[0] * k, a[1] * k]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
function len(a) { return Math.hypot(a[0], a[1]); }
function norm(a) { var l = len(a) || 1e-12; return [a[0] / l, a[1] / l]; }
function MeshAcc() { this.v = []; this.f = []; }
MeshAcc.prototype.addQuad = function (a, b, c, d) {   
  var n = this.v.length;
  this.v.push(a, b, c, d);
  this.f.push([n, n + 1, n + 2], [n, n + 2, n + 3]);
};
MeshAcc.prototype.addTri = function (a, b, c) {
  var n = this.v.length; this.v.push(a, b, c); this.f.push([n, n + 1, n + 2]);
};
MeshAcc.prototype.addPrism8 = function (p) {          
  this.addQuad(p[0], p[3], p[2], p[1]);               
  this.addQuad(p[4], p[5], p[6], p[7]);               
  this.addQuad(p[0], p[1], p[5], p[4]);
  this.addQuad(p[1], p[2], p[6], p[5]);
  this.addQuad(p[2], p[3], p[7], p[6]);
  this.addQuad(p[3], p[0], p[4], p[7]);
};
MeshAcc.prototype.addBoxXYZ = function (x0, x1, y0, y1, z0, z1) {
  this.addPrism8([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
                  [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
};
MeshAcc.prototype.empty = function () { return this.f.length === 0; };
function to3d(p, flipY) { return [p[0], p[2], flipY ? p[1] : -p[1]]; }
function partFromAcc(acc, pid, kind, src, opts) {
  opts = opts || {};
  var flipY = !!opts.flipY, i;
  var V = new Float32Array(acc.v.length * 3);
  for (i = 0; i < acc.v.length; i++) {
    var q = to3d(acc.v[i], flipY);
    V[i * 3] = q[0]; V[i * 3 + 1] = q[1]; V[i * 3 + 2] = q[2];
  }
  var F = new Uint32Array(acc.f.length * 3);
  for (i = 0; i < acc.f.length; i++) {
    F[i * 3] = acc.f[i][0]; F[i * 3 + 1] = acc.f[i][1]; F[i * 3 + 2] = acc.f[i][2];
  }
  var part = {
    id: pid, kind: kind, src: src,
    color: opts.color || COL[kind] || [0.7, 0.7, 0.7],
    alpha: opts.alpha != null ? opts.alpha : (ALPHA[kind] != null ? ALPHA[kind] : 1.0),
    V: V, F: F, tris: acc.f.length
  };
  if (opts.extra) for (var k in opts.extra) part[k] = opts.extra[k];
  return part;
}
function WallFrame(A, B, thick, hA, hB) {
  this.A = A.slice(); this.B = B.slice();
  var d = sub(B, A);
  this.L0 = len(d);
  this.u = mul(d, 1 / (this.L0 || 1e-12));
  this.n = [-this.u[1], this.u[0]];
  this.t = thick; this.hA = hA; this.hB = hB;
}
WallFrame.prototype.h = function (s) {
  if (this.L0 <= 0) return this.hA;
  return this.hA + (this.hB - this.hA) * (s / this.L0);
};
WallFrame.prototype.pt = function (s, t, z) {
  return [this.A[0] + this.u[0] * s + this.n[0] * t,
          this.A[1] + this.u[1] * s + this.n[1] * t, z];
};
WallFrame.prototype.box = function (acc, s0, s1, t0, t1, z0, z1a, z1b) {
  if (z1b == null) z1b = z1a;
  acc.addPrism8([this.pt(s0, t0, z0), this.pt(s1, t0, z0), this.pt(s1, t1, z0), this.pt(s0, t1, z0),
                 this.pt(s0, t0, z1a), this.pt(s1, t0, z1b), this.pt(s1, t1, z1b), this.pt(s0, t1, z1a)]);
};
function convexHull(pts) {
  var seen = {}, u = [];
  for (var i = 0; i < pts.length; i++) {
    var k = pts[i][0] + "," + pts[i][1];
    if (!seen[k]) { seen[k] = 1; u.push([pts[i][0], pts[i][1]]); }
  }
  u.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
  if (u.length <= 2) return u;
  function cross(o, a, b) { return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]); }
  var lo = [], j;
  for (j = 0; j < u.length; j++) {
    while (lo.length >= 2 && cross(lo[lo.length-2], lo[lo.length-1], u[j]) <= 0) lo.pop();
    lo.push(u[j]);
  }
  var up = [];
  for (j = u.length - 1; j >= 0; j--) {
    while (up.length >= 2 && cross(up[up.length-2], up[up.length-1], u[j]) <= 0) up.pop();
    up.push(u[j]);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function polyArea(poly) {
  var a = 0;
  for (var i = 0; i < poly.length; i++) {
    var p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
function offsetConvex(poly, d) {
  var n = poly.length, out = [];
  for (var i = 0; i < n; i++) {
    var p = poly[i], a = poly[(i - 1 + n) % n], b = poly[(i + 1) % n];
    var e0 = sub(p, a), e1 = sub(b, p);
    var n0 = norm([e0[1], -e0[0]]), n1 = norm([e1[1], -e1[0]]);
    var m = norm(add(n0, n1));
    var cosang = Math.max(0.3, dot(m, n0));
    out.push([p[0] + m[0] * d / cosang, p[1] + m[1] * d / cosang]);
  }
  return out;
}
function simplifyDP(poly, tol) {
  var pts = poly.slice();
  if (pts.length < 5) return pts;
  var far = 0, fd = -1;
  for (var i = 0; i < pts.length; i++) {
    var d = len(sub(pts[i], pts[0]));
    if (d > fd) { fd = d; far = i; }
  }
  function dp(seg) {
    if (seg.length < 3) return seg;
    var a = seg[0], b = seg[seg.length - 1], ab = sub(b, a), l = len(ab);
    var bi = 0, bd = -1;
    for (var k = 0; k < seg.length; k++) {
      var v = sub(seg[k], a);
      var dd = l < 1e-9 ? len(v) : Math.abs(ab[0] * v[1] - ab[1] * v[0]) / l;
      if (dd > bd) { bd = dd; bi = k; }
    }
    if (bd > tol) {
      var left = dp(seg.slice(0, bi + 1));
      return left.slice(0, -1).concat(dp(seg.slice(bi)));
    }
    return [seg[0], seg[seg.length - 1]];
  }
  var s1 = dp(pts.slice(0, far + 1));
  var s2 = dp(pts.slice(far).concat([pts[0]]));
  return s1.slice(0, -1).concat(s2.slice(0, -1));
}
function earClip(poly) {
  var n = poly.length;
  if (n < 3) return [];
  var idx = [];
  for (var i = 0; i < n; i++) idx.push(i);
  if (polyArea(poly) < 0) idx.reverse();
  function cross(o, a, b) { return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]); }
  function inside(p, a, b, c) {
    return cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12;
  }
  var tris = [], guard = 0;
  while (idx.length > 3 && guard < 10000) {
    guard++;
    var found = false;
    for (var k = 0; k < idx.length; k++) {
      var i0 = idx[(k - 1 + idx.length) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      var a = poly[i0], b = poly[i1], c = poly[i2];
      if (cross(a, b, c) <= 1e-12) continue;             
      var ok = true;
      for (var m = 0; m < idx.length; m++) {
        var j = idx[m];
        if (j === i0 || j === i1 || j === i2) continue;
        if (inside(poly[j], a, b, c)) { ok = false; break; }
      }
      if (ok) { tris.push([i0, i1, i2]); idx.splice(k, 1); found = true; break; }
    }
    if (!found) idx.shift();                             
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}
function segPointDist(P, A, B) {
  var d = sub(B, A), L2 = dot(d, d);
  if (L2 < 1e-12) return {d: len(sub(P, A)), s: 0};
  var s = Math.max(0, Math.min(1, dot(sub(P, A), d) / L2));
  return {d: len(sub(P, [A[0] + s * d[0], A[1] + s * d[1]])), s: s * Math.sqrt(L2)};
}
function edt2(mask, W, H) {
  var INF = 1e20, f = new Float64Array(Math.max(W, H));
  var d = new Float64Array(Math.max(W, H));
  var vv = new Int32Array(Math.max(W, H));
  var zz = new Float64Array(Math.max(W, H) + 1);
  var out = new Float64Array(W * H);
  var x, y, i;
  for (i = 0; i < W * H; i++) out[i] = mask[i] ? 0 : INF;
  function dt1(n) {                                      
    var k = 0; vv[0] = 0; zz[0] = -INF; zz[1] = INF;
    for (var q = 1; q < n; q++) {
      var s;
      while (true) {
        s = ((f[q] + q * q) - (f[vv[k]] + vv[k] * vv[k])) / (2 * q - 2 * vv[k]);
        if (s <= zz[k]) k--; else break;
      }
      k++; vv[k] = q; zz[k] = s; zz[k + 1] = INF;
    }
    k = 0;
    for (var q2 = 0; q2 < n; q2++) {
      while (zz[k + 1] < q2) k++;
      var dx = q2 - vv[k];
      d[q2] = dx * dx + f[vv[k]];
    }
  }
  for (y = 0; y < H; y++) {                              
    for (x = 0; x < W; x++) f[x] = out[y * W + x];
    dt1(W);
    for (x = 0; x < W; x++) out[y * W + x] = d[x];
  }
  for (x = 0; x < W; x++) {                              
    for (y = 0; y < H; y++) f[y] = out[y * W + x];
    dt1(H);
    for (y = 0; y < H; y++) out[y * W + x] = d[y];
  }
  return out;                                            
}
function notMask(m, W, H) {
  var o = new Uint8Array(W * H);
  for (var i = 0; i < W * H; i++) o[i] = m[i] ? 0 : 1;
  return o;
}
function diskDilate(mask, W, H, rMetres, raster) {
  if (rMetres <= 0) return mask.slice();
  var r2 = Math.pow(rMetres / (raster || RASTER), 2);
  var dd = edt2(mask, W, H), o = new Uint8Array(W * H);
  for (var i = 0; i < W * H; i++) o[i] = dd[i] <= r2 ? 1 : 0;
  return o;
}
function diskClose(mask, W, H, rMetres, raster) {
  var dil = diskDilate(mask, W, H, rMetres, raster);
  var ero = diskDilate(notMask(dil, W, H), W, H, rMetres, raster);
  return notMask(ero, W, H);
}
function floodInterior(mask, W, H) {
  var free = notMask(mask, W, H), seen = new Uint8Array(W * H), stack = [], i, x, y;
  for (x = 0; x < W; x++) { stack.push(x); stack.push((H - 1) * W + x); }
  for (y = 0; y < H; y++) { stack.push(y * W); stack.push(y * W + W - 1); }
  while (stack.length) {
    i = stack.pop();
    if (i < 0 || i >= W * H || seen[i] || !free[i]) continue;
    seen[i] = 1;
    x = i % W; y = (i - x) / W;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - W);
    if (y < H - 1) stack.push(i + W);
  }
  var out = new Uint8Array(W * H);
  for (i = 0; i < W * H; i++) out[i] = (free[i] && !seen[i]) ? 1 : 0;
  return out;
}
function fillHoles(mask, W, H) {
  var inter = floodInterior(mask, W, H), o = new Uint8Array(W * H);
  for (var i = 0; i < W * H; i++) o[i] = (mask[i] || inter[i]) ? 1 : 0;
  return o;
}
function largestComponent(mask, W, H) {
  var lab = new Int32Array(W * H), cur = 0, best = 0, bestN = 0, i, x, y;
  for (i = 0; i < W * H; i++) {
    if (!mask[i] || lab[i]) continue;
    cur++; var n = 0, stack = [i];
    while (stack.length) {
      var j = stack.pop();
      if (j < 0 || j >= W * H || lab[j] || !mask[j]) continue;
      lab[j] = cur; n++;
      x = j % W; y = (j - x) / W;
      if (x > 0) stack.push(j - 1);
      if (x < W - 1) stack.push(j + 1);
      if (y > 0) stack.push(j - W);
      if (y < H - 1) stack.push(j + W);
    }
    if (n > bestN) { bestN = n; best = cur; }
  }
  var o = new Uint8Array(W * H);
  for (i = 0; i < W * H; i++) o[i] = lab[i] === best ? 1 : 0;
  return o;
}
function countMask(m) { var c = 0; for (var i = 0; i < m.length; i++) if (m[i]) c++; return c; }
function classify(label) {
  var l = String(label).toLowerCase();
  var groups = [["table", ["table", "desk", "counter", "island"]],
                ["sofa",  ["sofa", "couch", "settee"]],
                ["chair", ["chair", "stool", "seat", "armchair"]],
                ["tv",    ["tv", "monitor", "television", "screen"]],
                ["bed",   ["bed"]]];
  for (var i = 0; i < groups.length; i++)
    for (var j = 0; j < groups[i][1].length; j++)
      if (l.indexOf(groups[i][1][j]) >= 0) return groups[i][0];
  return "box";
}
var PROXY = {
  table: function (box, sx, sy, sz, z0) {
    var topT = Math.min(0.05, sz * 0.15), leg = Math.min(0.06, sx * 0.1, sy * 0.1);
    box(-sx/2, sx/2, -sy/2, sy/2, z0 + sz - topT, z0 + sz);
    var ins = leg * 0.6, lxs = [-sx/2 + ins, sx/2 - ins - leg], lys = [-sy/2 + ins, sy/2 - ins - leg];
    for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++)
      box(lxs[a], lxs[a] + leg, lys[b], lys[b] + leg, z0, z0 + sz - topT);
  },
  sofa: function (box, sx, sy, sz, z0) {                 
    var arm = Math.min(0.18, sx * 0.12), backT = Math.min(0.20, sy * 0.3);
    var seatH = Math.min(0.42, sz * 0.5), baseH = seatH * 0.5;
    box(-sx/2, sx/2, -sy/2, sy/2, z0, z0 + baseH);
    box(-sx/2 + arm, sx/2 - arm, -sy/2 + backT, sy/2, z0 + baseH, z0 + seatH);
    box(-sx/2 + arm, sx/2 - arm, -sy/2, -sy/2 + backT, z0 + baseH, z0 + sz);
    var ah = z0 + seatH + (sz - seatH) * 0.45;
    box(-sx/2, -sx/2 + arm, -sy/2, sy/2, z0 + baseH, ah);
    box(sx/2 - arm, sx/2, -sy/2, sy/2, z0 + baseH, ah);
  },
  chair: function (box, sx, sy, sz, z0) {
    var seatH = Math.min(0.46, sz * 0.5), seatT = 0.04, leg = 0.035, backT = 0.04;
    box(-sx/2, sx/2, -sy/2, sy/2, z0 + seatH - seatT, z0 + seatH);
    box(-sx/2, sx/2, -sy/2, -sy/2 + backT, z0 + seatH, z0 + sz);
    var lxs = [-sx/2, sx/2 - leg], lys = [-sy/2, sy/2 - leg];
    for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++)
      box(lxs[a], lxs[a] + leg, lys[b], lys[b] + leg, z0, z0 + seatH - seatT);
  },
  tv: function (box, sx, sy, sz, z0) {          
    var bez = Math.min(0.03, sx * 0.04);
    box(-sx/2, sx/2, -sy/2, sy/2, z0 + bez, z0 + sz - bez);
    box(-sx/2, sx/2, -sy/2, -sy/2 + 0.012, z0, z0 + sz);
    box(-0.06, 0.06, -sy/2 - 0.03, -sy/2, z0 + sz * 0.35, z0 + sz * 0.65);
  },
  bed: function (box, sx, sy, sz, z0) {
    var frameH = Math.min(0.25, sz * 0.5), head = Math.min(0.08, sy * 0.05);
    box(-sx/2, sx/2, -sy/2, sy/2, z0, z0 + frameH);
    box(-sx/2 + 0.03, sx/2 - 0.03, -sy/2 + head + 0.03, sy/2 - 0.03, z0 + frameH, z0 + frameH + 0.18);
    box(-sx/2, sx/2, -sy/2, -sy/2 + head, z0, z0 + sz);
  }
};
var DEFAULT_CELL = 0.04;
function normaliseFrame(scene) {
  var frame = String(scene.frame || "editor").toLowerCase();
  var lo = scene.lo || [0, 0];
  var info = {frame: frame, cell: Number(scene.cell) || DEFAULT_CELL, offset: [0, 0]};
  if (frame !== "factory") {
    if (frame !== "editor") info.unknown_frame = true;
    return {scene: scene, info: info};
  }
  var ox = Number(lo[0]) || 0, oy = Number(lo[1]) || 0;
  info.offset = [ox, oy];
  if (ox === 0 && oy === 0) return {scene: scene, info: info};
  var out = {};
  for (var k in scene) out[k] = scene[k];
  out.corners = (scene.corners || []).map(function (c) {
    return [Number(c[0]) + ox, Number(c[1]) + oy];
  });
  out.openings = (scene.openings || []).map(function (o) {
    var q = {}; for (var k2 in o) q[k2] = o[k2];
    q.center = [Number(o.center[0]) + ox, Number(o.center[1]) + oy];
    return q;
  });
  out.furniture = (scene.furniture || []).map(function (f) {
    var q = {}; for (var k3 in f) q[k3] = f[k3];
    q.x = Number(f.x) + ox; q.y = Number(f.y) + oy;
    return q;
  });
  return {scene: out, info: info};
}
function Builder(scene, opts) {
  opts = opts || {};
  var nf = normaliseFrame(scene || {});
  this.scene = nf.scene;
  this.frameInfo = nf.info;
  this.flipY = !!opts.flipY;
  this.proxies = opts.proxies !== false;
  this.angRadians = opts.angRadians !== false;
  this.conf_tiers = {proxy: CONF_TIERS.proxy, box: CONF_TIERS.box, ghost: CONF_TIERS.ghost};
  this.opening_tiers = {cut: OPENING_TIERS.cut, ghost: OPENING_TIERS.ghost};
  var sot = this.scene.opening_tiers;
  if (sot && typeof sot === "object") {
    ["cut", "ghost"].forEach(function (k) {
      if (sot[k] != null) this.opening_tiers[k] = Number(sot[k]);
    }, this);
  }
  var tierNotes = [];
  var cal = opts.calibration || this.scene.calibration;
  if (cal) { var r = snapTiersToCurve(this.conf_tiers, cal); this.conf_tiers = r.tiers; tierNotes = r.notes; }
  this.parts = []; this.warnings = []; this.notes = tierNotes.slice(); this.stats = {};
  this.H = Number(this.scene.height) || DEFAULT_H;
  this.corners = (this.scene.corners || []).map(function (c) { return [Number(c[0]), Number(c[1])]; });
  this.walls = [];
  this.rasterSegs = [];
}
Builder.prototype.prepWalls = function () {
  var self = this, i, k;
  var cl = new Array(this.corners.length), reps = [];
  for (i = 0; i < this.corners.length; i++) {
    cl[i] = -1;
    for (k = 0; k < reps.length; k++) {
      if (Math.hypot(this.corners[i][0] - reps[k][0], this.corners[i][1] - reps[k][1]) < JUNCTION_TOL) {
        cl[i] = k; break;
      }
    }
    if (cl[i] < 0) { cl[i] = reps.length; reps.push(this.corners[i]); }
  }
  var deg = {}, raw = [], wallsIn = this.scene.walls || [];
  for (var wi = 0; wi < wallsIn.length; wi++) {
    var w = wallsIn[wi], a = w.a | 0, b = w.b | 0;
    if (a >= this.corners.length || b >= this.corners.length) {
      this.warnings.push("wall " + (w.name || wi) + " references missing corner"); continue;
    }
    var A = this.corners[a], B = this.corners[b];
    var L = Math.hypot(B[0] - A[0], B[1] - A[1]);
    var wtype = w.type || "full-wall";
    var thick = Number(w.thick_m) || DEFAULT_THICK;
    if (L < 0.02) {
      if (wtype === "column") raw.push({wi: wi, w: w, A: A, B: B, thick: thick, wtype: wtype, col: true});
      else this.warnings.push("wall " + (w.name || wi) + " (#" + wi + ") degenerate a==b, skipped");
      continue;
    }
    raw.push({wi: wi, w: w, A: A, B: B, thick: thick, wtype: wtype, col: false});
    deg[cl[a]] = (deg[cl[a]] || 0) + 1;
    deg[cl[b]] = (deg[cl[b]] || 0) + 1;
  }
  raw.forEach(function (r) {
    var w = r.w;
    var hA = Number(w.height_m) || self.H;
    var hasB = w.height_b_m != null && w.height_b_m !== "";
    var hB = hasB ? Number(w.height_b_m) : hA;
    if (r.wtype !== "sloped" && Math.abs(hB - hA) > 1e-6) {
      self.warnings.push("wall " + (w.name || r.wi) + " is type '" + r.wtype +
        "' but carries height_b_m " + hB.toFixed(2) + " against height_m " + hA.toFixed(2) +
        ". Type wins, so it is built flat at " + hA.toFixed(2) + " and the second height is " +
        "ignored. Set type 'sloped' if the gable was intended.");
    }
    if (r.wtype !== "sloped") hB = hA;
    if (r.col) {
      self.walls.push({i: r.wi, w: w, col: true, A: r.A, thick: r.thick, h: hA, type: r.wtype});
      return;
    }
    var a = w.a | 0, b = w.b | 0;
    var u = norm(sub(r.B, r.A));
    var ea = (deg[cl[a]] || 0) >= 2 ? r.thick / 2 : 0;
    var eb = (deg[cl[b]] || 0) >= 2 ? r.thick / 2 : 0;
    var A2 = sub(r.A, mul(u, ea)), B2 = add(r.B, mul(u, eb));
    var fr = new WallFrame(A2, B2, r.thick, hA, hB);
    self.walls.push({i: r.wi, w: w, col: false, fr: fr, ext: [ea, eb], openings: [],
                     type: r.wtype, A0: r.A.slice(), B0: r.B.slice(),
                     name: w.name || ("wall" + r.wi)});
    self.rasterSegs.push([A2, B2, r.thick / 2]);
    if (w.closure) self.stats.closure_walls = (self.stats.closure_walls || 0) + 1;
  });
};
Builder.prototype.wallByName = function (name) {
  if (name == null) return null;
  for (var i = 0; i < this.walls.length; i++)
    if (!this.walls[i].col && this.walls[i].name === name) return this.walls[i];
  return null;
};
Builder.prototype.assignOpenings = function () {
  this.freeOpenings = [];
  var ops = this.scene.openings || [];
  for (var oi = 0; oi < ops.length; oi++) {
    var o = ops[oi];
    var c = [Number(o.center[0]), Number(o.center[1])];
    var wdt = Number(o.clear_m) || 0.8;
    var kind = o.kind === "window" ? "window" : "door";
    var name = o.name || (kind + oi);
    var wl = this.wallByName(o.wall), best = null;
    if (wl) {
      best = {d: 0, s: segPointDist(c, wl.A0, wl.B0).s, wl: wl};
    } else {
      for (var i = 0; i < this.walls.length; i++) {
        if (this.walls[i].col) continue;
        var r = segPointDist(c, this.walls[i].A0, this.walls[i].B0);
        if (r.d < ON_WALL_TOL && (best === null || r.d < best.d)) best = {d: r.d, s: r.s, wl: this.walls[i]};
      }
    }
    if (best) {
      best.wl.openings.push({i: oi, o: o, kind: kind, s: best.s + best.wl.ext[0], w: wdt, name: name});
    } else {
      this.freeOpenings.push({i: oi, o: o, kind: kind, c: c, w: wdt, name: name});
    }
  }
};
Builder.prototype.bridgeFreeEnds = function () {
  var segs = this.walls.filter(function (w) { return !w.col; });
  var blockers = [], self0 = this;
  segs.forEach(function (wl) {
    wl.openings.forEach(function (op) {
      if (openingTier(op.o.confidence, self0.opening_tiers) !== "cut") return;
      blockers.push({c: add(wl.fr.A, mul(wl.fr.u, op.s)), r: op.w / 2 + 0.15});
    });
  });
  (this.freeOpenings || []).forEach(function (op) {
    if (openingTier(op.o.confidence, self0.opening_tiers) !== "cut") return;
    blockers.push({c: op.c, r: op.w / 2 + 0.15});
  });
  var bridged = 0, self = this;
  segs.forEach(function (wl) {
    [[wl.fr.A, wl.ext[0]], [wl.fr.B, wl.ext[1]]].forEach(function (pair) {
      var end = pair[0];
      if (pair[1] > 0) return;                      
      var best = null;
      segs.forEach(function (wl2) {
        if (wl2 === wl) return;
        var r = segPointDist(end, wl2.fr.A, wl2.fr.B);
        if (best === null || r.d < best.d) {
          var dd = sub(wl2.fr.B, wl2.fr.A), L2 = dot(dd, dd);
          var t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(end, wl2.fr.A), dd) / L2));
          best = {d: r.d, q: add(wl2.fr.A, mul(dd, t))};
        }
      });
      if (best && best.d > 1e-6 && best.d <= END_BRIDGE) {
        var mid = mul(add(end, best.q), 0.5);
        for (var i = 0; i < blockers.length; i++)
          if (len(sub(mid, blockers[i].c)) < blockers[i].r) return;   
        self.rasterSegs.push([end.slice(), best.q.slice(), wl.fr.t / 2]);
        bridged++;
      }
    });
  });
  if (bridged) this.stats.ends_bridged = bridged;
};
Builder.prototype.openingZRange = function (op) {
  var o = op.o;
  if (op.kind === "door") return [0.0, Number(o.head_m) || DOOR_HEAD];
  return [o.sill_m != null ? Number(o.sill_m) : WIN_SILL, Number(o.head_m) || WIN_HEAD];
};
Builder.prototype.buildWall = function (wl) {
  var w = wl.w, name = w.name || ("wall" + wl.i), wtype = wl.type;
  if (w.confidence != null && Number(w.confidence) < CONF_WALL) {
    wtype = "unverified";                        
    this.stats.low_confidence_walls = (this.stats.low_confidence_walls || 0) + 1;
  }
  var kindMap = {"partition": "partition", "glass": "glass", "unverified": "unverified", "sloped": "sloped"};
  var kind = kindMap[wtype] || "wall";
  if (wl.col) {
    var acc0 = new MeshAcc(), t0 = wl.thick, A0 = wl.A;
    acc0.addBoxXYZ(A0[0] - t0/2, A0[0] + t0/2, A0[1] - t0/2, A0[1] + t0/2, 0, wl.h);
    this.parts.push(partFromAcc(acc0, "column:" + name, "column", {wall: name, wall_i: wl.i}, {flipY: this.flipY}));
    return;
  }
  var fr = wl.fr, L = fr.L0, t = fr.t, self = this;
  var ops = [], ghostOps = [];
  wl.openings.forEach(function (op) {
    var tier = openingTier(op.o.confidence, self.opening_tiers);
    if (!self.stats.opening_tiers) self.stats.opening_tiers = {};
    self.stats.opening_tiers[tier] = (self.stats.opening_tiers[tier] || 0) + 1;
    if (tier === "drop") {
      self.warnings.push("opening " + op.name + " dropped: confidence " +
        Number(op.o.confidence).toFixed(2) + " is below the mark tier " +
        self.opening_tiers.ghost.toFixed(2));
      return;
    }
    if (tier === "ghost") {
      ghostOps.push(op);
      self.notes.push("opening " + op.name + " (confidence " + Number(op.o.confidence).toFixed(2) +
        ") marked on the wall face but NOT cut: too uncertain to remove real wall");
      return;
    }
    var s0 = Math.max(0, op.s - op.w / 2), s1 = Math.min(L, op.s + op.w / 2);
    if (s1 - s0 < 0.05) {
      self.warnings.push("opening " + op.name + " falls off wall " + name + ", skipped"); return;
    }
    var zr = self.openingZRange(op);
    var hi = Math.min(zr[1], Math.min(fr.h(s0), fr.h(s1)) - 0.02);
    if ((s1 - s0) >= 0.90 * L) {
      self.warnings.push("opening " + op.name + " (clear " + op.w.toFixed(2) + " m) spans " +
        Math.round(100 * (s1 - s0) / L) + "% of wall " + name + " (" + L.toFixed(2) +
        " m long): the wall is left as a lintel only. Check the opening width.");
    }
    ops.push({s0: s0, s1: s1, lo: zr[0], hi: hi, op: op});
  });
  var bpsSet = {}; bpsSet[0] = 0; bpsSet[L] = L;
  ops.forEach(function (o) { bpsSet[o.s0] = o.s0; bpsSet[o.s1] = o.s1; });
  var bps = Object.keys(bpsSet).map(function (k) { return bpsSet[k]; }).sort(function (a, b) { return a - b; });
  var piece = 0;
  for (var k = 0; k < bps.length - 1; k++) {
    var s0 = bps[k], s1 = bps[k + 1];
    if (s1 - s0 < 1e-6) continue;
    var mid = (s0 + s1) / 2;
    var cuts = [], cutops = [];
    ops.forEach(function (o) {
      if (o.s0 <= mid && mid <= o.s1) { cuts.push([o.lo, o.hi]); cutops.push(o.op); }
    });
    cuts.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    cuts.forEach(function (c) {
      if (merged.length && c[0] <= merged[merged.length - 1][1])
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], c[1]);
      else merged.push([c[0], c[1]]);
    });
    var solids = [], z = 0, htopLo = Math.min(fr.h(s0), fr.h(s1));
    merged.forEach(function (m) {
      if (m[0] > z + 1e-6) solids.push([z, m[0], false]);
      z = Math.max(z, m[1]);
    });
    if (z < htopLo - 1e-6) solids.push([z, null, true]);
    for (var si = 0; si < solids.length; si++) {
      var z0 = solids[si][0], z1 = solids[si][1], top = solids[si][2];
      var acc = new MeshAcc();
      if (top) fr.box(acc, s0, s1, -t/2, t/2, z0, fr.h(s0), fr.h(s1));
      else fr.box(acc, s0, s1, -t/2, t/2, z0, z1);
      var pk, sem;
      if (!cutops.length) { pk = kind; sem = "wall"; }
      else {
        var ok = cutops[0].kind;
        if (z0 <= 1e-6) { pk = "wall-sill"; sem = "sill"; }
        else if (top) { pk = ok === "door" ? "wall-lintel" : "wall-header"; sem = ok === "door" ? "lintel" : "header"; }
        else { pk = "wall"; sem = "wall"; }
        if (kind !== "wall") pk = kind;
      }
      var src = {wall: name, wall_i: wl.i, type: wtype};
      if (w.confidence != null) src.confidence = Number(w.confidence);
      if (cutops.length) src.opening = cutops[0].name;
      if (w.closure) src.closure = true;   
      this.parts.push(partFromAcc(acc, "wall:" + name + "#" + piece, pk, src,
                                  {flipY: this.flipY, extra: {sem: sem}}));
      piece++;
    }
  }
  ops.forEach(function (o) { self.buildFrameLocal(fr, o.s0, o.s1, o.lo, o.hi, o.op, t); });
  ghostOps.forEach(function (op) {
    var s0 = Math.max(0, op.s - op.w / 2), s1 = Math.min(L, op.s + op.w / 2);
    if (s1 - s0 < 0.05) return;
    var zr = self.openingZRange(op);
    var hi = Math.min(zr[1], Math.min(fr.h(s0), fr.h(s1)) - 0.02);
    var acc = new MeshAcc();
    [1, -1].forEach(function (side) {
      var t0 = side * t / 2, t1 = t0 + side * GHOST_OPENING_T;
      fr.box(acc, s0, s1, Math.min(t0, t1), Math.max(t0, t1), zr[0], hi);
    });
    self.parts.push(partFromAcc(acc, "opening-ghost:" + op.name, "opening-ghost",
      {opening: op.name, wall: name, kind: op.kind, confidence: Number(op.o.confidence || 0)},
      {flipY: self.flipY, extra: {sem: "suspected-opening"}}));
  });
};
Builder.prototype.buildFrameLocal = function (fr, s0, s1, lo, hi, op, t) {
  var kind = op.kind, name = op.name, fw = FRAME_W;
  var tf0 = -t/2 - FRAME_PROUD, tf1 = t/2 + FRAME_PROUD;
  var acc = new MeshAcc();
  fr.box(acc, s0, s0 + fw, tf0, tf1, lo, hi);            
  fr.box(acc, s1 - fw, s1, tf0, tf1, lo, hi);            
  fr.box(acc, s0, s1, tf0, tf1, hi - fw, hi);            
  if (kind === "window") fr.box(acc, s0, s1, tf0, tf1, lo, lo + fw);   
  this.parts.push(partFromAcc(acc, kind + "-frame:" + name, kind + "-frame",
                              {opening: name, kind: kind}, {flipY: this.flipY}));
  if (kind === "window") {
    var accp = new MeshAcc();
    fr.box(accp, s0 + fw, s1 - fw, -0.004, 0.004, lo + fw, hi - fw);
    this.parts.push(partFromAcc(accp, "window-pane:" + name, "window-pane",
                                {opening: name}, {flipY: this.flipY}));
  } else {
    var accl = new MeshAcc(), ang = 25 * Math.PI / 180;
    var lw = (s1 - s0) - 2 * fw, lt = 0.04;
    var hp = fr.pt(s0 + fw, 0, 0), hinge = [hp[0], hp[1]];
    var dvec = [fr.u[0] * Math.cos(ang) + fr.n[0] * Math.sin(ang),
                fr.u[1] * Math.cos(ang) + fr.n[1] * Math.sin(ang)];
    var nvec = [-dvec[1], dvec[0]];
    function P(a, b, z) {
      return [hinge[0] + dvec[0] * a + nvec[0] * b, hinge[1] + dvec[1] * a + nvec[1] * b, z];
    }
    accl.addPrism8([P(0, -lt/2, lo), P(lw, -lt/2, lo), P(lw, lt/2, lo), P(0, lt/2, lo),
                    P(0, -lt/2, hi - fw), P(lw, -lt/2, hi - fw), P(lw, lt/2, hi - fw), P(0, lt/2, hi - fw)]);
    this.parts.push(partFromAcc(accl, "door-leaf:" + name, "door-leaf",
                                {opening: name}, {flipY: this.flipY}));
  }
};
Builder.prototype.findGapSpan = function (c, uHint, between) {
  var pos = null, neg = null, self = this;
  var pool = this.walls;
  if (between && between.length === 2) {
    var wa = this.wallByName(between[0]), wb = this.wallByName(between[1]);
    if (wa && wb) pool = [wa, wb];
    else this.warnings.push("opening 'between' names an unknown wall; falling back to the search");
  }
  pool.forEach(function (wl) {
    if (wl.col) return;
    var fr = wl.fr;
    var perp = Math.abs(dot(sub(c, fr.A), fr.n));
    if (pool === self.walls) {                            
      if (perp > GAP_LINE_TOL) return;
      if (uHint && Math.abs(dot(fr.u, uHint)) < GAP_COS_TOL) return;
    }
    var sA = dot(sub(fr.A, c), fr.u), sB = dot(sub(fr.B, c), fr.u);
    var lo = Math.min(sA, sB), hi = Math.max(sA, sB);
    var cand;
    if (lo > 0) cand = {side: "pos", s: lo, wl: wl, perp: perp};
    else if (hi < 0) cand = {side: "neg", s: hi, wl: wl, perp: perp};
    else return;                                          
    if (cand.side === "pos") { if (!pos || Math.abs(cand.s) < Math.abs(pos.s)) pos = cand; }
    else { if (!neg || Math.abs(cand.s) < Math.abs(neg.s)) neg = cand; }
  });
  if (!pos || !neg) return null;
  var gap = pos.s - neg.s;
  if (gap <= 0.05 || gap > GAP_MAX_W) return null;
  var wl2 = pos.perp <= neg.perp ? pos.wl : neg.wl;
  var u = wl2.fr.u.slice();
  if (uHint && dot(u, uHint) < 0) u = [-u[0], -u[1]];
  return {A: add(c, mul(u, neg.s)), B: add(c, mul(u, pos.s)), u: u,
          t: wl2.fr.t, h: wl2.fr.hA, gap: gap};
};
Builder.prototype.buildFreeOpenings = function () {
  var self = this;
  this.freeOpenings.forEach(function (op) {
    var c = op.c, o = op.o, best = null;
    if (openingTier(o.confidence, self.opening_tiers) !== "cut") {
      self.warnings.push("gap opening " + op.name + " not built: confidence " +
        Number(o.confidence || 0).toFixed(2) + " is below the cut tier " +
        self.opening_tiers.cut.toFixed(2) + ", and a gap unit invents wall");
      return;
    }
    self.walls.forEach(function (wl) {
      if (wl.col) return;
      var r = segPointDist(c, wl.A0, wl.B0);
      if (best === null || r.d < best.d) best = {d: r.d, wl: wl};
    });
    var u;
    if (o.dir) u = norm([Number(o.dir[0]), Number(o.dir[1])]);
    else if (best) u = best.wl.fr.u.slice();
    else u = [1, 0];
    var t = best ? best.wl.fr.t : DEFAULT_THICK;
    var h = best ? best.wl.fr.hA : self.H;
    var A, B;
    var span = self.findGapSpan(c, u, o.between);
    if (span) {
      A = span.A; B = span.B; u = span.u; t = span.t; h = span.h;
      self.stats.openings_snapped = (self.stats.openings_snapped || 0) + 1;
    } else {
      if (best && best.d > 1.5)
        self.warnings.push("opening " + op.name + " is " + best.d.toFixed(2) + " m from any wall; built standalone");
      self.warnings.push("opening " + op.name + " not on a listed wall and no doorway gap found -> free-standing unit");
      var half = op.w / 2 + FRAME_W;
      A = sub(c, mul(u, half)); B = add(c, mul(u, half));
    }
    var fr = new WallFrame(A, B, t, h, h), L = fr.L0;
    var zr = self.openingZRange(op), lo = zr[0], hi = Math.min(zr[1], h - 0.02);
    var acc = new MeshAcc();
    if (hi < h - 1e-6) fr.box(acc, 0, L, -t/2, t/2, hi, h);     
    if (lo > 1e-6) fr.box(acc, 0, L, -t/2, t/2, 0, lo);         
    fr.box(acc, 0, FRAME_W, -t/2, t/2, lo, hi);                 
    fr.box(acc, L - FRAME_W, L, -t/2, t/2, lo, hi);
    self.parts.push(partFromAcc(acc, "wall:gap(" + op.name + ")",
                                op.kind === "door" ? "wall-lintel" : "wall-header",
                                {opening: op.name, gap: true},
                                {flipY: self.flipY, extra: {sem: "gap-unit"}}));
    self.buildFrameLocal(fr, FRAME_W, L - FRAME_W, lo, hi, op, t);
    self.rasterSegs.push([A, B, t / 2]);
  });
};
Builder.prototype.buildFloor = function () {
  var pts = this.corners.slice(), i;
  this.rasterSegs.forEach(function (s) { pts.push(s[0], s[1]); });
  (this.scene.furniture || []).forEach(function (f) { pts.push([Number(f.x), Number(f.y)]); });
  if (pts.length < 3) { this.warnings.push("no geometry for floor"); return; }
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  pts.forEach(function (p) {
    minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
  });
  var mn = [minX - 0.5, minY - 0.5], mx = [maxX + 0.5, maxY + 0.5];
  var raster = RASTER;
  while (Math.ceil((mx[0] - mn[0]) / raster) * Math.ceil((mx[1] - mn[1]) / raster) > MAX_CELLS)
    raster *= 2;
  if (raster !== RASTER) this.warnings.push("scene spans " + (mx[0]-mn[0]).toFixed(0) + " x " +
      (mx[1]-mn[1]).toFixed(0) + " m; floor raster coarsened to " + raster.toFixed(2) + " m");
  this.raster = raster;
  var W = Math.ceil((mx[0] - mn[0]) / raster), Hh = Math.ceil((mx[1] - mn[1]) / raster);
  var wall = new Uint8Array(W * Hh);
  this.rasterSegs.forEach(function (seg) {
    var A = seg[0], B = seg[1], r = seg[2] + GAP_CLOSE;
    var d = sub(B, A), L2 = dot(d, d);
    if (L2 < 1e-9) return;
    var x0 = Math.max(0, Math.floor((Math.min(A[0], B[0]) - r - mn[0]) / raster));
    var x1 = Math.min(W - 1, Math.ceil((Math.max(A[0], B[0]) + r - mn[0]) / raster));
    var y0 = Math.max(0, Math.floor((Math.min(A[1], B[1]) - r - mn[1]) / raster));
    var y1 = Math.min(Hh - 1, Math.ceil((Math.max(A[1], B[1]) + r - mn[1]) / raster));
    for (var y = y0; y <= y1; y++) {
      var cy = mn[1] + (y + 0.5) * raster;
      for (var x = x0; x <= x1; x++) {
        var cx = mn[0] + (x + 0.5) * raster;
        var s = ((cx - A[0]) * d[0] + (cy - A[1]) * d[1]) / L2;
        s = s < 0 ? 0 : (s > 1 ? 1 : s);
        var px = A[0] + s * d[0], py = A[1] + s * d[1];
        if (Math.hypot(cx - px, cy - py) <= r) wall[y * W + x] = 1;
      }
    }
  });
  var interior = floodInterior(wall, W, Hh);
  for (i = 0; i < interior.length; i++) if (wall[i]) interior[i] = 0;
  var hull = convexHull(this.corners.length >= 3 ? this.corners : pts);
  var hullArea = hull.length >= 3 ? Math.abs(polyArea(hull)) : 0;
  var intArea = countMask(interior) * raster * raster;
  var method = "flood", poly = null;
  if (hullArea <= 0 || intArea < OPEN_FRAC * hullArea) {
    var got = null;
    for (var k = 0; k < SEAL_TRY.length; k++) {
      var R = SEAL_TRY[k];
      var cand = floodInterior(diskClose(wall, W, Hh, R, raster), W, Hh);
      for (i = 0; i < cand.length; i++) if (wall[i]) cand[i] = 0;
      var a = countMask(cand) * raster * raster;
      if (a >= SEAL_FRAC * hullArea && (!got || a > got.a)) got = {R: R, mask: cand, a: a};
    }
    if (got) {
      interior = got.mask; intArea = got.a;
      method = "inferred-seal" + got.R;
      this.warnings.push("walls do not enclose a room; floor inferred by sealing gaps up to " +
                         (2 * got.R).toFixed(1) + " m (interior " + intArea.toFixed(1) +
                         " m2 of hull " + hullArea.toFixed(1) + " m2)");
    } else {
      method = "hull";
      this.warnings.push("walls do not enclose a room (interior " + intArea.toFixed(1) +
                         " m2 vs hull " + hullArea.toFixed(1) + " m2) -> floor = convex hull");
      poly = polyArea(hull) > 0 ? offsetConvex(hull, PLATE_MARGIN)
                                : offsetConvex(hull.slice().reverse(), PLATE_MARGIN);
    }
  }
  if (method !== "hull") {
    var plate = diskDilate(interior, W, Hh, PLATE_MARGIN + GAP_CLOSE, raster);
    plate = fillHoles(plate, W, Hh);
    plate = largestComponent(plate, W, Hh);
    poly = traceOutline(plate, W, Hh, mn, raster);
    poly = simplifyDP(poly, 0.03);
  }
  if (!poly || poly.length < 3) { this.warnings.push("floor outline degenerate, skipped"); return; }
  this.stats.floor_method = method;
  this.stats.floor_inferred = method !== "flood";
  this.stats.floor_area_m2 = Math.round(Math.abs(polyArea(poly)) * 100) / 100;
  this.stats.interior_area_m2 = Math.round(intArea * 100) / 100;
  var tris = earClip(poly), acc = new MeshAcc();
  var top = poly.map(function (p) { return [p[0], p[1], 0]; });
  var bot = poly.map(function (p) { return [p[0], p[1], -FLOOR_T]; });
  var ccw = polyArea(poly) > 0;
  tris.forEach(function (t) {
    if (ccw) { acc.addTri(top[t[0]], top[t[1]], top[t[2]]); acc.addTri(bot[t[0]], bot[t[2]], bot[t[1]]); }
    else { acc.addTri(top[t[0]], top[t[2]], top[t[1]]); acc.addTri(bot[t[0]], bot[t[1]], bot[t[2]]); }
  });
  var n = poly.length;
  for (i = 0; i < n; i++) {
    var j = (i + 1) % n;
    if (ccw) acc.addQuad(bot[i], bot[j], top[j], top[i]);
    else acc.addQuad(bot[j], bot[i], top[i], top[j]);
  }
  this.parts.push(partFromAcc(acc, "floor", "floor", {method: method},
                              {flipY: this.flipY, extra: {poly: poly}}));
};
function traceOutline(mask, W, H, mn, raster) {
  raster = raster || RASTER;
  var pw = W + 2, ph = H + 2;
  var pad = new Uint8Array(pw * ph), x, y;
  for (y = 0; y < H; y++) for (x = 0; x < W; x++) pad[(y + 1) * pw + (x + 1)] = mask[y * W + x];
  var edges = new Map();
  for (y = 1; y < ph - 1; y++) {
    for (x = 1; x < pw - 1; x++) {
      if (!pad[y * pw + x]) continue;
      var x0 = x - 1, y0 = y - 1, x1 = x, y1 = y;
      if (!pad[(y - 1) * pw + x]) edges.set(x0 + "," + y0, [x1, y0]);   
      if (!pad[y * pw + (x + 1)]) edges.set(x1 + "," + y0, [x1, y1]);   
      if (!pad[(y + 1) * pw + x]) edges.set(x1 + "," + y1, [x0, y1]);   
      if (!pad[y * pw + (x - 1)]) edges.set(x0 + "," + y1, [x0, y0]);   
    }
  }
  var best = [], used = new Set();
  edges.forEach(function (_v, startKey) {
    if (used.has(startKey)) return;
    var loop = [startKey.split(",").map(Number)];
    used.add(startKey);
    var cur = edges.get(startKey), curKey = cur[0] + "," + cur[1];
    while (curKey !== startKey && edges.has(curKey) && !used.has(curKey)) {
      loop.push(cur); used.add(curKey);
      cur = edges.get(curKey); curKey = cur[0] + "," + cur[1];
    }
    if (loop.length > best.length) best = loop;
  });
  return best.map(function (p) { return [mn[0] + p[0] * raster, mn[1] + p[1] * raster]; });
}
Builder.prototype.proxyTwins = function (tol) {
  tol = tol || 0.03;
  var F = this.scene.furniture || [], self = this, twins = {};
  function n(v) { return Number(v) || 0; }
  function isProxy(f) {
    return objectTier(f, self.conf_tiers) === "proxy" &&
           ["table", "sofa", "chair", "bed"].indexOf(classify(String(f.label || ""))) >= 0;
  }
  for (var i = 0; i < F.length; i++) {
    for (var j = 0; j < F.length; j++) {
      if (i === j) continue;
      var a = F[i], b = F[j];
      if (Math.abs(n(a.x) - n(b.x)) >= tol || Math.abs(n(a.y) - n(b.y)) >= tol ||
          Math.abs(n(a.sz) - n(b.sz)) >= tol || Math.abs(n(a.z0) - n(b.z0)) >= tol) continue;
      if (isProxy(b) && !isProxy(a)) { twins[i] = "proxy:" + j + ":" + b.label; break; }
    }
  }
  return twins;
};
Builder.prototype.buildFurniture = function () {
  var self = this, items = this.scene.furniture || [];
  var twins = this.proxyTwins();
  for (var fi = 0; fi < items.length; fi++) {
    var f = items[fi];
    var label = String(f.label || ("item" + fi));
    var x = Number(f.x), y = Number(f.y);
    var ang = Number(f.ang) || 0;
    if (!this.angRadians) ang = ang * Math.PI / 180;   
    var sx = Number(f.sx) || 0.5, sy = Number(f.sy) || 0.5, sz = Number(f.sz) || 0.5;
    var z0 = Number(f.z0) || 0, ghost = !!f.ghost;
    var conf = f.confidence;
    var rawTier = furnitureTier(conf, this.conf_tiers);
    var tier = objectTier(f, this.conf_tiers);
    if (tier !== rawTier) {
      this.warnings.push("object '" + label + "' has size_source 'prior', so its tier is " +
        "clamped from '" + rawTier + "' to '" + tier + "': the position is detected but the " +
        "size is assumed.");
    }
    if (!this.stats.furniture_tiers) this.stats.furniture_tiers = {};
    this.stats.furniture_tiers[tier] = (this.stats.furniture_tiers[tier] || 0) + 1;
    if (tier === "drop") {
      this.warnings.push("object '" + label + "' dropped: confidence " + Number(conf).toFixed(3) +
                         " is below the ghost tier " + this.conf_tiers.ghost.toFixed(3));
      continue;
    }
    if (tier === "ghost") ghost = true;           
    var cs = Math.cos(ang), sn = Math.sin(ang);
    function P(lx, ly, z) { return [x + lx * cs - ly * sn, y + lx * sn + ly * cs, z]; }
    function mkBox(acc) {
      return function (x0, x1, y0, y1, za, zb) {
        acc.addPrism8([P(x0, y0, za), P(x1, y0, za), P(x1, y1, za), P(x0, y1, za),
                       P(x0, y0, zb), P(x1, y0, zb), P(x1, y1, zb), P(x0, y1, zb)]);
      };
    }
    var cat = classify(label);
    var src = {label: label, index: fi, category: cat, ghost: ghost};
    if (conf != null) src.confidence = Number(conf);
    var acc = new MeshAcc();
    mkBox(acc)(-sx/2, sx/2, -sy/2, sy/2, z0, z0 + sz);
    var extra = {lod: "box"};
    if (twins[fi]) {
      extra.coincident_proxy = twins[fi];
      this.stats.boxes_inside_a_twin_proxy = (this.stats.boxes_inside_a_twin_proxy || 0) + 1;
    }
    this.parts.push(partFromAcc(acc, "furniture:" + fi + ":" + label,
                                ghost ? "furniture-ghost" : "furniture", src,
                                {flipY: this.flipY, extra: extra}));
    if (this.proxies && tier === "proxy" && PROXY[cat]) {
      var accp = new MeshAcc();
      PROXY[cat](mkBox(accp), sx, sy, sz, z0);
      this.parts.push(partFromAcc(accp, "proxy:" + fi + ":" + label, "proxy-" + cat, src,
                                  {flipY: this.flipY, alpha: ghost ? 0.5 : 1.0, extra: {lod: "proxy"}}));
    }
  }
};
Builder.prototype.checkFlatPlan = function () {
  var C = this.scene.corners || [];
  if (!C.length) return;
  var H = Number(this.H), fam = {}, self = this;
  (this.scene.walls || []).forEach(function (w) {
    var A = C[w.a | 0], B = C[w.b | 0];
    if (!A || !B) return;
    var dx = B[0] - A[0], dy = B[1] - A[1], L = Math.sqrt(dx * dx + dy * dy);
    if (L < 1e-6) return;
    var ux = dx / L, uy = dy / L;
    var ang = ((Math.atan2(uy, ux) * 180 / Math.PI) % 180 + 180) % 180;
    var key = (Math.round(ang / 5) * 5) % 180;
    (fam[key] = fam[key] || []).push([w.name, L, -uy * A[0] + ux * A[1]]);
  });
  var keys = Object.keys(fam);
  for (var ki = 0; ki < keys.length; ki++) {
    var ws = fam[keys[ki]];
    ws.sort(function (a, b) { return a[2] - b[2]; });
    for (var i = 1; i < ws.length; i++) {
      var gap = Math.abs(ws[i][2] - ws[i - 1][2]);
      if (Math.abs(gap - H) <= 0.06 * H && Math.min(ws[i][1], ws[i - 1][1]) >= 2.0) {
        self.notes.push("walls " + ws[i - 1][0] + " and " + ws[i][0] + " are parallel, both " +
          "over 2 m long, and " + gap.toFixed(2) + " m apart, which is the ceiling height " +
          H.toFixed(2) + ". That is the shape a plan takes when the scan was oriented with " +
          "gravity wrong and the floor and ceiling were fitted as walls. It is also just what " +
          "a room this narrow looks like, so this is a question, not a verdict: check the " +
          "source cloud's up-axis before trusting this plan.");
        return;
      }
    }
  }
};
Builder.prototype.checkBounds = function () {
  if (!this.walls.length) return;
  var xs = [], ys = [];
  this.walls.forEach(function (wl) {
    var pts = wl.col ? [wl.A] : [wl.fr.A, wl.fr.B];
    pts.forEach(function (p) { xs.push(p[0]); ys.push(p[1]); });
  });
  var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
  var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  var tol = Math.max(2.0, 0.5 * Math.max(x1 - x0, y1 - y0, 1.0));
  var self = this;
  function outside(x, y) { return x < x0 - tol || x > x1 + tol || y < y0 - tol || y > y1 + tol; }
  var ghosts = (this.scene.furniture || []).filter(function (f) { return f.ghost; })
                  .map(function (f) { return [Number(f.x), Number(f.y)]; });
  var strayGhosts = ghosts.filter(function (p) { return outside(p[0], p[1]); });
  if (strayGhosts.length)
    this.notes.push(strayGhosts.length + " of " + ghosts.length + " ghost furniture items sit " +
      "outside the walls; expected, they come from scan regions that were never tagged");
  [["furniture", (this.scene.furniture || []).filter(function (f) { return !f.ghost; })
                    .map(function (f) { return [Number(f.x), Number(f.y)]; })],
   ["opening", (this.scene.openings || []).map(function (o) { return [Number(o.center[0]), Number(o.center[1])]; })]
  ].forEach(function (pair) {
    var bad = pair[1].filter(function (p) { return outside(p[0], p[1]); });
    if (!bad.length) return;
    self.warnings.push("FRAME? " + bad.length + " of " + pair[1].length + " " + pair[0] +
      " items lie outside the walls (walls span x " + x0.toFixed(1) + ".." + x1.toFixed(1) +
      ", y " + y0.toFixed(1) + ".." + y1.toFixed(1) + "; first stray at " +
      bad[0][0].toFixed(1) + ", " + bad[0][1].toFixed(1) + "). Scene frame is '" +
      self.frameInfo.frame + "' with offset [" + self.frameInfo.offset + "] -- check the frame/lo fields.");
  });
  if (this.frameInfo.unknown_frame)
    this.warnings.push("unknown scene frame '" + this.frameInfo.frame + "'; treated as 'editor'");
};
Builder.prototype.checkPlacePriors = function () {
  if (!this.scene.place_priors) return;
  this.warnings.push("scene asks for place_priors, which this JS builder does not implement " +
    "(the Python builder does). Objects placed from a prior will be MISSING here -- do not " +
    "compare this build against a Python build of the same scene.");
};
Builder.prototype.checkProvenance = function () {
  var ov = this.scene.calibration_overridden;
  if (!ov) return;
  this.stats.calibration_overridden = true;
  this.warnings.push("QUARANTINED: this scene was built with an UNVERIFIED calibration " +
    "(override reason: " + (ov.reason || "none given") + "). " + ov.objects_disagreeing +
    " of " + ov.objects_checked + " objects disagreed with the curve, worst by " +
    ov.worst_error + ". Every confidence tier in this build is suspect.");
};
Builder.prototype.checkDuplicateFurniture = function (tol) {
  tol = tol || 0.03;
  var F = this.scene.furniture || [], self = this;
  function n(v) { return Number(v) || 0; }
  for (var i = 0; i < F.length; i++) {
    for (var k = i + 1; k < F.length; k++) {
      var a = F[i], b = F[k];
      if (Math.abs(n(a.x) - n(b.x)) >= tol || Math.abs(n(a.y) - n(b.y)) >= tol ||
          Math.abs(n(a.sx) - n(b.sx)) >= tol || Math.abs(n(a.sy) - n(b.sy)) >= tol ||
          Math.abs(n(a.sz) - n(b.sz)) >= tol || Math.abs(n(a.z0) - n(b.z0)) >= tol) continue;
      self.stats.duplicate_furniture = (self.stats.duplicate_furniture || 0) + 1;
      self.notes.push("objects " + i + " '" + a.label + "' and " + k + " '" + b.label +
        "' are geometrically identical (same centre, size and z0) -- one object detected twice, " +
        "not a stack. Both kept; confidences " + a.confidence + " and " + b.confidence + ".");
    }
  }
};
Builder.prototype.run = function () {
  var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
  this.checkProvenance();
  this.checkPlacePriors();
  this.checkDuplicateFurniture();
  this.prepWalls();
  this.assignOpenings();
  this.bridgeFreeEnds();
  this.checkBounds();
  this.checkFlatPlan();
  for (var i = 0; i < this.walls.length; i++) this.buildWall(this.walls[i]);
  this.buildFreeOpenings();
  this.buildFloor();
  this.buildFurniture();
  var tris = 0, cut = 0;
  this.parts.forEach(function (p) { tris += p.tris; });
  this.walls.forEach(function (w) { if (!w.col) cut += w.openings.length; });
  var ot = this.stats.opening_tiers;
  if (ot) {   
    cut = ot.cut || 0;
    this.stats.openings_marked = ot.ghost || 0;
    this.stats.openings_dropped = ot.drop || 0;
  }
  var t1 = (global.performance && performance.now) ? performance.now() : Date.now();
  this.stats.parts = this.parts.length;
  this.stats.tris = tris;
  this.stats.walls = this.walls.length;
  this.stats.openings_cut = cut;
  this.stats.openings_gap = this.freeOpenings.length;
  this.stats.furniture = (this.scene.furniture || []).length;
  this.stats.conf_tiers = this.conf_tiers;
  this.stats.opening_tiers_used = this.opening_tiers;
  this.stats.frame = this.frameInfo.frame;
  this.stats.frame_offset = this.frameInfo.offset;
  this.stats.build_ms = Math.round((t1 - t0) * 10) / 10;
  return this;
};
function buildParts(scene, opts) {
  var b = new Builder(scene, opts).run();
  return {parts: b.parts, stats: b.stats, warnings: b.warnings, notes: b.notes};
}
function requireTHREE() {
  var T = global.THREE;
  if (!T) throw new Error("maquette_live: THREE is not loaded (three.js UMD must come first)");
  return T;
}
function buildMaquette(scene, opts) {
  var T = requireTHREE();
  opts = opts || {};
  var res = buildParts(scene, opts);
  var group = new T.Group();
  group.name = "maquette";
  res.parts.forEach(function (part) {
    var g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(part.V, 3));
    g.setIndex(new T.BufferAttribute(part.F, 1));
    g.computeVertexNormals();                 
    var m = new T.MeshLambertMaterial({
      color: new T.Color(part.color[0], part.color[1], part.color[2]),
      transparent: part.alpha < 1, opacity: part.alpha,
      side: T.DoubleSide, depthWrite: part.alpha >= 1
    });
    var mesh = new T.Mesh(g, m);
    mesh.name = part.id;
    mesh.renderOrder = part.alpha < 1 ? 2 : 1;
    mesh.userData = {part: part, kind: part.kind, group: groupOf(part.kind),
                     baseColor: m.color.clone(), proxy: part.kind.indexOf("proxy-") === 0,
                     lod: part.lod || null};
    group.add(mesh);
  });
  group.userData = {stats: res.stats, warnings: res.warnings, notes: res.notes, parts: res.parts};
  return group;
}
var GROUPS = [
  {id: "floor",      name: "Floor slab",      kinds: ["floor"]},
  {id: "walls",      name: "Walls",           kinds: ["wall", "wall-lintel", "wall-sill", "wall-header", "partition", "sloped"]},
  {id: "unverified", name: "Unverified walls",kinds: ["unverified"]},
  {id: "glass",      name: "Glass / columns", kinds: ["glass", "column"]},
  {id: "doors",      name: "Doors",           kinds: ["door-frame", "door-leaf"]},
  {id: "windows",    name: "Windows",         kinds: ["window-frame", "window-pane"]},
  {id: "furniture",  name: "Furniture",       kinds: ["furniture", "furniture-ghost", "proxy-table", "proxy-sofa", "proxy-chair", "proxy-bed"]}
];
var KIND2GROUP = {};
GROUPS.forEach(function (g) { g.kinds.forEach(function (k) { KIND2GROUP[k] = g.id; }); });
function groupOf(kind) { return KIND2GROUP[kind] || "walls"; }
function mountMaquette(canvasEl, opts) {
  var T = requireTHREE();
  opts = opts || {};
  var renderer = new T.WebGLRenderer({canvas: canvasEl, antialias: true, alpha: !!opts.alpha});
  renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
  var scene3 = new T.Scene();
  if (opts.background !== null) scene3.background = new T.Color(opts.background || 0xdfe4ea);
  var camera = new T.PerspectiveCamera(opts.fov || 38, 1, 0.05, 500);
  var hemi = new T.HemisphereLight(0xffffff, 0x9aa4ae, 0.72); scene3.add(hemi);
  var key = new T.DirectionalLight(0xffffff, 0.78); key.position.set(-4.2, 9, 5.4); scene3.add(key);
  var rim = new T.DirectionalLight(0xffffff, 0.26); rim.position.set(5, 3.5, -5); scene3.add(rim);
  var model = null, grid = null, box = new T.Box3();
  var vis = {}; GROUPS.forEach(function (g) { vis[g.id] = true; });
  var fmode = opts.furniture || "box";
  var proxied = {};
  var cam = {tgt: new T.Vector3(), dist: 12, yaw: -0.72, pitch: 0.62};
  var raf = 0, disposed = false;
  function place() {
    var cp = Math.cos(cam.pitch);
    camera.position.set(cam.tgt.x + cam.dist * cp * Math.sin(cam.yaw),
                        cam.tgt.y + cam.dist * Math.sin(cam.pitch),
                        cam.tgt.z + cam.dist * cp * Math.cos(cam.yaw));
    camera.lookAt(cam.tgt);
  }
  function fit(kind) {
    if (!model) return;
    var c = box.getCenter(new T.Vector3()), s = box.getSize(new T.Vector3());
    cam.tgt.copy(c);
    var r = Math.max(s.x, s.z, s.y) * 0.5;
    cam.dist = r / Math.tan(camera.fov * Math.PI / 360) * 1.9;
    if (kind === "top") { cam.pitch = 1.4; cam.yaw = -0.0001; cam.dist *= 0.86; }
    else if (kind === "iso") { cam.pitch = 0.62; cam.yaw = -0.72; }
    place();
  }
  function applyVis() {
    if (!model) return;
    model.children.forEach(function (m) {
      var u = m.userData;
      if (!u || !u.part) { m.visible = true; return; }
      var on = vis[u.group] !== false;
      if (u.group === "furniture") {
        var key2 = (u.part.id.split(":")[1]) || "";
        if (fmode === "proxy") {
        on = on && (u.proxy || !proxied[key2]);
        if (u.part.coincident_proxy) on = false;   
      }
        else on = on && !u.proxy;
      }
      m.visible = on;
    });
  }
  function disposeModel() {
    if (!model) return;
    model.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    scene3.remove(model); model = null;
  }
  function update(sceneJson, buildOpts) {
    var keep = model !== null;
    var prevTgt = cam.tgt.clone(), prevDist = cam.dist;
    disposeModel();
    model = buildMaquette(sceneJson, buildOpts || opts.build);
    proxied = {};
    model.userData.parts.forEach(function (p) {
      if (p.kind.indexOf("proxy-") === 0) proxied[p.id.split(":")[1]] = true;
    });
    scene3.add(model);
    box.setFromObject(model);
    if (grid) { scene3.remove(grid); grid.geometry.dispose(); grid.material.dispose(); grid = null; }
    if (opts.grid !== false) {
      var s = Math.ceil(Math.max(box.max.x - box.min.x, box.max.z - box.min.z)) + 8;
      grid = new T.GridHelper(s, s, opts.gridColor || 0x93a0af, opts.gridColor2 || 0xaeb8c4);
      grid.material.transparent = true; grid.material.opacity = 0.55;
      var c = box.getCenter(new T.Vector3());
      grid.position.set(Math.round(c.x), -0.061, Math.round(c.z));
      scene3.add(grid);
    }
    applyVis();
    if (keep && opts.keepCamera !== false) { cam.tgt.copy(prevTgt); cam.dist = prevDist; place(); }
    else fit("iso");
    return model.userData.stats;
  }
  var drag = null;
  function onDown(e) { drag = {x: e.clientX, y: e.clientY, b: e.button}; canvasEl.setPointerCapture(e.pointerId); }
  function onUp() { drag = null; }
  function onMove(e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.b === 2 || e.shiftKey) {
      var s = cam.dist * 0.0016;
      cam.tgt.x += -dx * s * Math.cos(cam.yaw);
      cam.tgt.z += dx * s * Math.sin(cam.yaw);
      cam.tgt.y += dy * s;
    } else {
      cam.yaw -= dx * 0.007;
      cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dy * 0.006));
    }
    place();
  }
  function onWheel(e) {
    e.preventDefault();
    cam.dist = Math.max(0.6, Math.min(200, cam.dist * Math.exp(e.deltaY * 0.0011)));
    place();
  }
  canvasEl.addEventListener("pointerdown", onDown);
  canvasEl.addEventListener("pointerup", onUp);
  canvasEl.addEventListener("pointercancel", onUp);
  canvasEl.addEventListener("pointermove", onMove);
  canvasEl.addEventListener("wheel", onWheel, {passive: false});
  canvasEl.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  function resize() {
    var w = canvasEl.clientWidth || canvasEl.width, h = canvasEl.clientHeight || canvasEl.height;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  function loop() {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    renderer.render(scene3, camera);
  }
  resize(); place(); loop();
  var ray = new T.Raycaster(), ndc = new T.Vector2();
  return {
    update: update,
    fit: fit,
    resize: resize,
    setTheme: function (bg, gridColor) {
      if (bg != null) scene3.background = new T.Color(bg);
      if (gridColor != null && grid) {
        grid.material.color.set(gridColor);
        if (grid.material.vertexColors) {                 
          var col = new T.Color(gridColor), a = grid.geometry.attributes.color;
          for (var i = 0; i < a.count; i++) a.setXYZ(i, col.r, col.g, col.b);
          a.needsUpdate = true;
        }
      }
    },
    setGroupVisible: function (id, on) { vis[id] = !!on; applyVis(); },
    setFurnitureMode: function (m) { fmode = m; applyVis(); },
    groups: GROUPS,
    pick: function (clientX, clientY) {
      if (!model) return null;
      var r = canvasEl.getBoundingClientRect();
      ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
      ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(ndc, camera);
      var hits = ray.intersectObjects(model.children.filter(function (m) { return m.visible; }), false);
      return hits.length ? hits[0].object : null;
    },
    get model() { return model; },
    get camera() { return camera; },
    get renderer() { return renderer; },
    dispose: function () {
      disposed = true; cancelAnimationFrame(raf);
      canvasEl.removeEventListener("pointerdown", onDown);
      canvasEl.removeEventListener("pointerup", onUp);
      canvasEl.removeEventListener("pointercancel", onUp);
      canvasEl.removeEventListener("pointermove", onMove);
      canvasEl.removeEventListener("wheel", onWheel);
      disposeModel(); renderer.dispose();
    }
  };
}
var API = {
  buildParts: buildParts,
  buildMaquette: buildMaquette,
  mountMaquette: mountMaquette,
  classify: classify,
  GROUPS: GROUPS,
  COL: COL,
  version: "1.0.0"
};
if (typeof module === "object" && module.exports) module.exports = API;
global.MaquetteLive = API;
})(typeof window !== "undefined" ? window : this);