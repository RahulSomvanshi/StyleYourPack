'use client';

/**
 * BoxCanvas — interactive 3D mailer box preview.
 *
 * - The box is built from real panels (walls, floor, hinged lid + front flap),
 *   sized live from Length × Width × Height (inches). The lid opens on demand.
 * - Three finishes (kraft / matte / glossy) map to physical material settings.
 * - Any number of artworks can be projected onto any outside or inside face with
 *   drei <Decal>, each with its own size, offset and rotation.
 * - Flexo (single ink) printing tints artwork to the chosen ink; offset keeps full colour.
 * - Camera commands: jump to a side, zoom, reset, auto-rotate.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, Decal, Environment, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

export type MaterialId = 'kraft' | 'matte-white' | 'glossy';
export type OutsideFace = 'top' | 'front' | 'back' | 'left' | 'right';
export type InsideFace = 'inside-lid' | 'inside-bottom' | 'inside-front' | 'inside-back' | 'inside-left' | 'inside-right';
export type Face = OutsideFace | InsideFace;

export interface ArtworkPlacement {
  id: string;
  /** Object URL / data URL of the image (PNG/JPG/WebP), or a rendered text image */
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

export interface CanvasCommand {
  type: 'reset' | 'zoom-in' | 'zoom-out' | 'view';
  face?: Face;
  /** Changes on every request so repeated commands still fire */
  nonce: number;
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
  /** Single ink colour for flexo printing; null = full colour (offset) */
  inkColor?: string | null;
  /** Metallic ink (gold / silver) */
  inkMetallic?: boolean;
  lidOpen?: boolean;
  autoRotate?: boolean;
  command?: CanvasCommand | null;
  className?: string;
}

/** 1 inch = 0.1 scene units, so a 16" box spans 1.6 units. */
const INCH = 0.1;
/** Board thickness (~3 mm corrugated). */
const BOARD = 0.012;
/** How far the lid swings open, in radians. */
const LID_OPEN_ANGLE = THREE.MathUtils.degToRad(105);

/** Physical material presets per finish. */
const FINISHES: Record<
  MaterialId,
  { roughness: number; metalness: number; clearcoat: number; clearcoatRoughness: number }
