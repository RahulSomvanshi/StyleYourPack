'use client';

/**
 * BoxCanvas — interactive 3D mailer box preview.
 *
 * - Box geometry is driven live by Length × Width × Height (inches).
 * - Three finishes (kraft / matte / glossy) map to physical material settings.
 * - Any number of artworks can be projected onto any face (top, front, back,
 *   left, right) with drei <Decal>, each with its own size, offset and rotation.
 * - Studio HDRI lighting, soft contact shadows, and OrbitControls.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { ContactShadows, Decal, Environment, OrbitControls } from '@react-three/drei';

export type MaterialId = 'kraft' | 'matte-white' | 'glossy';
export type Face = 'top' | 'front' | 'back' | 'left' | 'right';

export interface ArtworkPlacement {
  id: string;
  /** Object URL / data URL of the image (PNG/JPG/WebP) */
  url: string;
  face: Face;
  /** Artwork width as a fraction of the face width (0.1–1) */
  size: number;
  /** Offset from the face centre as a fraction of the face (-0.5–0.5); +x = right, +y = up when facing it */
  offsetX: number;
  offsetY: number;
  /** In-plane rotation in degrees, clockwise */
  rotation: number;
}

export interface BoxCanvasProps {
  /** Dimensions in inches */
  length: number;
  width: number;
  height: number;
  /** Outer base colour (hex) */
  color: string;
  material: MaterialId;
  artworks: ArtworkPlacement[];
  className?: string;
}

/** 1 inch = 0.1 scene units, so a 16" box spans 1.6 units. */
const INCH = 0.1;

/** Physical material presets per finish. */
const FINISHES: Record<
  MaterialId,
  { roughness: number; metalness: number; clearcoat: number; clearcoatRoughness: number }
> = {
  kraft: { roughness: 0.95, metalness: 0, clearcoat: 0, clearcoatRoughness: 1 },
  'matte-white': { roughness: 0.78, metalness: 0, clearcoat: 0, clearcoatRoughness: 1 },
  glossy: { roughness: 0.28, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.08 },
};

/* ------------------------------------------------------------------ */
/* Face frames                                                        */
/* ------------------------------------------------------------------ */

interface FaceFrame {
  /** Orientation whose local +Z is the face's outward normal */
  rotation: THREE.Euler;
  center: THREE.Vector3;
  /** World directions of the face's "right" and "up" as seen from outside */
  u: THREE.Vector3;
  v: THREE.Vector3;
  faceW: number;
  faceH: number;
}

