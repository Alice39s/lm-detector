/**
 * 像素风片元着色器（GLSL ES 1.0）。每个片元对应画布网格中的一格，
 * 画布再以 image-rendering: pixelated 放大，因此网格本身即像素风格。
 * 坐标原点在左下角；输出为预乘 alpha，颜色来自宿主元素的 currentColor。
 */
export const pixelPrelude = /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
uniform float u_time;
uniform float u_seed;
uniform vec4 u_color;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx + u_seed) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + 1.), f.x), f.y);
}
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2. + a.y * a.y * .75); }
float bayer4(vec2 a) { return bayer2(.5 * a) * .25 + bayer2(a); }
float steps(float fps) { return floor(u_time * fps) / fps; }
void ink(float a) {
  a = clamp(a, 0., 1.) * u_color.a;
  gl_FragColor = vec4(u_color.rgb * a, a);
}
`

/** 带断纹的嵌套指纹弧线与自上而下的扫描线，用于站点标识。 */
const fingerprint = /* glsl */ `
void main() {
  vec2 p = floor(gl_FragCoord.xy) + .5;
  vec2 uv = (p - u_res * .5) / (u_res.y * .5);
  float t = steps(12.);
  vec2 core = (uv - vec2(0., -.2)) * vec2(1.2, .9);
  float d = length(core) * 3.2 + sin(core.x * 3. + t * .8) * .08;
  float ring = floor(d);
  float ridge = step(.55, fract(d));
  float gap = step(.16, fract(atan(core.y, core.x) / 6.2831853 * (1. + ring) + hash(vec2(ring, 1.)) + t * .05 * (mod(ring, 2.) - .5)));
  float shape = step(length(uv * vec2(.95, .82)), 1.);
  float scan = u_res.y + 3. - mod(t * 7., u_res.y + 6.);
  float glow = max(0., 1. - abs(p.y - scan) / 2.5);
  ink(shape * (ridge * gap * (.5 + .5 * glow) + glow * .2));
}
`

/** 数字雨：列按随机速度下落，每轮随机启用。 */
const rain = /* glsl */ `
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float t = steps(20.);
  float h = hash(vec2(p.x, 7.));
  float len = 3. + floor(hash(vec2(p.x, 11.)) * 8.);
  float span = u_res.y + len * 2.;
  float travel = t * (5. + h * 9.) + h * 50.;
  float d = mod(travel, span) - len - (u_res.y - 1. - p.y);
  float active = step(.45, hash(vec2(p.x, floor(travel / span))));
  float trail = step(0., d) * step(d, len) * (1. - d / (len + 1.));
  float glyph = step(.3, hash(p + floor(t * 9.) * vec2(3., 1.)));
  float lead = step(0., d) * (1. - step(1., d));
  ink(active * max(trail * trail * glyph * .8, lead));
}
`

/** 往返扫描一排跳动的指纹条码，用于计算阶段。 */
const scan = /* glsl */ `
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float t = steps(24.);
  float col = floor(p.x / 3.);
  float cols = ceil(u_res.x / 3.);
  float h = floor((.2 + .8 * noise(vec2(col * .45, t * .8))) * u_res.y * .5 + .5);
  float bar = step(mod(p.x, 3.), 1.5) * step(abs(p.y + .5 - u_res.y * .5), h);
  float dist = abs(col - floor((.5 - .5 * cos(t * 1.3)) * cols));
  float lit = max(0., 1. - dist / 6.);
  ink(bar * (.22 + .78 * lit) + step(dist, .5) * .9);
}
`

/** 无信号雪花屏与滚动亮带，用于空状态和不可评分结果。 */
const staticNoise = /* glsl */ `
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float frame = floor(u_time * 15.);
  float n = hash(p + frame * vec2(17., 5.));
  float roll = fract(p.y / u_res.y * .6 - u_time * .18);
  float band = smoothstep(0., .08, roll) * (1. - smoothstep(.08, .25, roll));
  float glitch = step(.96, hash(vec2(floor(p.y / 2.), frame)));
  ink(step(.55 - band * .3, n) * (.35 + band * .5) + glitch * step(.5, n) * .4);
}
`

/** 行进的分段进度条与拖尾光标，用于正在取样的样本。 */
const march = /* glsl */ `
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float t = steps(24.);
  float seg = step(mod(p.x - floor(t * 16.), 8.), 3.5);
  float head = mod(t * u_res.x * .7, u_res.x * 1.6) - u_res.x * .3;
  float d = head - p.x;
  float tail = step(0., d) * max(0., 1. - d / (u_res.x * .35));
  ink(seg * (.25 + .75 * tail));
}
`

/** 位图块沿对角线逐块显现再擦除，用于数据载入。 */
const blocks = /* glsl */ `
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  vec2 b = floor(p / 4.);
  vec2 inner = mod(p, 4.);
  vec2 grid = ceil(u_res / 4.);
  float t = u_time * .4;
  float cycle = floor(t);
  float phase = fract(t) * 2.5;
  float order = (b.x + grid.y - b.y) / (grid.x + grid.y) * .75 + hash(b + cycle * 7.) * .25;
  float front = phase < 1.25 ? phase : phase - 1.25;
  float on = phase < 1.25 ? step(order, front) : step(front, order);
  float edge = step(abs(order - front), .04);
  float cellMask = step(inner.x, 2.5) * step(inner.y, 2.5);
  ink(cellMask * max(on * (.35 + .35 * hash(b + 3. + cycle)), edge));
}
`

/** 缓慢漂移的有序抖动，用于等待取样区域。 */
const dither = /* glsl */ `
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float t = steps(10.);
  float v = (.5 + .5 * sin((p.x + p.y) * .09 - t * 1.4)) * (.5 + .5 * sin(p.x * .021 + t * .5 + u_seed));
  ink(step(bayer4(p), v * .55));
}
`

/** 八格像素圆环加载指示。 */
const spinner = /* glsl */ `
void main() {
  vec2 p = floor(gl_FragCoord.xy) + .5;
  vec2 uv = (p - u_res * .5) / (u_res * .5);
  float r = length(uv);
  float d = fract(atan(uv.y, uv.x) / 6.2831853 + steps(12.) * 1.1);
  float ring = step(.5, r) * step(r, 1.05);
  ink(ring * max(.15, floor(d * 4.) / 4.));
}
`

/** 闪烁的像素星点与斜向微光，用于结果卡顶边。 */
const twinkle = /* glsl */ `
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float h = hash(p);
  float life = 1. - fract(u_time * (.3 + h * .7) + h * 7.);
  float spark = step(.82, hash(p + 9.)) * floor(life * 4.) / 4.;
  float shimmer = step(bayer4(p + vec2(floor(u_time * 8.), 0.)), .18);
  ink(max(spark, shimmer * .3));
}
`

export const pixelEffects = {
  fingerprint,
  rain,
  scan,
  static: staticNoise,
  march,
  blocks,
  dither,
  spinner,
  twinkle,
}

export type PixelEffect = keyof typeof pixelEffects