> = {
  kraft: { roughness: 0.95, metalness: 0, clearcoat: 0, clearcoatRoughness: 1 },
  'matte-white': { roughness: 0.78, metalness: 0, clearcoat: 0, clearcoatRoughness: 1 },
  glossy: { roughness: 0.28, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.08 },
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/* ------------------------------------------------------------------ */
/* Panels and faces                                                   */
/* ------------------------------------------------------------------ */

type PanelId = 'lid' | 'bottom' | 'front' | 'back' | 'left' | 'right';
type V3 = [number, number, number];

/**
 * Which panel each printable face lives on, plus its outward normal `n` and the
 * "right" (u) / "up" (v) directions as seen when looking at it (u × v = n).
 * All vectors are in the panel's own (unrotated) frame.
 */
const FACE_DEFS: Record<Face, { panel: PanelId; n: V3; u: V3; v: V3 }> = {
  top: { panel: 'lid', n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  front: { panel: 'front', n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  back: { panel: 'back', n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  right: { panel: 'right', n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  left: { panel: 'left', n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  'inside-lid': { panel: 'lid', n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  'inside-bottom': { panel: 'bottom', n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  'inside-front': { panel: 'front', n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  'inside-back': { panel: 'back', n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  'inside-left': { panel: 'left', n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  'inside-right': { panel: 'right', n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
};

/** Camera direction (from box centre) used when jumping to a face. */
const VIEW_DIRS: Record<Face | 'default', V3> = {
  default: [2.4, 1.8, 2.6],
  top: [0, 1, 0.18],
  front: [0, 0.3, 1],
  back: [0, 0.3, -1],
  left: [-1, 0.3, 0],
  right: [1, 0.3, 0],
  'inside-lid': [0, 0.55, 1],
  'inside-bottom': [0, 1, 0.45],
  'inside-front': [0, 1, -0.35],
  'inside-back': [0, 0.8, 0.75],
  'inside-left': [0.8, 0.9, 0.15],
  'inside-right': [-0.8, 0.9, 0.15],
};

function panelSizes(L: number, H: number, W: number): Record<PanelId, V3> {
  const T = BOARD;
  const wallH = H - T; // walls stop under the lid
  return {
    lid: [L, T, W],
    bottom: [L - 2 * T, T, W - 2 * T],
    front: [L, wallH, T],
    back: [L, wallH, T],
    left: [T, wallH, W - 2 * T],
    right: [T, wallH, W - 2 * T],
  };
}

const dot = (a: V3, b: V3) => Math.abs(a[0]) * b[0] + Math.abs(a[1]) * b[1] + Math.abs(a[2]) * b[2];
const vec = (a: V3) => new THREE.Vector3(...a);

/**
 * Turns a placement into decal position / rotation / scale in its panel's local space.
 * The artwork is kept fully inside its face, even when rotated, so it never wraps an edge.
 */
function computeDecalTransform(art: ArtworkPlacement, aspect: number, size: V3) {
  const def = FACE_DEFS[art.face];
  const faceW = dot(def.u, size);
  const faceH = dot(def.v, size);
  const maxW = faceW * 0.96;
  const maxH = faceH * 0.96;
  const theta = THREE.MathUtils.degToRad(art.rotation);
  const cos = Math.abs(Math.cos(theta));
  const sin = Math.abs(Math.sin(theta));

  let sx = clamp(art.size, 0.05, 1) * maxW;
  let sy = sx / aspect;
  const fit = Math.min(1, maxW / (sx * cos + sy * sin), maxH / (sx * sin + sy * cos));
  sx *= fit;
  sy *= fit;
  const boundW = sx * cos + sy * sin;
  const boundH = sx * sin + sy * cos;

  const ox = clamp(art.offsetX * faceW, -Math.max(0, (maxW - boundW) / 2), Math.max(0, (maxW - boundW) / 2));
  const oy = clamp(art.offsetY * faceH, -Math.max(0, (maxH - boundH) / 2), Math.max(0, (maxH - boundH) / 2));

  // Surface centre = half the panel thickness along the normal
  const position = new THREE.Vector3(
    (def.n[0] * size[0]) / 2,
    (def.n[1] * size[1]) / 2,
    (def.n[2] * size[2]) / 2,
  )
    .addScaledVector(vec(def.u), ox)
    .addScaledVector(vec(def.v), oy);

  // Basis (u, v, n) orients the projector; then spin it around the normal (negative = clockwise)
  const basis = new THREE.Matrix4().makeBasis(vec(def.u), vec(def.v), vec(def.n));
  const quat = new THREE.Quaternion()
    .setFromRotationMatrix(basis)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -theta));
  const rotation = new THREE.Euler().setFromQuaternion(quat);

  // Projector depth below the board thickness, so it never prints through to the other side
  return { position, rotation, scale: new THREE.Vector3(sx, sy, BOARD) };
}

/* ------------------------------------------------------------------ */
/* Textures                                                           */
/* ------------------------------------------------------------------ */

interface TextureSpec {
  key: string;
  url: string;
  ink: string | null;
}

const textureKey = (url: string, ink: string | null) => `${url}|${ink ?? ''}`;

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Flexo preview: repaints the artwork in a single ink. Transparent PNGs use their alpha as the
 * ink mask; opaque images use darkness (light backgrounds drop out, like real one-colour print).
 */
function tintToInk(img: HTMLImageElement, ink: string) {
  const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.drawImage(img, 0, 0, w, h);

  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  let hasAlpha = false;
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] < 250) {
      hasAlpha = true;
      break;
    }
  }

  const c = new THREE.Color(ink);
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  for (let i = 0; i < px.length; i += 4) {
    const lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
    const mask = hasAlpha ? px[i + 3] / 255 : clamp((0.78 - lum) / 0.28, 0, 1);
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = Math.round(mask * 255);
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/**
 * Loads and caches one texture per (image, ink). Removed entries are disposed, and textures
 * survive box resizes, so artwork doesn't flicker while dragging sliders.
 */
function useArtworkTextures(specs: TextureSpec[]) {
  const cache = useRef(new Map<string, THREE.Texture>());
  const wanted = useRef(new Map<string, TextureSpec>());
  const [, setVersion] = useState(0);
  const signature = specs.map((s) => s.key).join('\n');

  useEffect(() => {
    wanted.current = new Map(specs.map((s) => [s.key, s]));

    for (const [key, tex] of cache.current) {
      if (!wanted.current.has(key)) {
        tex.dispose();
        cache.current.delete(key);
      }
    }

    wanted.current.forEach((spec, key) => {
      if (cache.current.has(key)) return;
      loadImage(spec.url)
        .then((img) => {
          if (!wanted.current.has(key) || cache.current.has(key)) return;
          const tex = spec.ink ? new THREE.CanvasTexture(tintToInk(img, spec.ink)) : new THREE.Texture(img);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          tex.needsUpdate = true;
          cache.current.set(key, tex);
          setVersion((v) => v + 1);
        })
        .catch(() => {
          /* unreadable image: skip it */
        });
    });
    // `signature` captures every spec key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

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
/* Mailer box                                                         */
/* ------------------------------------------------------------------ */

interface BoardLook {
  color: string;
  material: MaterialId;
  grain: THREE.Texture | null;
}

function BoardMaterial({ color, material, grain }: BoardLook) {
  return (
    // Keyed by finish: shader defines (clearcoat / bumpMap) recompile on switch
    <meshPhysicalMaterial
      key={material}
      color={color}
      {...FINISHES[material]}
      bumpMap={grain}
      bumpScale={grain ? 0.0015 : 0}
    />
  );
}

function ArtworkDecal({
  art,
  texture,
  size,
  metallic,
}: {
  art: ArtworkPlacement;
  texture: THREE.Texture;
  size: V3;
  metallic: boolean;
}) {
  const img = texture.image as { width?: number; height?: number } | undefined;
  const aspect = img?.width && img?.height ? img.width / img.height : 1;
  const t = computeDecalTransform(art, aspect, size);

  return (
    // The child material replaces drei's default one, so map / depthTest / polygon offset are set on it
    // directly (and mirrored on <Decal> so drei's own props agree). depthTest stays on, so inside art
    // never shows through the walls.
    <Decal
      position={t.position}
      rotation={t.rotation}
      scale={t.scale}
      map={texture}
      depthTest
      polygonOffsetFactor={-4}
    >
      <meshStandardMaterial
        map={texture}
        transparent
        depthTest
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-4}
        metalness={metallic ? 0.7 : 0}
        roughness={metallic ? 0.32 : 0.8}
        // Metallic ink needs a strong reflection to read as gold / silver rather than dark brown
        envMapIntensity={metallic ? 3.5 : 1}
      />
    </Decal>
  );
}

interface PanelProps {
  id: PanelId;
  size: V3;
  position: V3;
  look: BoardLook;
  artworks: ArtworkPlacement[];
  textures: Map<string, THREE.Texture>;
  ink: string | null;
  metallic: boolean;
}

function Panel({ id, size, position, look, artworks, textures, ink, metallic }: PanelProps) {
  return (
    // Keyed by size: geometry and every projected decal rebuild when a dimension changes
    <mesh key={`${id}-${size.join('x')}`} position={position} castShadow receiveShadow>
      <boxGeometry args={size} />
      <BoardMaterial {...look} />
      {artworks
        .filter((a) => FACE_DEFS[a.face].panel === id)
        .map((art) => {
          const texture = textures.get(textureKey(art.url, ink));
          return texture ? <ArtworkDecal key={art.id} art={art} texture={texture} size={size} metallic={metallic} /> : null;
        })}
    </mesh>
  );
}

interface MailerBoxProps {
  length: number;
  width: number;
  height: number;
  color: string;
  material: MaterialId;
  artworks: ArtworkPlacement[];
  textures: Map<string, THREE.Texture>;
  ink: string | null;
  metallic: boolean;
  lidOpen: boolean;
}

function MailerBox({ length, width, height, color, material, artworks, textures, ink, metallic, lidOpen }: MailerBoxProps) {
  // Scene-space dimensions: x = length, y = height, z = width (box centred at the origin)
  const L = length * INCH;
  const H = height * INCH;
  const W = width * INCH;
  const T = BOARD;
  const wallY = -H / 2 + (H - T) / 2;

  const grain = useKraftGrain(material === 'kraft');
  const look: BoardLook = { color, material, grain };
  const sizes = panelSizes(L, H, W);
  const shared = { look, artworks, textures, ink, metallic };

  // Lid hinges on the back top edge and eases open / closed
  const lid = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (!lid.current) return;
    const target = lidOpen ? -LID_OPEN_ANGLE : 0;
    lid.current.rotation.x = THREE.MathUtils.damp(lid.current.rotation.x, target, 6, dt);
  });

  const flapH = Math.min(H * 0.35, 0.12);

  return (
    <group position={[0, H / 2, 0]}>
      <Panel id="bottom" size={sizes.bottom} position={[0, -H / 2 + T / 2, 0]} {...shared} />
      <Panel id="front" size={sizes.front} position={[0, wallY, W / 2 - T / 2]} {...shared} />
      <Panel id="back" size={sizes.back} position={[0, wallY, -(W / 2 - T / 2)]} {...shared} />
      <Panel id="left" size={sizes.left} position={[-(L / 2 - T / 2), wallY, 0]} {...shared} />
      <Panel id="right" size={sizes.right} position={[L / 2 - T / 2, wallY, 0]} {...shared} />

      {/* Lid + front tuck flap, pivoting on the back top edge */}
      <group ref={lid} position={[0, H / 2 - T / 2, -W / 2]}>
        <Panel id="lid" size={sizes.lid} position={[0, 0, W / 2]} {...shared} />
        <mesh position={[0, T / 2 - flapH / 2, W + T / 4]} castShadow>
          <boxGeometry args={[L * 0.985, flapH, T / 2]} />
          <BoardMaterial {...look} />
        </mesh>
      </group>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Camera                                                             */
/* ------------------------------------------------------------------ */

function CameraRig({ command, autoRotate, maxDim }: { command: CanvasCommand | null; autoRotate: boolean; maxDim: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const goal = useRef<THREE.Vector3 | null>(null);

  // Any manual drag cancels a camera move in progress
  useEffect(() => {
    if (!controls) return;
    const stop = () => {
      goal.current = null;
    };
    controls.addEventListener('start', stop);
    return () => controls.removeEventListener('start', stop);
  }, [controls]);

  useEffect(() => {
    if (!command || !controls) return;
    const target = controls.target;
    const offset = camera.position.clone().sub(target);
    const viewDistance = clamp(maxDim * 2.6 + 0.7, 1.5, 6);

    if (command.type === 'zoom-in' || command.type === 'zoom-out') {
      const len = clamp(offset.length() * (command.type === 'zoom-in' ? 0.8 : 1.25), 1.2, 7);
      goal.current = target.clone().add(offset.setLength(len));
    } else {
      const dir = vec(VIEW_DIRS[command.type === 'view' && command.face ? command.face : 'default']).normalize();
      goal.current = target.clone().add(dir.multiplyScalar(viewDistance));
    }
    // Only a new command (nonce) should trigger a move
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command?.nonce]);

  useFrame((_, dt) => {
    if (!controls) return;
    controls.autoRotate = autoRotate && !goal.current;
    if (!goal.current) return;
    camera.position.lerp(goal.current, 1 - Math.pow(0.002, dt));
    if (camera.position.distanceTo(goal.current) < 0.004) goal.current = null;
  });

  return null;
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
  inkColor = null,
  inkMetallic = false,
  lidOpen = false,
  autoRotate = false,
  command = null,
  className,
}: BoxCanvasProps) {
  const specs = useMemo(
    () => [...new Set(artworks.map((a) => a.url))].map((url) => ({ key: textureKey(url, inkColor), url, ink: inkColor })),
    [artworks, inkColor],
  );
  const textures = useArtworkTextures(specs);
  const maxDim = Math.max(length, width, height) * INCH;

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
      {/* Kept moderate so the board shows its true colour (kraft stays brown, not washed-out beige) */}
      <ambientLight intensity={0.25} />
      <directionalLight position={[4, 6, 3]} intensity={1.1} />
      <spotLight position={[-4, 3, -4]} intensity={2.2} angle={0.5} penumbra={1} color="#f5a524" />
      <Suspense fallback={null}>
        <Environment preset="studio" environmentIntensity={0.3} />
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
        ink={inkColor}
        metallic={inkMetallic}
        lidOpen={lidOpen}
      />

      {/* Soft grounded shadow under the box */}
      <ContactShadows position={[0, 0.001, 0]} opacity={0.85} scale={6} blur={2.4} far={2} color="#000000" />

      <OrbitControls
        makeDefault
        enablePan={false}
        minDistance={1.2}
        maxDistance={7}
        maxPolarAngle={Math.PI / 2.05}
        autoRotateSpeed={1.5}
        target={[0, (height * INCH) / 2, 0]}
      />
      <CameraRig command={command} autoRotate={autoRotate} maxDim={maxDim} />
    </Canvas>
  );
}
