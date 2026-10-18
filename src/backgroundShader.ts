// Warm ivory, peach and sage domain-warped fbm from the approved workbench prototype.
export const vertexSource = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
export const fragmentSource = `
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