/** Box is centred at the origin: x = length, y = height, z = width. */
function getFaceFrame(face: Face, L: number, H: number, W: number): FaceFrame {
  switch (face) {
    case 'top':
      return {
        rotation: new THREE.Euler(-Math.PI / 2, 0, 0),
        center: new THREE.Vector3(0, H / 2, 0),
        u: new THREE.Vector3(1, 0, 0),
        v: new THREE.Vector3(0, 0, -1),
        faceW: L,
        faceH: W,
      };
    case 'front':
      return {
        rotation: new THREE.Euler(0, 0, 0),
        center: new THREE.Vector3(0, 0, W / 2),
        u: new THREE.Vector3(1, 0, 0),
        v: new THREE.Vector3(0, 1, 0),
        faceW: L,
        faceH: H,
      };
    case 'back':
      return {
        rotation: new THREE.Euler(0, Math.PI, 0),
        center: new THREE.Vector3(0, 0, -W / 2),
        u: new THREE.Vector3(-1, 0, 0),
        v: new THREE.Vector3(0, 1, 0),
        faceW: L,
        faceH: H,
      };
    case 'right':
      return {
        rotation: new THREE.Euler(0, Math.PI / 2, 0),
        center: new THREE.Vector3(L / 2, 0, 0),
        u: new THREE.Vector3(0, 0, -1),
        v: new THREE.Vector3(0, 1, 0),
        faceW: W,
        faceH: H,
      };
    case 'left':
      return {
        rotation: new THREE.Euler(0, -Math.PI / 2, 0),
        center: new THREE.Vector3(-L / 2, 0, 0),
        u: new THREE.Vector3(0, 0, 1),
        v: new THREE.Vector3(0, 1, 0),
        faceW: W,
        faceH: H,
      };
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * Turns a placement into decal position / rotation / scale (mesh-local space).
 * The artwork is kept fully inside its face, even when rotated, so it never
 * smears around an edge.
 */
function computeDecalTransform(art: ArtworkPlacement, aspect: number, L: number, H: number, W: number) {
  const frame = getFaceFrame(art.face, L, H, W);
  const maxW = frame.faceW * 0.98;
  const maxH = frame.faceH * 0.98;
  const theta = THREE.MathUtils.degToRad(art.rotation);
  const cos = Math.abs(Math.cos(theta));
  const sin = Math.abs(Math.sin(theta));

  let sx = clamp(art.size, 0.05, 1) * maxW;
  let sy = sx / aspect;

  // Shrink until the rotated bounding box fits inside the face
  const fit = Math.min(1, maxW / (sx * cos + sy * sin), maxH / (sx * sin + sy * cos));
  sx *= fit;
  sy *= fit;
  const boundW = sx * cos + sy * sin;
  const boundH = sx * sin + sy * cos;

  const maxOx = Math.max(0, (maxW - boundW) / 2);
  const maxOy = Math.max(0, (maxH - boundH) / 2);
  const ox = clamp(art.offsetX * frame.faceW, -maxOx, maxOx);
  const oy = clamp(art.offsetY * frame.faceH, -maxOy, maxOy);

  const position = frame.center
    .clone()
    .addScaledVector(frame.u, ox)
    .addScaledVector(frame.v, oy);

  // Face orientation, then spin around the face normal (negative = clockwise)
  const quat = new THREE.Quaternion()
    .setFromEuler(frame.rotation)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -theta));
  const rotation = new THREE.Euler().setFromQuaternion(quat);

  // Shallow projector depth so it only hits the target face
  const depth = Math.min(0.05, Math.min(L, H, W) * 0.4);

  return { position, rotation, scale: new THREE.Vector3(sx, sy, depth) };
}

/* ------------------------------------------------------------------ */
/* Hooks                                                              */
/* ------------------------------------------------------------------ */

/**
 * Loads and caches one texture per URL. Removed URLs are disposed, and textures
 * survive box resizes, so artwork doesn't flicker while dragging sliders.
 */
function useTextureMap(urls: string[]) {
  const cache = useRef(new Map<string, THREE.Texture>());
  const wanted = useRef(new Set<string>());
  const [, setVersion] = useState(0);
  const key = urls.join('|');

  useEffect(() => {
    wanted.current = new Set(key ? key.split('|') : []);

    for (const [url, tex] of cache.current) {
      if (!wanted.current.has(url)) {
        tex.dispose();
        cache.current.delete(url);
      }
    }

    const loader = new THREE.TextureLoader();
    wanted.current.forEach((url) => {
      if (cache.current.has(url)) return;
      loader.load(url, (tex) => {
        if (!wanted.current.has(url) || cache.current.has(url)) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        cache.current.set(url, tex);
        setVersion((v) => v + 1);
      });
    });
  }, [key]);

  useEffect(() => {
    const textures = cache.current;
    return () => {
      textures.forEach((t) => t.dispose());
      textures.clear();
    };
  }, []);

  return cache.current;
}

/** Procedural paper-fibre bump map, so kraft reads as board rather than plastic. */
function useKraftGrain(enabled: boolean) {
  const texture = useMemo(() => {
    if (!enabled || typeof document === 'undefined') return null;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const img = ctx.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 190 + Math.random() * 65;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    return tex;
  }, [enabled]);

  useEffect(() => () => texture?.dispose(), [texture]);
  return texture;
}

/* ------------------------------------------------------------------ */
/* Mailer box mesh                                                    */
/* ------------------------------------------------------------------ */

interface MailerBoxProps {
  length: number;
  width: number;
  height: number;
  color: string;
  material: MaterialId;
  artworks: ArtworkPlacement[];
  textures: Map<string, THREE.Texture>;
}

