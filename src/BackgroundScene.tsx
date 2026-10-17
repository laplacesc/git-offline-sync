import { useEffect, useRef } from "react";
import { fragmentSource, vertexSource } from "./backgroundShader";

/** Decorative only: CSS remains visible whenever WebGL cannot render. */
export function BackgroundScene() {
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const scene = sceneRef.current!;
    const canvas = canvasRef.current!;
    const root = document.documentElement;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let gl: WebGLRenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    let resolution: WebGLUniformLocation | null = null;
    let time: WebGLUniformLocation | null = null;
    let attempted = false, lost = false, disposed = false;
    let inView = typeof IntersectionObserver === "undefined", pageActive = true;
    let frame = 0, elapsed = 0, previous: number | null = null;
    let lastDraw = -Infinity, dirty = true;
    canvas.dataset.state = "fallback";

    function stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      previous = null;
    }
    function release() {
      if (gl && !lost) {
        gl.useProgram(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        if (program) gl.deleteProgram(program);
        if (buffer) gl.deleteBuffer(buffer);
      }
      program = buffer = null;
      resolution = time = null;
    }
    function compile(context: WebGLRenderingContext, type: number, source: string) {
      const shader = context.createShader(type);
      if (!shader) throw new Error("Shader unavailable");
      context.shaderSource(shader, source);
      context.compileShader(shader);
      if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
        context.deleteShader(shader);
        throw new Error("Shader compilation failed");
      }
      return shader;
    }
    function initialize() {
      if (program) return true;
      if (attempted || lost) return false;
      attempted = true;
      let vertex: WebGLShader | null = null, fragment: WebGLShader | null = null;
      try {
        gl = canvas.getContext("webgl", {
          alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power",
        });
        if (!gl) return false;
        // A real context loss can occur between effect cleanup and its next setup.
        if (gl.isContextLost()) { lost = true; return false; }
        vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
        fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
        program = gl.createProgram();
        if (!program) throw new Error("Program unavailable");
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Program linking failed");
        buffer = gl.createBuffer();
        if (!buffer) throw new Error("Buffer unavailable");
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        gl.useProgram(program);
        const position = gl.getAttribLocation(program, "p");
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        resolution = gl.getUniformLocation(program, "u_res");
        time = gl.getUniformLocation(program, "u_time");
        return true;
      } catch {
        release();
        canvas.dataset.state = "fallback";
        return false;
      } finally {
        if (vertex) gl?.deleteShader(vertex);
        if (fragment) gl?.deleteShader(fragment);
      }
    }
    function resize() {
      if (!gl || lost) return;
      const rect = scene.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, rect.width <= 640 ? 1 : 1.5);
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
      return !disposed && root.dataset.theme === "light" && !document.hidden && pageActive && inView && !lost;
    }
    function draw(seconds: number) {
      if (!gl || !program || lost) return;
      gl.uniform1f(time, seconds);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      canvas.dataset.state = "ready";
      dirty = false;
    }
    function tick(now: number) {
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
      if (dirty) {
        draw(reducedMotion.matches ? 0 : elapsed);
        lastDraw = performance.now();
      }
      if (!reducedMotion.matches) frame = requestAnimationFrame(tick);
    }
    const onReduction = () => { dirty = true; sync(); };
    const onPageHide = () => { pageActive = false; stop(); };
    const onPageShow = () => { pageActive = true; sync(); };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      stop();
      release();
      canvas.dataset.state = "fallback";
    };
    const onContextRestored = () => {
      lost = false;
      attempted = false;
      dirty = true;
      sync();
    };
    const intersection = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      sync();
    });
    const mutation = new MutationObserver(sync);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    intersection?.observe(scene);
    mutation.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    resizeObserver?.observe(scene);
    window.addEventListener("resize", sync);
    document.addEventListener("visibilitychange", sync);
    reducedMotion.addEventListener("change", onReduction);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    sync();
    return () => {
      disposed = true;
      stop();
      intersection?.disconnect();
      mutation.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", sync);
      document.removeEventListener("visibilitychange", sync);
      reducedMotion.removeEventListener("change", onReduction);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      release();
      // Do not call WEBGL_lose_context: StrictMode reuses this canvas on setup.
      gl = null;
      canvas.dataset.state = "fallback";
    };
  }, []);

  return <div ref={sceneRef} className="background-scene" aria-hidden="true">
    <canvas ref={canvasRef} className="background-canvas" data-state="fallback" />
  </div>;
}
