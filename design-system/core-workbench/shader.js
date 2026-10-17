// 浅色背景：单个 WebGL 画布。不可用或上下文丢失时，显示下方 CSS 静态背景。
(() => {
  'use strict';
  const canvas = document.getElementById('shader-canvas');
  const scene = document.getElementById('scene');
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const vertexSource = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
  const fragmentSource = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
      precision highp float;
    #else
      precision mediump float;
    #endif
    uniform vec2 u_res;
    uniform float u_time;
    vec2 hash2(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
      return fract(sin(p) * 43758.5453) * 2.0 - 1.0;
    }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(dot(hash2(i), f), dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
        mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
            dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
      float value = 0.0, amplitude = 0.5;
      for (int i = 0; i < 4; i++) {
        value += amplitude * noise(p);
        p = mat2(0.8, -0.6, 0.6, 0.8) * p * 2.03 + 3.1;
        amplitude *= 0.5;
      }
      return value;
    }
    void main() {
      vec2 uv = gl_FragCoord.xy / u_res;
      vec2 q = vec2(uv.x * u_res.x / u_res.y, uv.y);
      float t = u_time * 0.035;
      float f1 = fbm(q * 1.4 + vec2(t, -t * 0.4));
      float f2 = fbm(q * 1.7 + vec2(f1 * 1.8 - t * 0.3, f1 + t * 0.2));
      float field = fbm(q * 1.1 + f2 * 2.0);
      vec3 ivory = vec3(0.985, 0.975, 0.95);
      vec3 peach = vec3(0.98, 0.77, 0.64);
      vec3 sage = vec3(0.62, 0.81, 0.75);
      vec3 gold = vec3(0.98, 0.90, 0.70);
      float warm = smoothstep(-0.30, 0.34, field + (uv.x - 0.5) * 0.4);
      float cool = smoothstep(-0.18, 0.35, f2 - (uv.x - 0.5) * 0.5);
      vec3 col = mix(ivory, peach, warm * 0.64);
      col = mix(col, sage, cool * 0.62);
      col = mix(col, gold, smoothstep(0.0, 0.4, f1) * 0.34);
      float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      col += (grain - 0.5) * 0.008;
      gl_FragColor = vec4(col, 1.0);
    }
  `;
  let gl, program, buffer, resolution, time;
  let attempted = false, lost = false, inView = false, pageActive = true;
  let frame = 0, elapsed = 0, previous = null, lastDraw = -Infinity, dirty = true;

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previous = null;
  }
  function release() {
    if (!gl || lost) return;
    if (program) gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    program = buffer = null;
  }
  function compile(type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Shader unavailable');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      throw new Error('Shader compilation failed');
    }
    return shader;
  }
  function initialize() {
    if (program) return true;
    if (attempted || lost) return false;
    attempted = true;
    let vertex, fragment;
    try {
      gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
      if (!gl) throw new Error('WebGL unavailable');
      vertex = compile(gl.VERTEX_SHADER, vertexSource);
      fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
      program = gl.createProgram();
      if (!program) throw new Error('Program unavailable');
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Program linking failed');
      buffer = gl.createBuffer();
      if (!buffer) throw new Error('Buffer unavailable');
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      gl.useProgram(program);
      const position = gl.getAttribLocation(program, 'p');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      resolution = gl.getUniformLocation(program, 'u_res');
      time = gl.getUniformLocation(program, 'u_time');
      return true;
    } catch {
      release();
      canvas.dataset.state = 'fallback';
      return false;
    } finally {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
    }
  }
  function resize() {
    if (!gl || lost) return;
    const rect = scene.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, rect.width <= 640 ? 1 : 1.5);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      dirty = true;
    }
    gl.viewport(0, 0, width, height);
    gl.uniform2f(resolution, width, height);
  }
  function visible() {
    return root.dataset.theme === 'light' && !document.hidden && pageActive && inView && !lost;
  }
  function draw(seconds) {
    gl.uniform1f(time, seconds);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (canvas.dataset.state !== 'ready') canvas.dataset.state = 'ready';
    dirty = false;
  }
  function tick(now) {
    frame = 0;
    if (!visible() || reducedMotion.matches) return;
    if (previous !== null) elapsed += Math.min(now - previous, 100) / 1000;
    previous = now;
    if (now - lastDraw >= 1000 / 24) {
      draw(elapsed);
      lastDraw = now;
    }
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    stop();
    if (!visible() || !initialize()) return;
    resize();
    if (reducedMotion.matches) {
      if (dirty) draw(0);
      return;
    }
    if (dirty) draw(elapsed);
    frame = requestAnimationFrame(tick);
  }

  new IntersectionObserver((entries) => {
    inView = entries[0].isIntersecting;
    sync();
  }).observe(scene);
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('resize', sync);
  document.addEventListener('visibilitychange', sync);
  reducedMotion.addEventListener('change', () => { dirty = true; sync(); });
  window.addEventListener('pagehide', () => { pageActive = false; stop(); });
  window.addEventListener('pageshow', () => { pageActive = true; sync(); });
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    lost = true;
    stop();
    program = buffer = null;
    canvas.dataset.state = 'fallback';
  });
  canvas.addEventListener('webglcontextrestored', () => {
    lost = false;
    attempted = false;
    dirty = true;
    sync();
  });
})();
