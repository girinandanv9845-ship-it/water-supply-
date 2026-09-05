/*
 * AquaFlow animated 3D water backdrop.
 *
 * A single fullscreen WebGL quad running a fragment shader: layered caustics,
 * a parallaxed depth field of rising bubbles, and a light shaft. Scrolling
 * drives a `depth` uniform, so the page reads as descending through water.
 *
 * Deliberately dependency-free (no Three.js): this is one quad and one shader,
 * about 6 KB, versus ~600 KB of library for effects we would not use.
 *
 * It degrades safely at every step:
 *   - no WebGL           -> animated CSS gradient
 *   - reduced motion     -> static gradient, no rAF loop
 *   - tab hidden / blur  -> loop paused
 *   - low frame rate     -> resolution scaled down, then the loop bails out
 */
(function (global) {
  'use strict';

  var VERT = [
    'attribute vec2 aPos;',
    'void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }',
  ].join('\n');

  var FRAG = [
    'precision mediump float;',
    'uniform vec2  uRes;',
    'uniform float uTime;',
    'uniform float uDepth;',     // 0..1 scroll progress
    'uniform float uIntensity;', // per-page strength
    'uniform vec3  uTop;',
    'uniform vec3  uBottom;',
    'uniform vec3  uGlow;',

    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',

    'float noise(vec2 p){',
    '  vec2 i = floor(p); vec2 f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),',
    '             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',

    'float fbm(vec2 p){',
    '  float v = 0.0; float a = 0.5;',
    '  for (int i = 0; i < 4; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; }',
    '  return v;',
    '}',

    // Refracted light on a water surface: warped noise, ridged to thin filaments.
    'float caustics(vec2 uv, float t){',
    '  float acc = 0.0;',
    '  for (int i = 1; i <= 3; i++){',
    '    float fi = float(i);',
    '    vec2 w = vec2(fbm(uv * fi * 1.6 + t * 0.20 + fi),',
    '                  fbm(uv * fi * 1.6 - t * 0.17 + fi * 3.7));',
    '    float n = fbm(uv * 2.2 * fi + w * 1.7);',
    '    acc += (1.0 - smoothstep(0.0, 0.42, abs(n - 0.5))) / fi;',
    '  }',
    '  return acc / 1.83;',
    '}',

    // Three parallax layers of rising bubbles; nearer layers move faster.
    'float bubbles(vec2 uv, float t, float depth){',
    '  float acc = 0.0;',
    '  for (int i = 1; i <= 3; i++){',
    '    float fi = float(i);',
    '    float scale = 3.0 + fi * 3.5;',
    '    vec2 g = uv * scale;',
    '    g.y -= t * (0.10 * fi) + depth * fi * 1.4;',
    '    vec2 id = floor(g);',
    '    vec2 f  = fract(g) - 0.5;',
    '    float h = hash(id + fi * 17.3);',
    '    float present = step(0.86, h);',
    '    vec2  jitter  = (vec2(fract(h * 13.1), fract(h * 7.7)) - 0.5) * 0.55;',
    '    float r = 0.045 + 0.075 * fract(h * 31.0);',
    '    float d = length(f - jitter);',
    '    float body = smoothstep(r, r * 0.15, d);',
    '    float rim  = smoothstep(r * 1.05, r * 0.75, d) - smoothstep(r * 0.75, r * 0.5, d);',
    '    acc += present * (body * 0.16 + rim * 0.30) / fi;',
    '  }',
    '  return acc;',
    '}',

    'void main(){',
    '  vec2 frag = gl_FragCoord.xy / uRes;',
    '  float aspect = uRes.x / max(uRes.y, 1.0);',
    '  vec2 uv = vec2(frag.x * aspect, frag.y);',
    '  float t = uTime;',

    // Vertical depth ramp, pushed further down as the page scrolls.
    '  float grad = clamp(frag.y - uDepth * 0.55, 0.0, 1.0);',
    '  vec3 col = mix(uBottom, uTop, pow(grad, 1.25));',

    // Caustics concentrate near the surface and fade with depth.
    '  float c = caustics(uv * 1.5 + vec2(0.0, uDepth * 1.2), t);',
    '  float surface = smoothstep(0.0, 1.0, grad);',
    '  col += uGlow * c * 0.34 * surface * uIntensity;',

    // A soft diagonal light shaft.
    '  float shaft = smoothstep(0.75, 0.0, abs(uv.x - (0.35 * aspect) - sin(t * 0.09) * 0.25));',
    '  col += uGlow * shaft * 0.055 * surface * uIntensity;',

    '  col += uGlow * bubbles(uv, t, uDepth) * 0.85 * uIntensity;',

    // Vignette keeps foreground text comfortable.
    '  vec2 v = frag - 0.5;',
    '  col *= 1.0 - dot(v, v) * 0.35;',

    // Dither: kills banding across the large gradient.
    '  col += (hash(frag * uRes + t) - 0.5) * 0.012;',

    '  gl_FragColor = vec4(col, 1.0);',
    '}',
  ].join('\n');

  function hexToRgb(hex) {
    var n = parseInt(hex.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('AquaScene shader error:', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  var PRESETS = {
    // Consumer-facing: richest treatment.
    customer: { intensity: 1.0, top: '#1b6d8c', bottom: '#05101c', glow: '#8fe6f7' },
    // Data-dense console: calmer, so tables stay the focus.
    admin: { intensity: 0.55, top: '#123c52', bottom: '#040c15', glow: '#63cfe6' },
    driver: { intensity: 0.8, top: '#175d78', bottom: '#050e18', glow: '#7fdff2' },
  };

  function cssFallback(canvas, preset) {
    canvas.style.background =
      'linear-gradient(180deg, ' + preset.top + ' 0%, ' + preset.bottom + ' 100%)';
    canvas.classList.add('scene-fallback');
  }

  function init(options) {
    options = options || {};
    var preset = PRESETS[options.preset || 'customer'] || PRESETS.customer;

    var canvas = document.createElement('canvas');
    canvas.className = 'scene3d';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(canvas, document.body.firstChild);

    var reduced =
      global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      cssFallback(canvas, preset);
      return { destroy: function () {}, mode: 'reduced-motion' };
    }

    var gl = null;
    try {
      gl =
        canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, powerPreference: 'low-power' }) ||
        canvas.getContext('experimental-webgl');
    } catch (e) {
      gl = null;
    }
    if (!gl) {
      cssFallback(canvas, preset);
      return { destroy: function () {}, mode: 'no-webgl' };
    }

    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) {
      cssFallback(canvas, preset);
      return { destroy: function () {}, mode: 'shader-error' };
    }

    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      cssFallback(canvas, preset);
      return { destroy: function () {}, mode: 'link-error' };
    }
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var uRes = gl.getUniformLocation(prog, 'uRes');
    var uTime = gl.getUniformLocation(prog, 'uTime');
    var uDepth = gl.getUniformLocation(prog, 'uDepth');
    var uIntensity = gl.getUniformLocation(prog, 'uIntensity');

    gl.uniform3fv(gl.getUniformLocation(prog, 'uTop'), hexToRgb(preset.top));
    gl.uniform3fv(gl.getUniformLocation(prog, 'uBottom'), hexToRgb(preset.bottom));
    gl.uniform3fv(gl.getUniformLocation(prog, 'uGlow'), hexToRgb(preset.glow));
    gl.uniform1f(gl.getUniformLocation(prog, 'uIntensity'), preset.intensity);

    // Render scale is adaptive: this is a soft, blurry scene, so running it
    // below device resolution is invisible but much cheaper on phones.
    var scale = global.innerWidth < 900 ? 0.5 : 0.7;

    function resize() {
      var w = Math.max(1, Math.floor(global.innerWidth * scale));
      var h = Math.max(1, Math.floor(global.innerHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
        gl.uniform2f(uRes, w, h);
      }
    }
    resize();

    // Scroll -> depth, eased so the backdrop lags the content slightly.
    var targetDepth = 0;
    var depth = 0;

    function readScroll() {
      var doc = document.documentElement;
      var max = Math.max(1, doc.scrollHeight - global.innerHeight);
      targetDepth = Math.min(1, Math.max(0, (global.scrollY || doc.scrollTop || 0) / max));
    }

    // Any scrollable pane (the admin console scrolls an inner element) feeds
    // the same uniform, so the effect is consistent across all three apps.
    function onAnyScroll(e) {
      if (e && e.target && e.target !== document && e.target.scrollHeight) {
        var el = e.target;
        var m = Math.max(1, el.scrollHeight - el.clientHeight);
        if (m > 40) {
          targetDepth = Math.min(1, Math.max(0, el.scrollTop / m));
          return;
        }
      }
      readScroll();
    }

    var running = true;
    var raf = null;
    var start = performance.now();
    var slowFrames = 0;
    var last = start;

    function frame(now) {
      if (!running) return;
      raf = requestAnimationFrame(frame);

      var dt = now - last;
      last = now;

      // Two-stage guard: drop resolution once, then stop entirely rather than
      // making the whole UI janky on a weak device.
      if (dt > 34) {
        slowFrames++;
        if (slowFrames === 90 && scale > 0.34) {
          scale = 0.34;
          resize();
        } else if (slowFrames > 260) {
          running = false;
          cancelAnimationFrame(raf);
          cssFallback(canvas, preset);
          return;
        }
      } else if (slowFrames > 0) {
        slowFrames--;
      }

      depth += (targetDepth - depth) * 0.06;
      gl.uniform1f(uTime, (now - start) / 1000);
      gl.uniform1f(uDepth, depth);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    raf = requestAnimationFrame(frame);

    function onVisibility() {
      if (document.hidden) {
        running = false;
        if (raf) cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    }

    /**
     * The browser can take the GL context away at any time - too many WebGL
     * tabs open, a GPU driver reset, or the OS reclaiming resources. Without
     * this the canvas would simply freeze on its last frame or go black, so
     * drop to the CSS gradient instead.
     */
    function onContextLost(e) {
      e.preventDefault();
      running = false;
      if (raf) cancelAnimationFrame(raf);
      cssFallback(canvas, preset);
    }
    canvas.addEventListener('webglcontextlost', onContextLost, false);

    global.addEventListener('resize', resize, { passive: true });
    global.addEventListener('scroll', readScroll, { passive: true });
    document.addEventListener('scroll', onAnyScroll, { passive: true, capture: true });
    document.addEventListener('visibilitychange', onVisibility);
    readScroll();

    return {
      mode: 'webgl',
      destroy: function () {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        global.removeEventListener('resize', resize);
        global.removeEventListener('scroll', readScroll);
        document.removeEventListener('scroll', onAnyScroll, true);
        document.removeEventListener('visibilitychange', onVisibility);
        canvas.removeEventListener('webglcontextlost', onContextLost);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
    };
  }

  global.AquaScene = { init: init, PRESETS: PRESETS };
})(window);
