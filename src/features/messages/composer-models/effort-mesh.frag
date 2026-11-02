#version 300 es
precision highp float;
uniform mediump vec2 u_resolution;
uniform float u_time;
uniform vec3 u_primary;
uniform vec3 u_secondary;
uniform vec3 u_detail;
uniform float u_complexity;
uniform float u_contrast;
uniform float u_bend;
uniform float u_energy;
out vec4 fragColor;

vec3 toSrgb(vec3 lab) {
  vec3 lms = vec3(
    lab.x + .3963377774 * lab.y + .2158037573 * lab.z,
    lab.x - .1055613458 * lab.y - .0638541728 * lab.z,
    lab.x - .0894841775 * lab.y - 1.291485548 * lab.z);
  lms = lms * lms * lms;
  vec3 rgb = clamp(vec3(
    4.0767416621*lms.x - 3.3077115913*lms.y + .2309699292*lms.z,
    -1.2684380046*lms.x + 2.6097574011*lms.y - .3413193965*lms.z,
    -.0041960863*lms.x - .7034186147*lms.y + 1.707614701*lms.z), 0., 1.);
  return mix(12.92 * rgb, 1.055 * pow(rgb, vec3(1./2.4)) - .055,
    step(vec3(.0031308), rgb));
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float t = u_time * 4.;
  // Independent moving centers replace the periodic wave: no parallel stripes.
  vec2 field = uv + u_bend * .12 * vec2(
    sin(uv.y * 5. + t * .71) + .4*cos(uv.x * 7. - t * .43),
    cos(uv.x * 4. - t * .63) + u_energy*.45*sin(uv.y*8. + t*.9));
  vec3 color = vec3(0.);
  float total = 0.;
  for (int i = 0; i < 6; i++) {
    float n = float(i);
    vec2 center = vec2(.12 + mod(n, 3.) * .38, .2 + floor(n / 3.) * .6);
    center += vec2((.12 + .22*u_energy)*sin(t*(.57 + n*.07) + n*2.1),
      (.2 + .22*u_energy)*cos(t*(.43 + n*.09) + n*1.7));
    vec2 delta = (field - center) * vec2(1.7, 1.4);
    // Bound the exponent so distant moving centers cannot produce black holes.
    float weight = exp(-min(10., dot(delta, delta) * (4. + u_complexity * 2.) * (1. + u_contrast)));
    // Stagger the colors across rows, with the avatar's primary color dominant.
    int slot = (i + i / 3) % 3;
    vec3 pigment = slot == 0 ? u_primary : slot == 1 ? u_secondary : u_detail;
    // Separate nearby avatar pigments perceptually as effort rises. Preserve
    // the primary hue; small adjacent hue shifts keep monochrome images lively.
    float angle = (slot == 0 ? 0. : slot == 1 ? .42 : -.42) * u_energy;
    pigment.yz = mat2(cos(angle), sin(angle), -sin(angle), cos(angle)) * pigment.yz;
    pigment.yz *= 1. + .65*u_energy;
    pigment.x = mix(pigment.x, slot == 0 ? .73 : slot == 1 ? .84 : .64, .8*u_energy);
    weight *= slot == 0 ? 1.3 : slot == 1 ? 1. : .7;
    color += pigment * weight;
    total += weight;
  }
  color /= max(total, .0001);
  fragColor = vec4(toSrgb(color), 1.);
}
