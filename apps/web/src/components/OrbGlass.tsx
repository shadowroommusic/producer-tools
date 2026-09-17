/**
 * 球 v4 的 3D 玻璃珠（react-three-fiber + 自写 fresnel shader）。
 *
 * 规格：细玻璃描边环 + 内部小光核（白→青蓝径向）+ 2-3 颗极小高光粒子缓慢绕行；
 * 空闲整体 alpha≈0.35、不抢眼；说话亮 + 粒子外扩。reduced-motion 时停转静态。
 * 零 console error：所有 uniform 数值先过 Number.isFinite（P0 教训）。
 */
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const FINITE = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);

/** fresnel 玻璃材质：视线越掠射边缘越亮，中心透出内核。 */
const glassVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;
const glassFragment = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uLevel;
  uniform float uTime;
  void main() {
    float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 2.6);
    float pulse = 0.9 + 0.1 * sin(uTime * 1.2);
    vec3 color = uColor * (0.8 + uLevel * 0.6);
    float alpha = clamp(uAlpha * (0.35 + fresnel * 1.5) * pulse + uLevel * 0.25, 0.0, 1.0);
    gl_FragColor = vec4(color + vec3(fresnel * 0.35), alpha);
  }
`;

export function GlassSphere({
  level,
  listening,
  reducedMotion,
  colour,
}: {
  level: number;
  listening: boolean;
  reducedMotion: boolean;
  colour: string;
}) {
  const material = useRef<THREE.ShaderMaterial>(null);
  const sparksRef = useRef<THREE.Group>(null);
  const uniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Color(colour) },
      uAlpha: { value: 0.35 },
      uLevel: { value: 0 },
      uTime: { value: 0 },
    }),
    [],
  );
  const sparks = useMemo(
    () => [
      { tilt: 0.3, speed: 0.5, radius: 1.25, size: 0.05 },
      { tilt: -0.5, speed: -0.35, radius: 1.32, size: 0.04 },
      { tilt: 0.9, speed: 0.28, radius: 1.4, size: 0.035 },
    ],
    [],
  );
  const sparkRefs = useRef<Array<THREE.Mesh | null>>([]);

  useFrame((state, delta) => {
    const safeDelta = FINITE(delta, 0.016);
    const t = state.clock.elapsedTime;
    if (material.current !== null) {
      material.current.uniforms.uTime.value = FINITE(t, 0);
      material.current.uniforms.uLevel.value = FINITE(level, 0);
      material.current.uniforms.uAlpha.value = listening ? 0.75 : 0.35;
      material.current.uniforms.uColor.value.set(colour);
    }
    // 玻璃珠慢自转；reduced-motion 停。
    if (!reducedMotion) {
      if (sparksRef.current !== null) sparksRef.current.rotation.y += safeDelta * 0.4;
      for (const [index, spark] of sparks.entries()) {
        const mesh = sparkRefs.current[index];
        if (mesh === null || mesh === undefined) continue;
        const angle = t * spark.speed + index * 2.1;
        const x = Math.cos(angle) * spark.radius;
        const z = Math.sin(angle) * spark.radius;
        mesh.position.set(FINITE(x, 1), FINITE(Math.sin(angle * 0.7 + index) * 0.35, 0), FINITE(z, 1));
      }
    }
  });

  return (
    <group>
      {/* 玻璃壳 */}
      <mesh>
        <sphereGeometry args={[1, 48, 48]} />
        <shaderMaterial
          ref={material}
          vertexShader={glassVertex}
          fragmentShader={glassFragment}
          uniforms={uniforms}
          transparent
          depthWrite={false}
        />
      </mesh>
      {/* 内部小光核：白→青蓝径向渐变的 sprite 感小球 */}
      <mesh position={[-0.25, 0.28, 0.35]}>
        <sphereGeometry args={[0.34, 24, 24]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={listening ? 0.85 : 0.5} />
      </mesh>
      <mesh position={[-0.25, 0.28, 0.34]}>
        <sphereGeometry args={[0.5, 24, 24]} />
        <meshBasicMaterial color={colour} transparent opacity={listening ? 0.35 : 0.22} depthWrite={false} />
      </mesh>
      {/* 2-3 颗绕行高光粒子 */}
      <group ref={sparksRef}>
        {sparks.map((spark, index) => (
          <mesh
            key={index}
            ref={(mesh) => {
              sparkRefs.current[index] = mesh;
            }}
          >
            <sphereGeometry args={[spark.size, 12, 12]} />
            <meshBasicMaterial color="#e0f2fe" transparent opacity={0.9} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
