/* @ds-bundle: {"format":4,"namespace":"Crystal","components":[{"name":"Verdict"},{"name":"Patterns"},{"name":"Shader"}]} */
/* Crystal pattern generators. Each returns an SVG string whose strokes and fills
   are classes bound to tokens (see bundle.css .cp-*), so they follow the theme.
   Our own code, in the spirit of Book of Shapes (bookofshapes.com). */
(function () {
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function noise2(seed) {
    var r = rng(seed), g = [];
    for (var i = 0; i < 256; i++) g.push(r());
    function h(x, y) { return g[(x * 73856093 ^ y * 19349663) & 255]; }
    function s(t) { return t * t * (3 - 2 * t); }
    return function (x, y) {
      var xi = Math.floor(x), yi = Math.floor(y), xf = s(x - xi), yf = s(y - yi);
      var a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
      return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
    };
  }
  function f(n) { return Math.round(n * 10) / 10; }
  function svg(w, h, body, tone) {
    return '<svg class="cp cp--' + (tone || 'quiet') + '" viewBox="0 0 ' + w + ' ' + h +
      '" width="100%" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' + body + '</svg>';
  }
  /* Triangular mosaic: ordered pinwheels at the top that break into clusters
     further down. Crystal's identity: a system that stays ordered until something breaks it. */
  function mosaic(o) {
    o = o || {};
    var w = o.width || 480, h = o.height || 300, c = o.cell || 24, r = rng(o.seed || 7);
    var accent = o.accents == null ? 3 : o.accents, out = '';
    for (var y = 0; y < h; y += c) {
      var chaos = Math.pow(y / h, 1.6);
      for (var x = 0; x < w; x += c) {
        var i = x / c, j = y / c;
        var ori = r() < chaos ? Math.floor(r() * 4) : [[0, 3], [1, 2]][i % 2][j % 2];
        var p = [[x, y], [x + c, y], [x + c, y + c], [x, y + c]];
        var t = [p[ori], p[(ori + 1) % 4], p[(ori + 2) % 4]];
        var cls = 'cp-fill';
        if (accent > 0 && chaos > 0.3 && r() < 0.025) { cls = 'cp-accent'; accent--; }
        out += '<path class="' + cls + '" style="transform-origin:' + (x + c / 2) + 'px ' + (y + c / 2) + 'px" d="M' + t[0] + 'L' + t[1] + 'L' + t[2] + 'z"/>';
      }
    }
    return svg(w, h, out, o.tone);
  }
  /* Interference mesh: horizontal lines displaced by two point sources.
     Meaning: exploration, the paused real command and its throwaway copy. */
  function interference(o) {
    o = o || {};
    var w = o.width || 480, h = o.height || 200, n = o.lines || 16, k = o.wavelength || 46;
    var s1 = [w * 0.3, h * 0.5], s2 = [w * 0.7, h * 0.5], amp = o.amplitude || 3.5, out = '';
    for (var l = 0; l <= n; l++) {
      var y0 = l * h / n, d = '';
      for (var x = 0; x <= w; x += 4) {
        var d1 = Math.hypot(x - s1[0], y0 - s1[1]), d2 = Math.hypot(x - s2[0], y0 - s2[1]);
        var ph = o.phase || 0, y = y0 + amp * (Math.sin((d1 / k - ph) * 2 * Math.PI) + Math.sin((d2 / k - ph) * 2 * Math.PI)) / 2;
        d += (x ? 'L' : 'M') + x + ' ' + f(y);
      }
      out += '<path class="' + (l === Math.round(n / 2) ? 'cp-accent-line' : 'cp-line') + '" d="' + d + '"/>';
    }
    return svg(w, h, out, o.tone);
  }
  /* Iso cube wireframe: a hollow box built from small cubes on its 12 edges.
     Meaning: the sandbox, a throwaway copy of the system with nothing inside. */
  function isoBox(o) {
    o = o || {};
    var n = o.n || 6, s = o.cell || 12, cx = Math.cos(Math.PI / 6) * s, cy = Math.sin(Math.PI / 6) * s;
    var w = Math.ceil(2 * n * cx + 8), h = Math.ceil(n * s + 2 * n * cy + 8), ox = w / 2, oy = 4, cells = [];
    for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) for (var z = 0; z < n; z++) {
      var e = (a === 0 || a === n - 1) + (b === 0 || b === n - 1) + (z === 0 || z === n - 1);
      if (e >= 2) cells.push([a, b, z]);
    }
    cells.sort(function (p, q) { return (p[0] + p[1] + p[2]) - (q[0] + q[1] + q[2]); });
    function pt(a, b, z) { return [f(ox + (a - b) * cx), f(oy + (a + b) * cy + (n - 1 - z) * s)]; }
    var out = '';
    cells.forEach(function (q) {
      var a = q[0], b = q[1], z = q[2];
      var top = [pt(a, b, z + 1), pt(a + 1, b, z + 1), pt(a + 1, b + 1, z + 1), pt(a, b + 1, z + 1)];
      var left = [pt(a, b + 1, z + 1), pt(a + 1, b + 1, z + 1), pt(a + 1, b + 1, z), pt(a, b + 1, z)];
      var right = [pt(a + 1, b, z + 1), pt(a + 1, b + 1, z + 1), pt(a + 1, b + 1, z), pt(a + 1, b, z)];
      var lit = o.lit == null ? -1 : o.lit, hot = lit < 0 ? (a === n - 1 && b === n - 1 && z === n - 1) : (cells.indexOf(q) === lit % cells.length);
      [[top, hot ? 'cp-accent' : 'cp-face-top'], [left, 'cp-face-left'], [right, 'cp-face-right']].forEach(function (fc) {
        out += '<path class="' + fc[1] + ' cp-edge" d="M' + fc[0].join('L') + 'z"/>';
      });
    });
    return svg(w, h, out, o.tone);
  }
  /* Broken ring: an annulus of cells between concentric polygons, gaps chosen by noise.
     Meaning: removal, a session cut, a key pulled, an IP banned. */
  function brokenRing(o) {
    o = o || {};
    var size = o.size || 240, sides = o.sides || 6, rings = o.rings || 5, segs = o.segments || 12;
    var density = o.density == null ? 0.72 : o.density, nz = noise2(o.seed || 3), c = size / 2, out = '', alerts = o.alerts == null ? 3 : o.alerts;
    var r0 = size * 0.2, r1 = size * 0.47;
    function at(ring, t) {
      var rr = r0 + (r1 - r0) * ring / rings, k = Math.floor(t), u = t - k;
      var a1 = (k / sides) * 2 * Math.PI - Math.PI / 2, a2 = ((k + 1) / sides) * 2 * Math.PI - Math.PI / 2;
      return [f(c + rr * ((1 - u) * Math.cos(a1) + u * Math.cos(a2))), f(c + rr * ((1 - u) * Math.sin(a1) + u * Math.sin(a2)))];
    }
    for (var ri = 0; ri < rings; ri++) for (var si = 0; si < sides * segs; si++) {
      var t0 = si / segs, t1 = (si + 1) / segs;
      var v = nz(si / segs * 1.3 + (o.time || 0), ri * 0.9 + (o.time || 0) * 0.3);
      if (v > density) continue;
      var p = [at(ri, t0), at(ri, t1), at(ri + 1, t1), at(ri + 1, t0)];
      var alert = alerts > 0 && v > density - 0.012; if (alert) alerts--;
      out += '<path class="' + (alert ? 'cp-alert' : 'cp-fill') + '" d="M' + p.join('L') + 'z"/>';
    }
    return svg(size, size, out, o.tone);
  }
  /* Signal decay: sine lines whose frequency and amplitude fade left to right.
     Meaning: waiting, a hold running out its timeout, a feed with nothing new. */
  function signalDecay(o) {
    o = o || {};
    var w = o.width || 480, h = o.height || 160, n = o.lines || 9, out = '';
    for (var l = 0; l < n; l++) {
      var y0 = (l + 0.5) * h / n, d = '';
      for (var x = 0; x <= w; x += 3) {
        var u = x / w, amp = (h / n) * 0.42 * Math.pow(1 - u, 1.4), fr = 0.25 * (1 - u) + 0.02;
        d += (x ? 'L' : 'M') + x + ' ' + f(y0 + amp * Math.sin(x * fr + l * 0.7 - (o.phase || 0)));
      }
      out += '<path class="' + (l === 0 ? 'cp-accent-line' : 'cp-line') + '" d="' + d + '"/>';
    }
    return svg(w, h, out, o.tone);
  }
  /* Shader: ShaderGradient (shadergradient.co, MIT) via components/lib/shadergradient.js,
     which defines window.CrystalGradient. Crystal ships three presets built on ShaderGradient's
     own nightyNight and universe presets, colored from the sg-* tokens. */
  var SG_PRESETS = {
    sheet: { base: 'nightyNight', props: { brightness: 1.1 } },
    storm: { base: 'nightyNight', props: { brightness: 1.1, uStrength: 2.6, uDensity: 2.1, uSpeed: 0.45 } },
    tide: { base: 'universe', props: { brightness: 0.9, color3: '#000000' } }
  };
  function shader(el, o) {
    o = o || {};
    var G = window.CrystalGradient;
    if (!G) return { stop: function () {} };
    var pre = SG_PRESETS[o.preset || 'sheet'], cs = getComputedStyle(el), props = {}, k;
    var base = G.presets[pre.base].props;
    for (k in base) props[k] = base[k];
    props.color1 = cs.getPropertyValue('--sg-rose').trim() || '#9e1f4c';
    props.color2 = cs.getPropertyValue('--sg-teal').trim() || '#17736a';
    props.color3 = cs.getPropertyValue('--sg-shadow').trim() || '#0e0f10';
    props.grain = 'off';
    props.lightType = '3d';
    for (k in pre.props) props[k] = pre.props[k];
    for (k in o) if (k !== 'preset') props[k] = o[k];
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) props.animate = 'off';
    return G.mount(el, props);
  }
  var api = { mosaic: mosaic, interference: interference, isoBox: isoBox, brokenRing: brokenRing, signalDecay: signalDecay };
  /* play(container, name, options): draws a pattern and keeps it changing.
     mosaic tiles turn in place, interference ripples outward, the sandbox's lit cube
     walks its edges, the ring breaks and heals, the decay lines drift. Returns { stop }.
     Reduced motion draws one still frame. */
  function play(el, name, o) {
    o = o || {};
    var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var gen = api[name], raf = 0, timer = 0, t0 = performance.now();
    el.innerHTML = gen(o);
    if (still) return { stop: function () {} };
    if (name === 'mosaic') {
      var tris = el.querySelectorAll('path'), r = rng((o.seed || 7) + 99), turns = [];
      for (var i = 0; i < tris.length; i++) { turns.push(0); tris[i].style.transition = 'transform .7s cubic-bezier(.6,0,.2,1)'; }
      timer = setInterval(function () {
        for (var k = 0; k < Math.max(2, tris.length * 0.04); k++) {
          var j = Math.floor(r() * tris.length); turns[j] += 90; tris[j].style.transform = 'rotate(' + turns[j] + 'deg)';
        }
      }, 900);
      return { stop: function () { clearInterval(timer); } };
    }
    var step = name === 'isoBox' ? 160 : 0, last = 0, lit = 0;
    function frame(now) {
      var t = (now - t0) / 1000, p = {};
      for (var k in o) p[k] = o[k];
      if (name === 'interference') p.phase = t * 0.35;
      if (name === 'signalDecay') p.phase = t * 1.6;
      if (name === 'brokenRing') p.time = t * 0.12;
      if (name === 'isoBox') { if (now - last < step) { raf = requestAnimationFrame(frame); return; } last = now; p.lit = lit++; }
      el.innerHTML = gen(p);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return { stop: function () { cancelAnimationFrame(raf); } };
  }
  /* verdict(chip, v): switch a verdict chip; the glyph morphs, colors cross-fade. */
  var LABEL = { allow: 'Allow', hold: 'Hold', block: 'Block', explore: 'Exploring' };
  /* Same shapes as bundle.css; the attribute is the fallback where CSS d is unsupported. */
  var GLYPH = {
    allow: 'M0.53 6.07 L3.23 8.77 L4.57 7.43 L1.87 4.73 Z M4.62 8.71 L9.62 2.81 L8.18 1.59 L3.18 7.49 Z',
    hold: 'M1.60 1.00 L1.60 9.00 L4.00 9.00 L4.00 1.00 Z M6.00 1.00 L6.00 9.00 L8.40 9.00 L8.40 1.00 Z',
    block: 'M0.89 2.31 L7.69 9.11 L9.11 7.69 L2.31 0.89 Z M7.69 0.89 L0.89 7.69 L2.31 9.11 L9.11 2.31 Z',
    explore: 'M5.00 0.60 L9.40 5.00 L5.00 9.40 L0.60 5.00 Z M5.00 3.20 L3.20 5.00 L5.00 6.80 L6.80 5.00 Z'
  };
  function verdict(el, v) {
    el.className = el.className.replace(/cr-verdict--\w+/, 'cr-verdict--' + v);
    var l = el.querySelector('.cr-label'); if (l) l.textContent = LABEL[v];
    var p = el.querySelector('.cr-glyph path'); if (p) p.setAttribute('d', GLYPH[v]);
  }
  function chip(v) {
    return '<span class="cr-verdict cr-cut cr-verdict--' + v + '"><svg class="cr-glyph" viewBox="0 0 10 10" aria-hidden="true"><path d="' + GLYPH[v] + '"/></svg><span class="cr-label">' + LABEL[v] + '</span></span>';
  }
  window.Crystal = window.Crystal || {};
  window.Crystal.shader = shader;
  window.Crystal.patterns = api; api.play = play;
  window.Crystal.verdict = verdict; window.Crystal.chip = chip;
})();
