import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useAvatarPalette } from "./avatar-palette";
import fragment from "./effort-mesh.frag?raw";
import styles from "../ComposerModels.module.css";

// Convert sampled sRGB to Oklab once per portrait, never per animation frame.
function toOklab(color: string) {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Avatar artwork inside the control. A static gradient remains if WebGL fails. */
export function EffortMesh({
  avatarSrc,
  effort,
}: {
  avatarSrc: string | undefined;
  effort: number;
}) {
  const colors = useAvatarPalette(avatarSrc);
  const palette = useMemo(() => colors.map(toOklab), [colors]);
  const energy = (Math.max(0, Math.min(1, effort)) * 0.75) ** 1.5;
  const blur = 14 * (1 - 0.55 * energy);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const values = useRef({ palette, energy });
  const [revision, setRevision] = useState(0);
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    values.current = { palette, energy };
  }, [palette, energy]);
  const available = palette.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A restored WebGL context requires recreating every GPU resource.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !available) return;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
    if (!gl) return;
    const shaders: WebGLShader[] = [];
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    let frame = 0;
    let elapsed = 0;
    let last = 0;
    let visible = false;
    const release = () => {
      cancelAnimationFrame(frame);
      for (const shader of shaders) gl.deleteShader(shader);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Effort shader unavailable");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("Effort shader failed");
      return shader;
    };
    try {
      if (!program || !buffer) throw new Error("Effort renderer unavailable");
      gl.attachShader(
        program,
        compile(
          gl.VERTEX_SHADER,
          "#version 300 es\nin vec2 position; void main(){gl_Position=vec4(position,0.,1.);}",
        ),
      );
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error("Effort shader link failed");
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL method, not a React hook.
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      const position = gl.getAttribLocation(program, "position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    } catch {
      release();
      return;
    }
    if (!program) return;
    const uniform = {
      resolution: gl.getUniformLocation(program, "u_resolution"),
      time: gl.getUniformLocation(program, "u_time"),
      primary: gl.getUniformLocation(program, "u_primary"),
      secondary: gl.getUniformLocation(program, "u_secondary"),
      detail: gl.getUniformLocation(program, "u_detail"),
      energy: gl.getUniformLocation(program, "u_energy"),
      complexity: gl.getUniformLocation(program, "u_complexity"),
      contrast: gl.getUniformLocation(program, "u_contrast"),
      bend: gl.getUniformLocation(program, "u_bend"),
    };
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const forced = matchMedia("(forced-colors: active)");
    const draw = (time: number) => {
      const { energy, palette } = values.current;
      const [primary, secondary = primary, detail = secondary] = palette;
      if (!primary || !secondary || !detail || gl.isContextLost()) return;
      if (last)
        elapsed +=
          (Math.min(time - last, 50) / 1000) * 0.85 * (0.12 + 2.4 * energy);
      last = time;
      const ratio = Math.min(devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.uniform2f(uniform.resolution, width, height);
      gl.uniform1f(uniform.time, elapsed);
      gl.uniform3fv(uniform.primary, primary);
      gl.uniform3fv(uniform.secondary, secondary);
      gl.uniform3fv(uniform.detail, detail);
      gl.uniform1f(uniform.energy, energy);
      gl.uniform1f(uniform.complexity, 4 * (0.65 + 0.65 * energy));
      gl.uniform1f(uniform.contrast, 0.5 * energy);
      gl.uniform1f(uniform.bend, 0.15 + 1.35 * energy);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!visible) {
        visible = true;
        setPainted(true);
      }
      frame = requestAnimationFrame(draw);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      last = 0;
      const active =
        !reduced.matches &&
        !forced.matches &&
        !document.hidden &&
        !gl.isContextLost();
      visible = false;
      setPainted(false);
      if (active) frame = requestAnimationFrame(draw);
    };
    const lost = (event: Event) => {
      event.preventDefault();
      sync();
    };
    const restored = () => setRevision((value) => value + 1);
    reduced.addEventListener("change", sync);
    forced.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    sync();
    return () => {
      reduced.removeEventListener("change", sync);
      forced.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      release();
    };
  }, [available, revision]);
  return (
    <span
      className={styles.mesh}
      aria-hidden="true"
      style={
        {
          backgroundImage: colors.length
            ? `linear-gradient(90deg, ${colors.join(", ")})`
            : undefined,
          "--mesh-blur": `${blur}px`,
          "--mesh-bleed": `${blur * 3}px`,
        } as CSSProperties
      }
    >
      <canvas
        ref={canvasRef}
        className={styles.meshCanvas}
        style={{ visibility: painted && available ? "visible" : "hidden" }}
      />
    </span>
  );
}