function ArtworkDecal({
  art,
  texture,
  L,
  H,
  W,
}: {
  art: ArtworkPlacement;
  texture: THREE.Texture;
  L: number;
  H: number;
  W: number;
}) {
  const img = texture.image as { width?: number; height?: number } | undefined;
  const aspect = img?.width && img?.height ? img.width / img.height : 1;
  const t = computeDecalTransform(art, aspect, L, H, W);

  return (
    <Decal
      position={t.position}
      rotation={t.rotation}
      scale={t.scale}
      map={texture}
      // drei disables depthTest by default, which would show back-face art through the box
      depthTest
      polygonOffsetFactor={-4}
    />
  );
}

function MailerBox({ length, width, height, color, material, artworks, textures }: MailerBoxProps) {
  // Scene-space dimensions: x = length, y = height, z = width
  const L = length * INCH;
  const H = height * INCH;
  const W = width * INCH;

  const finish = FINISHES[material];
  const grain = useKraftGrain(material === 'kraft');

  // Front tuck-flap of the lid gives the classic mailer-box silhouette
  const flapH = Math.min(H * 0.35, 0.12);
  const flapT = 0.006;

  return (
    // Box is centred at the origin (decal maths stays in mesh space); lift it onto the floor
    <group position={[0, H / 2, 0]}>
      {/* Keyed by size: geometry and every projected decal rebuild when a dimension changes */}
      <mesh key={`${L}-${W}-${H}`} castShadow receiveShadow>
        <boxGeometry args={[L, H, W]} />
        {/* Keyed by finish: shader defines (clearcoat / bumpMap) recompile on switch */}
        <meshPhysicalMaterial
          key={material}
          color={color}
          {...finish}
          bumpMap={grain}
          bumpScale={grain ? 0.0015 : 0}
        />

        {artworks.map((art) => {
          const texture = textures.get(art.url);
          return texture ? <ArtworkDecal key={art.id} art={art} texture={texture} L={L} H={H} W={W} /> : null;
        })}
      </mesh>

      {/* Lid front flap */}
      <mesh position={[0, H / 2 - flapH / 2, W / 2 + flapT / 2]} castShadow>
        <boxGeometry args={[L * 0.985, flapH, flapT]} />
        <meshPhysicalMaterial key={material} color={color} {...finish} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Canvas / scene                                                     */
/* ------------------------------------------------------------------ */

export default function BoxCanvas({
  length,
  width,
  height,
  color,
  material,
  artworks,
  className,
}: BoxCanvasProps) {
  const textures = useTextureMap(artworks.map((a) => a.url));

  return (
    <Canvas
      className={className}
      shadows
      dpr={[1, 2]}
      camera={{ position: [2.4, 1.8, 2.6], fov: 35 }}
      // preserveDrawingBuffer lets you snapshot the canvas later (e.g. for a PDF proof)
      gl={{ antialias: true, preserveDrawingBuffer: true }}
    >
      {/* Dark-studio lighting: soft fill + key, a warm amber rim from behind, plus an HDRI for reflections */}
      <ambientLight intensity={0.3} />
      <directionalLight position={[4, 6, 3]} intensity={1.4} />
      <spotLight position={[-4, 3, -4]} intensity={2.2} angle={0.5} penumbra={1} color="#f5a524" />
      <pointLight position={[0, 0.15, 0]} intensity={0.4} distance={3} color="#f5a524" />
      <Suspense fallback={null}>
        <Environment preset="studio" environmentIntensity={0.7} />
      </Suspense>

      {/* Faint amber glow ring on the floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0005, 0]}>
        <ringGeometry args={[1.25, 1.27, 128]} />
        <meshBasicMaterial color="#f5a524" transparent opacity={0.18} />
      </mesh>

      <MailerBox
        length={length}
        width={width}
        height={height}
        color={color}
        material={material}
        artworks={artworks}
        textures={textures}
      />

      {/* Soft grounded shadow under the box */}
      <ContactShadows position={[0, 0.001, 0]} opacity={0.85} scale={6} blur={2.4} far={2} color="#000000" />

      <OrbitControls
        makeDefault
        enablePan={false}
        minDistance={1.2}
        maxDistance={7}
        maxPolarAngle={Math.PI / 2.05}
        target={[0, (height * INCH) / 2, 0]}
      />
    </Canvas>
  );
}
