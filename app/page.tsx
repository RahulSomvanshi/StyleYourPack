'use client';

/**
 * Kraftify — landing page + 3D packaging studio.
 *
 * Sections:
 *   Navbar → Hero → Ticker → 3D Studio (configurator + canvas + live pricing)
 *   → How it works / social proof → Footer
 *   + Checkout drawer (Razorpay or WhatsApp quote)
 */

import dynamic from 'next/dynamic';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRight,
  ArrowUpRight,
  Asterisk,
  BadgeCheck,
  Boxes,
  Check,
  CreditCard,
  ImagePlus,
  Layers,
  Loader2,
  MessageCircle,
  MousePointer2,
  Package,
  PackageOpen,
  Palette,
  Printer,
  RotateCcw,
  RotateCw,
  Ruler,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  Truck,
  Type,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { ArtworkPlacement, CanvasCommand, Face, MaterialId } from '@/components/3d/BoxCanvas';

// WebGL is client-only, so skip SSR for the canvas
const BoxCanvas = dynamic(() => import('@/components/3d/BoxCanvas'), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-neutral-500">
      <Loader2 className="h-6 w-6 animate-spin" />
    </div>
  ),
});

/* ================================================================== */
/* Pricing engine                                                     */
/* ================================================================== */

type PrintMethod = 'flexo' | 'offset';

interface MaterialOption {
  id: MaterialId;
  name: string;
  description: string;
  /** ₹ per square inch of board */
  rate: number;
  defaultColor: string;
}

const MATERIALS: MaterialOption[] = [
  {
    id: 'kraft',
    name: 'Eco Brown Kraft',
    description: '100% recyclable, natural fibre look',
    rate: 0.06,
    defaultColor: '#b0855a',
  },
  {
    id: 'matte-white',
    name: 'Matte White Corrugated',
    description: 'Clean, bright base for vivid prints',
    rate: 0.08,
    defaultColor: '#f5f5f4',
  },
  {
    id: 'glossy',
    name: 'Premium Glossy Coated',
    description: 'Rich colour with a luxe sheen',
    rate: 0.11,
    defaultColor: '#111827',
  },
];

/*
 * Printing prices (₹) — placeholders, replace with your real costs.
 * Flexo: one ink colour, one plate per printed side, so it's charged per side.
 * Offset: full colour (CMYK), one flat setup charge, higher minimum quantity.
 */
const FLEXO_CHARGE_PER_SIDE = 1499;
const OFFSET_SETUP_CHARGE = 9999;

const PRINT_METHODS: Record<
  PrintMethod,
  { name: string; tagline: string; perks: string[]; minQty: number; presets: number[] }
> = {
  flexo: {
    name: 'Flexo Printing',
    tagline: '1 ink colour',
    perks: ['1 colour, no bleed', 'Logos & simple art', 'Fast turnaround', 'Cost effective'],
    minQty: 100,
    presets: [100, 200, 500, 1000],
  },
  offset: {
    name: 'Offset Printing',
    tagline: 'Full colour CMYK',
    perks: ['Full-bleed CMYK', 'Photos & complex art', 'Premium finish', 'One setup charge'],
    minQty: 500,
    presets: [500, 1000, 2500, 5000],
  },
};

const MAX_QTY = 50000;

/** Flexo ink cost per printed side, per box — falls as volume rises. */
const flexoInkCost = (qty: number) => (qty >= 1000 ? 2 : qty >= 500 ? 2.5 : qty >= 200 ? 3 : 4);
/** Offset cost per box (every side prints on one sheet) — falls as volume rises. */
const offsetPrintCost = (qty: number) => (qty >= 2500 ? 3.5 : qty >= 1000 ? 4.5 : 6);

interface PriceInput {
  length: number;
  width: number;
  height: number;
  material: MaterialId;
  quantity: number;
  printMethod: PrintMethod;
  /** Number of distinct sides (outside + inside) carrying artwork */
  printedSides: number;
}

interface PriceBreakdown {
  surfaceArea: number;
  baseMaterialCost: number;
  printCostPerUnit: number;
  unitCost: number;
  printedSides: number;
  /** Flexo: per-side plate charge × sides. Offset: flat setup. Plain boxes: 0. */
  printingCharge: number;
  total: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 *   Surface Area       = 2 × (L·W + L·H + W·H)
 *   Base Material Cost = Surface Area × Material Rate
 *   Print Cost / box   = Flexo: ink cost × printed sides  |  Offset: flat per box
 *   Unit Cost          = Base Material Cost + Print Cost / box
 *   Printing Charge    = Flexo: ₹/side × printed sides    |  Offset: one setup charge
 *   Total              = Unit Cost × Quantity + Printing Charge
 */
function calculatePrice(p: PriceInput): PriceBreakdown {
  const rate = MATERIALS.find((m) => m.id === p.material)!.rate;
  const surfaceArea = 2 * (p.length * p.width + p.length * p.height + p.width * p.height);
  const baseMaterialCost = round2(surfaceArea * rate);

  const printed = p.printedSides > 0;
  const flexo = p.printMethod === 'flexo';
  const printCostPerUnit = !printed ? 0 : flexo ? flexoInkCost(p.quantity) * p.printedSides : offsetPrintCost(p.quantity);
  const printingCharge = !printed ? 0 : flexo ? FLEXO_CHARGE_PER_SIDE * p.printedSides : OFFSET_SETUP_CHARGE;

  const unitCost = round2(baseMaterialCost + printCostPerUnit);
  const total = Math.round(unitCost * p.quantity + printingCharge);
  return { surfaceArea, baseMaterialCost, printCostPerUnit, unitCost, printedSides: p.printedSides, printingCharge, total };
}

const inr = (value: number, digits = 0) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/* ================================================================== */
/* Box configuration                                                  */
/* ================================================================== */

type FontId = 'display' | 'clean' | 'serif' | 'mono';

interface TextStyle {
  content: string;
  font: FontId;
  color: string;
  bold: boolean;
}

/** An uploaded image or a text block, plus where and how it sits on the box. */
type Artwork = ArtworkPlacement & { name: string; kind: 'image' | 'text'; text?: TextStyle };

type InkId = 'black' | 'blue' | 'red' | 'green' | 'white' | 'gold' | 'silver';

const INKS: { id: InkId; name: string; hex: string; metallic?: boolean }[] = [
  { id: 'black', name: 'Black', hex: '#141414' },
  { id: 'blue', name: 'Blue', hex: '#1d4ed8' },
  { id: 'red', name: 'Red', hex: '#dc2626' },
  { id: 'green', name: 'Green', hex: '#15803d' },
  { id: 'white', name: 'White', hex: '#f8fafc' },
  { id: 'gold', name: 'Gold', hex: '#d4af37', metallic: true },
  { id: 'silver', name: 'Silver', hex: '#c0c0c0', metallic: true },
];

const inkOf = (id: InkId) => INKS.find((i) => i.id === id)!;

interface BoxConfig {
  /** Inches */
  length: number;
  width: number;
  height: number;
  material: MaterialId;
  color: string;
  quantity: number;
  printMethod: PrintMethod;
  ink: InkId;
  artworks: Artwork[];
}

const DEFAULT_CONFIG: BoxConfig = {
  length: 10,
  width: 8,
  height: 4,
  material: 'kraft',
  color: '#b0855a',
  quantity: 200,
  printMethod: 'flexo',
  ink: 'black',
  artworks: [],
};

const OUTSIDE_FACES: { id: Face; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'front', label: 'Front' },
  { id: 'back', label: 'Back' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
];

const INSIDE_FACES: { id: Face; label: string }[] = [
  { id: 'inside-lid', label: 'Lid' },
  { id: 'inside-bottom', label: 'Base' },
  { id: 'inside-front', label: 'Front' },
  { id: 'inside-back', label: 'Back' },
  { id: 'inside-left', label: 'Left' },
  { id: 'inside-right', label: 'Right' },
];

const isInside = (face: Face) => face.startsWith('inside-');

const faceLabel = (face: Face) =>
  isInside(face)
    ? `Inside ${INSIDE_FACES.find((f) => f.id === face)!.label.toLowerCase()}`
    : OUTSIDE_FACES.find((f) => f.id === face)!.label;

const printedSidesOf = (artworks: Artwork[]) => new Set(artworks.map((a) => a.face)).size;

const priceInputOf = (c: BoxConfig): PriceInput => ({
  length: c.length,
  width: c.width,
  height: c.height,
  material: c.material,
  quantity: c.quantity,
  printMethod: c.printMethod,
  printedSides: printedSidesOf(c.artworks),
});

const MAX_ARTWORKS = 12;

const COLOR_SWATCHES = ['#b0855a', '#f5f5f4', '#111827', '#1e3a8a', '#065f46', '#9f1239', '#f59e0b', '#7c3aed'];

type Unit = 'in' | 'cm' | 'mm';
const UNIT_FACTOR: Record<Unit, number> = { in: 1, cm: 2.54, mm: 25.4 };

/** Inches → display value in the chosen unit. */
const toUnit = (inches: number, unit: Unit) => {
  const v = inches * UNIT_FACTOR[unit];
  return unit === 'mm' ? Math.round(v) : Math.round(v * 10) / 10;
};

const sizeLabel = (c: Pick<BoxConfig, 'length' | 'width' | 'height'>, unit: Unit = 'in') =>
  unit === 'in'
    ? `${c.length}" × ${c.width}" × ${c.height}"`
    : `${toUnit(c.length, unit)} × ${toUnit(c.width, unit)} × ${toUnit(c.height, unit)} ${unit}`;

const materialName = (id: MaterialId) => MATERIALS.find((m) => m.id === id)!.name;

/* ---------- Text artwork ---------- */

const FONTS: { id: FontId; label: string; cssVar?: string; fallback: string; italic?: boolean }[] = [
  { id: 'display', label: 'Bold', cssVar: '--font-display', fallback: 'sans-serif' },
  { id: 'clean', label: 'Clean', cssVar: '--font-inter', fallback: 'sans-serif' },
  { id: 'serif', label: 'Elegant', cssVar: '--font-serif', fallback: 'Georgia, serif', italic: true },
  { id: 'mono', label: 'Mono', fallback: '"Courier New", monospace' },
];

const DEFAULT_TEXT: TextStyle = { content: 'Your Brand', font: 'display', color: '#111111', bold: true };

/** Renders a text block to a transparent PNG (data URL) so it can be printed like any artwork. */
function renderTextImage(style: TextStyle): string {
  const font = FONTS.find((f) => f.id === style.font)!;
  const family =
    (font.cssVar && getComputedStyle(document.documentElement).getPropertyValue(font.cssVar).trim()) || font.fallback;
  const px = 160;
  const fontStr = `${font.italic ? 'italic ' : ''}${style.bold ? 700 : 400} ${px}px ${family}`;
  const lines = (style.content.trim() || ' ').split('\n');

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = fontStr;
  const pad = px * 0.2;
  const lineH = px * 1.15;
  canvas.width = Math.ceil(Math.max(1, ...lines.map((l) => ctx.measureText(l).width)) + pad * 2);
  canvas.height = Math.ceil(lineH * lines.length + pad * 2);

  ctx.font = fontStr; // resizing the canvas resets its state
  ctx.fillStyle = style.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => ctx.fillText(line, canvas.width / 2, pad + lineH * (i + 0.5)));
  return canvas.toDataURL('image/png');
}

/** Next free face on the chosen side of the box, else that side's main face. */
function nextFreeFace(artworks: Artwork[], side: 'outside' | 'inside'): Face {
  const order: Face[] =
    side === 'inside'
      ? ['inside-bottom', 'inside-lid', 'inside-back', 'inside-front', 'inside-left', 'inside-right']
      : ['top', 'front', 'right', 'left', 'back'];
  const used = new Set(artworks.map((a) => a.face));
  return order.find((o) => !used.has(o)) ?? order[0];
}

/* ================================================================== */
/* Page                                                               */
/* ================================================================== */

type CheckoutMode = 'order' | 'sample';

export default function HomePage() {
  const [config, setConfig] = useState<BoxConfig>(DEFAULT_CONFIG);
  const [checkoutMode, setCheckoutMode] = useState<CheckoutMode | null>(null);
  // Every object URL handed out, so each can be revoked (no memory leaks)
  const objectUrls = useRef(new Set<string>());

  const price = useMemo(() => calculatePrice(priceInputOf(config)), [config]);

  const update = useCallback(<K extends keyof BoxConfig>(key: K, value: BoxConfig[K]) => {
    setConfig((c) => ({ ...c, [key]: value }));
  }, []);

  /** Switching method keeps the quantity at or above that method's minimum. */
  const setPrintMethod = useCallback((method: PrintMethod) => {
    setConfig((c) => ({ ...c, printMethod: method, quantity: Math.max(c.quantity, PRINT_METHODS[method].minQty) }));
  }, []);

  /** Adds image files as artworks, filling empty faces on the chosen side first. */
  const addArtworks = useCallback((files: File[], side: 'outside' | 'inside'): string[] => {
    const created = files.map((file) => {
      const url = URL.createObjectURL(file);
      objectUrls.current.add(url);
      return { id: crypto.randomUUID(), url, name: file.name };
    });

    setConfig((c) => {
      const artworks = [...c.artworks];
      for (const f of created) {
        artworks.push({ ...f, kind: 'image', face: nextFreeFace(artworks, side), size: 0.5, offsetX: 0, offsetY: 0, rotation: 0 });
      }
      return { ...c, artworks };
    });
    return created.map((f) => f.id);
  }, []);

  /** Adds a text block as a printable artwork. */
  const addText = useCallback((side: 'outside' | 'inside'): string => {
    const id = crypto.randomUUID();
    const text = { ...DEFAULT_TEXT };
    const url = renderTextImage(text);
    setConfig((c) => ({
      ...c,
      artworks: [
        ...c.artworks,
        {
          id,
          url,
          name: text.content,
          kind: 'text',
          text,
          face: nextFreeFace(c.artworks, side),
          size: 0.6,
          offsetX: 0,
          offsetY: 0,
          rotation: 0,
        },
      ],
    }));
    return id;
  }, []);

  const updateArtwork = useCallback((id: string, patch: Partial<ArtworkPlacement> & { text?: TextStyle }) => {
    // Text edits re-render the text image before it is computed into state
    const extra = patch.text ? { url: renderTextImage(patch.text), name: patch.text.content.split('\n')[0] || 'Text' } : {};
    setConfig((c) => ({ ...c, artworks: c.artworks.map((a) => (a.id === id ? { ...a, ...patch, ...extra } : a)) }));
  }, []);

  const removeArtwork = useCallback((art: Artwork) => {
    if (objectUrls.current.delete(art.url)) URL.revokeObjectURL(art.url);
    setConfig((c) => ({ ...c, artworks: c.artworks.filter((a) => a.id !== art.id) }));
  }, []);

  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
    };
  }, []);

  const scrollToStudio = useCallback(() => {
    document.getElementById('studio')?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const closeCheckout = useCallback(() => setCheckoutMode(null), []);

  return (
    <main className="min-h-screen overflow-x-clip bg-black text-neutral-100">
      <Navbar onLaunchStudio={scrollToStudio} />
      <Hero onLaunchStudio={scrollToStudio} onRequestSample={() => setCheckoutMode('sample')} />
      <Ticker />
      <Studio
        config={config}
        price={price}
        update={update}
        onPrintMethod={setPrintMethod}
        onAddArtworks={addArtworks}
        onAddText={addText}
        onUpdateArtwork={updateArtwork}
        onRemoveArtwork={removeArtwork}
        onOrder={() => setCheckoutMode('order')}
      />
      <HowItWorks onLaunchStudio={scrollToStudio} />
      <Footer />
      <CheckoutDrawer mode={checkoutMode} onClose={closeCheckout} config={config} price={price} />
    </main>
  );
}

/* ================================================================== */
/* Navbar                                                             */
/* ================================================================== */

function Navbar({ onLaunchStudio }: { onLaunchStudio: () => void }) {
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-black/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Wordmark />
        <nav className="hidden items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1 text-sm text-neutral-400 md:flex">
          {NAV_LINKS.map(([href, label]) => (
            <a key={href} href={href} className="rounded-full px-4 py-1.5 transition hover:bg-white/10 hover:text-white">
              {label}
            </a>
          ))}
        </nav>
        <button
          onClick={onLaunchStudio}
          className="group inline-flex items-center gap-1.5 rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-black transition hover:bg-amber-300"
        >
          Start designing
          <ArrowUpRight className="h-4 w-4 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        </button>
      </div>
    </header>
  );
}

const NAV_LINKS = [
  ['#studio', '3D Studio'],
  ['#how-it-works', 'How it works'],
  ['#pricing', 'Pricing'],
] as const;

function Wordmark({ size = 'md' }: { size?: 'md' | 'sm' }) {
  return (
    <a href="#" className="group flex items-center gap-2.5" aria-label="Kraftify home">
      <span
        className={`grid place-items-center rounded-xl bg-gradient-to-br from-amber-300 via-amber-500 to-orange-700 text-black shadow-[0_0_24px_-4px_rgba(245,165,36,0.6)] transition group-hover:rotate-6 ${
          size === 'sm' ? 'h-7 w-7' : 'h-9 w-9'
        }`}
      >
        <Package className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-[18px] w-[18px]'} strokeWidth={2.25} />
      </span>
      <span className={`font-display font-bold tracking-tight ${size === 'sm' ? 'text-base' : 'text-xl'}`}>
        Kraft<span className={`font-serif-accent text-amber-400 ${size === 'sm' ? 'text-lg' : 'text-2xl'}`}>ify</span>
      </span>
    </a>
  );
}

/* ================================================================== */
/* Hero                                                               */
/* ================================================================== */

const TRUST_BADGES = [
  { icon: Truck, label: 'Fast 7-Day Dispatch' },
  { icon: ShieldCheck, label: '100% Quality Guarantee' },
  { icon: Sparkles, label: 'Instant 3D Proofing' },
];

function Hero({ onLaunchStudio, onRequestSample }: { onLaunchStudio: () => void; onRequestSample: () => void }) {
  // Real example quote from the pricing engine for the hero tags
  const sample = calculatePrice({ ...priceInputOf(DEFAULT_CONFIG), quantity: 100, printedSides: 1 });

  return (
    <section className="relative overflow-hidden">
      {/* Atmosphere: kraft glow, dot grid fading out at the edges */}
      <div className="pointer-events-none absolute -top-48 left-1/2 h-[640px] w-[1000px] -translate-x-1/2 rounded-full bg-amber-500/15 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-32 -right-24 h-96 w-96 rounded-full bg-orange-700/20 blur-[100px]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.08)_1px,transparent_1px)] bg-[size:28px_28px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />

      <div className="relative mx-auto grid max-w-7xl items-center gap-16 px-4 pb-24 pt-16 sm:px-6 lg:grid-cols-[1.2fr_1fr] lg:px-8 lg:pb-32 lg:pt-24">
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7 }}>
          <span className="inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs font-medium text-amber-300">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
            </span>
            Low-MOQ packaging studio for D2C brands
          </span>

          <h1 className="font-display mt-7 text-[2.6rem] font-bold leading-[1.04] tracking-tight sm:text-6xl lg:text-7xl">
            Custom Printed Boxes for <span className="font-serif-accent text-kraft pr-1 text-[1.12em]">D2C Brands.</span>{' '}
            <span className="text-neutral-500">Starting at Just</span>{' '}
            <span className="relative inline-block whitespace-nowrap">
              100 Units.
              <svg
                aria-hidden
                viewBox="0 0 200 12"
                preserveAspectRatio="none"
                className="absolute -bottom-2 left-0 h-3 w-full text-amber-400"
              >
                <motion.path
                  d="M2 8 Q 25 2 50 7 T 100 7 T 150 7 T 198 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ delay: 0.7, duration: 0.9, ease: 'easeInOut' }}
                />
              </svg>
            </span>
          </h1>

          <p className="mt-8 max-w-xl text-lg leading-relaxed text-neutral-400">
            Design in 3D, get instant pricing, and order premium packaging without 5,000 unit minimums.
          </p>

          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <button
              onClick={onLaunchStudio}
              className="group inline-flex items-center justify-center gap-2 rounded-full bg-amber-400 px-7 py-4 font-semibold text-black shadow-[0_0_40px_-8px_rgba(245,165,36,0.7)] transition hover:bg-amber-300"
            >
              Launch 3D Studio
              <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
            </button>
            <button
              onClick={onRequestSample}
              className="inline-flex items-center justify-center gap-2 rounded-full border border-white/15 px-7 py-4 font-semibold text-neutral-200 transition hover:border-white/30 hover:bg-white/5"
            >
              <Package className="h-4 w-4 text-amber-400" /> Request Free Sample Kit
            </button>
          </div>

          <ul className="mt-12 flex flex-wrap gap-2">
            {TRUST_BADGES.map(({ icon: Icon, label }) => (
              <li
                key={label}
                className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-sm text-neutral-300"
              >
                <Icon className="h-4 w-4 text-amber-400" /> {label}
              </li>
            ))}
          </ul>
        </motion.div>

        {/* Isometric kraft box with floating spec tags */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.15 }}
          className="relative mx-auto aspect-square w-full max-w-md"
        >
          {/* Rotating die-line ring */}
          <div className="animate-spin-slow absolute inset-4 rounded-full border border-dashed border-amber-400/25" />
          <div className="absolute inset-16 rounded-full bg-amber-500/10 blur-3xl" />

          <motion.div
            animate={{ y: [0, -14, 0] }}
            transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute inset-0 grid place-items-center"
          >
            <IsoBox className="w-[72%] drop-shadow-[0_40px_40px_rgba(0,0,0,0.6)]" />
          </motion.div>

          <FloatTag className="left-0 top-[14%]" delay={0}>
            <span className="text-neutral-500">from</span>{' '}
            <span className="font-display font-bold text-white">{inr(sample.unitCost, 2)}</span>
            <span className="text-neutral-500"> / box</span>
          </FloatTag>
          <FloatTag className="right-0 top-[38%]" delay={1.2}>
            <Truck className="h-3.5 w-3.5 text-amber-400" /> Ships in 7 days
          </FloatTag>
          <FloatTag className="bottom-[10%] left-[8%]" delay={2.4}>
            <Boxes className="h-3.5 w-3.5 text-amber-400" /> MOQ just <span className="font-semibold text-white">100</span>
          </FloatTag>
        </motion.div>
      </div>
    </section>
  );
}

function FloatTag({ children, className, delay }: { children: ReactNode; className: string; delay: number }) {
  return (
    <motion.div
      animate={{ y: [0, -8, 0] }}
      transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut', delay }}
      className={`absolute flex items-center gap-1.5 rounded-full border border-white/10 bg-neutral-900/80 px-3.5 py-2 text-xs text-neutral-300 shadow-xl backdrop-blur ${className}`}
    >
      {children}
    </motion.div>
  );
}

/** Isometric kraft mailer box, with the wordmark printed on the lid. */
function IsoBox({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden>
      <defs>
        <linearGradient id="iso-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#d9a86c" />
          <stop offset="1" stopColor="#b98348" />
        </linearGradient>
        <linearGradient id="iso-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a8743f" />
          <stop offset="1" stopColor="#7f5228" />
        </linearGradient>
        <linearGradient id="iso-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#875829" />
          <stop offset="1" stopColor="#5a3818" />
        </linearGradient>
      </defs>
      <polygon points="100,30 170,65 100,100 30,65" fill="url(#iso-top)" />
      <polygon points="30,65 100,100 100,170 30,135" fill="url(#iso-left)" />
      <polygon points="100,100 170,65 170,135 100,170" fill="url(#iso-right)" />
      {/* Lid flap seam */}
      <polyline points="30,77 100,112 170,77" fill="none" stroke="#000" strokeOpacity="0.25" strokeWidth="1" />
      {/* Wordmark printed on the lid (unit square mapped onto the top face) */}
      <g transform="matrix(0.7,-0.35,0.7,0.35,30,65)">
        <rect x="18" y="38" width="64" height="24" rx="5" fill="#0a0a0a" />
        <text x="50" y="55" textAnchor="middle" fontSize="12" fontWeight="700" fill="#f5a524" fontFamily="sans-serif">
          KRAFTIFY
        </text>
      </g>
    </svg>
  );
}

/* ================================================================== */
/* Ticker band                                                        */
/* ================================================================== */

const TICKER = [
  '100 unit minimum',
  '7-day dispatch',
  'Live 3D proofs',
  'Eco kraft board',
  'Instant wholesale pricing',
  'Print on every side',
  'Pan-India shipping',
];

function Ticker() {
  const items = [...TICKER, ...TICKER];
  return (
    <div className="relative overflow-hidden py-6" aria-hidden>
      <div className="-rotate-[1.5deg] scale-[1.03] bg-amber-400 py-3 text-black">
        <div className="animate-marquee flex w-max">
          {items.map((t, i) => (
            <span key={i} className="font-display flex items-center gap-6 pr-6 text-sm font-bold uppercase tracking-[0.2em]">
              {t}
              <Asterisk className="h-4 w-4" strokeWidth={3} />
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

/* ================================================================== */
/* 3D Studio                                                          */
/* ================================================================== */

type PrintSide = 'outside' | 'inside';
type ArtworkPatch = Partial<ArtworkPlacement> & { text?: TextStyle };

interface StudioProps {
  config: BoxConfig;
  price: PriceBreakdown;
  update: <K extends keyof BoxConfig>(key: K, value: BoxConfig[K]) => void;
  onPrintMethod: (method: PrintMethod) => void;
  onAddArtworks: (files: File[], side: PrintSide) => string[];
  onAddText: (side: PrintSide) => string;
  onUpdateArtwork: (id: string, patch: ArtworkPatch) => void;
  onRemoveArtwork: (art: Artwork) => void;
  onOrder: () => void;
}

function Studio({
  config,
  price,
  update,
  onPrintMethod,
  onAddArtworks,
  onAddText,
  onUpdateArtwork,
  onRemoveArtwork,
  onOrder,
}: StudioProps) {
  const [unit, setUnit] = useState<Unit>('in');
  const [printSide, setPrintSide] = useState<PrintSide>('outside');
  const [lidOpen, setLidOpen] = useState(false);
  const [autoRotate, setAutoRotate] = useState(false);
  const [command, setCommand] = useState<CanvasCommand | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const send = (type: CanvasCommand['type'], face?: Face) => setCommand({ type, face, nonce: Date.now() });

  /** Fly the camera to a side; inside sides open the lid first. */
  const viewFace = (face: Face) => {
    const inside = isInside(face);
    setPrintSide(inside ? 'inside' : 'outside');
    setLidOpen(inside);
    setAutoRotate(false);
    send('view', face);
  };

  const switchSide = (side: PrintSide) => {
    setPrintSide(side);
    setLidOpen(side === 'inside');
    send(side === 'inside' ? 'view' : 'reset', side === 'inside' ? 'inside-bottom' : undefined);
  };

  const selectArtwork = (id: string | null) => {
    setSelectedId(id);
    const art = config.artworks.find((a) => a.id === id);
    if (art) viewFace(art.face);
  };

  const updateArtwork = (id: string, patch: ArtworkPatch) => {
    onUpdateArtwork(id, patch);
    if (patch.face) viewFace(patch.face);
  };

  const ink = inkOf(config.ink);
  const flexo = config.printMethod === 'flexo';
  const sideFaces = printSide === 'inside' ? INSIDE_FACES : OUTSIDE_FACES;
  const usedFaces = new Set(config.artworks.map((a) => a.face));

  return (
    <section id="studio" className="relative scroll-mt-16 py-24">
      <div className="pointer-events-none absolute left-1/2 top-40 h-[500px] w-[800px] -translate-x-1/2 rounded-full bg-amber-500/[0.07] blur-[120px]" />
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          index="01"
          eyebrow="3D Studio"
          title="Design your box."
          accent="See the price instantly."
          subtitle="Set your size, pick a finish and print method, then place your logo, artwork or text on any side, inside or out. The price updates as you go."
        />

        <div className="mt-12 grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
          {/* ---------- Configurator sidebar ---------- */}
          <aside className="order-2 space-y-4 lg:order-1">
            <Panel icon={Ruler} title="Dimensions" hint={<UnitToggle unit={unit} onChange={setUnit} />}>
              <div className="space-y-5">
                <DimensionSlider label="Length" unit={unit} value={config.length} min={4} max={16} onChange={(v) => update('length', v)} />
                <DimensionSlider label="Width" unit={unit} value={config.width} min={4} max={14} onChange={(v) => update('width', v)} />
                <DimensionSlider label="Height" unit={unit} value={config.height} min={2} max={8} onChange={(v) => update('height', v)} />
              </div>
            </Panel>

            <Panel icon={Layers} title="Material & finish">
              <div className="space-y-2">
                {MATERIALS.map((m) => {
                  const active = config.material === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => {
                        update('material', m.id);
                        update('color', m.defaultColor);
                      }}
                      className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${
                        active ? 'border-amber-400/70 bg-amber-400/10 ring-1 ring-amber-400/70' : 'border-white/10 hover:border-white/25'
                      }`}
                    >
                      <span className="h-9 w-9 shrink-0 rounded-lg border border-white/15" style={{ background: m.defaultColor }} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">{m.name}</span>
                        <span className="block text-xs text-neutral-500">{m.description}</span>
                      </span>
                      {active && <Check className="h-4 w-4 shrink-0 text-amber-400" />}
                    </button>
                  );
                })}
              </div>
            </Panel>

            <Panel icon={Palette} title="Base colour">
              <div className="flex flex-wrap items-center gap-2">
                {COLOR_SWATCHES.map((c) => (
                  <button
                    key={c}
                    aria-label={`Colour ${c}`}
                    onClick={() => update('color', c)}
                    className={`h-8 w-8 rounded-full border border-white/15 transition ${
                      config.color.toLowerCase() === c ? 'ring-2 ring-amber-400/70 ring-offset-2 ring-offset-neutral-950' : 'hover:scale-110'
                    }`}
                    style={{ background: c }}
                  />
                ))}
                <label className="relative ml-1 flex h-8 cursor-pointer items-center gap-2 rounded-full border border-white/10 px-3 text-xs font-medium text-neutral-400 hover:bg-white/5">
                  <span className="h-4 w-4 rounded-full border border-white/15" style={{ background: config.color }} />
                  Custom
                  <input
                    type="color"
                    value={config.color}
                    onChange={(e) => update('color', e.target.value)}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </label>
              </div>
            </Panel>

            <Panel icon={Printer} title="Printing">
              <PrintMethodPicker config={config} price={price} onMethod={onPrintMethod} onInk={(id) => update('ink', id)} />
            </Panel>

            <Panel icon={ImagePlus} title="Logo, artwork & text" hint={`${config.artworks.length}/${MAX_ARTWORKS}`}>
              <ArtworkManager
                artworks={config.artworks}
                selectedId={selectedId}
                printSide={printSide}
                flexo={flexo}
                inkName={ink.name}
                onSelect={selectArtwork}
                onAdd={(files) => onAddArtworks(files, printSide)}
                onAddText={() => onAddText(printSide)}
                onUpdate={updateArtwork}
                onRemove={(art) => {
                  if (art.id === selectedId) setSelectedId(null);
                  onRemoveArtwork(art);
                }}
              />
            </Panel>

            <Panel icon={Boxes} title="Quantity" hint={`Min ${PRINT_METHODS[config.printMethod].minQty} for ${flexo ? 'flexo' : 'offset'}`}>
              <QuantitySelector config={config} onChange={(q) => update('quantity', q)} />
            </Panel>
          </aside>

          {/* ---------- Canvas + pricing ---------- */}
          <div className="order-1 space-y-4 self-start lg:sticky lg:top-24 lg:order-2">
            <div className="relative h-[420px] overflow-hidden rounded-3xl border border-white/10 bg-[radial-gradient(ellipse_at_50%_40%,#2a2117_0%,#0e0e0e_55%,#050505_100%)] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] sm:h-[500px] lg:h-[560px]">
              <BoxCanvas
                length={config.length}
                width={config.width}
                height={config.height}
                color={config.color}
                material={config.material}
                artworks={config.artworks}
                inkColor={flexo ? ink.hex : null}
                inkMetallic={flexo && !!ink.metallic}
                lidOpen={lidOpen}
                autoRotate={autoRotate}
                command={command}
              />

              {/* Top-left: outside / inside printing + spec chips */}
              <div className="absolute left-3 top-3 flex flex-col items-start gap-2 sm:left-4 sm:top-4">
                <div className="flex rounded-full border border-white/10 bg-black/60 p-1 text-xs font-semibold backdrop-blur">
                  {(['outside', 'inside'] as const).map((side) => (
                    <button
                      key={side}
                      onClick={() => switchSide(side)}
                      className={`rounded-full px-3 py-1.5 uppercase tracking-wider transition ${
                        printSide === side ? 'bg-amber-400 text-black' : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      {side} printing
                    </button>
                  ))}
                </div>
                <div className="pointer-events-none hidden flex-wrap gap-2 sm:flex">
                  <Chip>{sizeLabel(config, unit)}</Chip>
                  <Chip>{materialName(config.material)}</Chip>
                </div>
              </div>

              {/* Top-right: viewer tools */}
              <div className="absolute right-3 top-3 flex flex-col gap-1.5 sm:right-4 sm:top-4">
                <ToolButton label={autoRotate ? 'Stop rotating' : 'Auto-rotate'} active={autoRotate} onClick={() => setAutoRotate((r) => !r)}>
                  <RotateCw className={`h-4 w-4 ${autoRotate ? 'animate-spin [animation-duration:3s]' : ''}`} />
                </ToolButton>
                <ToolButton label="Zoom in" onClick={() => send('zoom-in')}>
                  <ZoomIn className="h-4 w-4" />
                </ToolButton>
                <ToolButton label="Zoom out" onClick={() => send('zoom-out')}>
                  <ZoomOut className="h-4 w-4" />
                </ToolButton>
                <ToolButton label="Reset view" onClick={() => send('reset')}>
                  <RotateCcw className="h-4 w-4" />
                </ToolButton>
                <ToolButton label={lidOpen ? 'Close box' : 'Open box'} active={lidOpen} onClick={() => setLidOpen((o) => !o)}>
                  {lidOpen ? <PackageOpen className="h-4 w-4" /> : <Package className="h-4 w-4" />}
                </ToolButton>
              </div>

              {/* Bottom: side tabs (jump the camera to a side) */}
              <div className="absolute inset-x-3 bottom-3 flex justify-center sm:inset-x-4 sm:bottom-4">
                <div className="flex max-w-full gap-1 overflow-x-auto rounded-full border border-white/10 bg-black/60 p-1 backdrop-blur [scrollbar-width:none]">
                  {sideFaces.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => viewFace(f.id)}
                      className="relative shrink-0 rounded-full px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:bg-white/10 hover:text-white"
                    >
                      {f.label}
                      {usedFaces.has(f.id) && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-400" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <p className="flex items-center justify-center gap-2 text-xs text-neutral-500">
              <MousePointer2 className="h-3.5 w-3.5" /> Drag to rotate · Scroll to zoom · Click a side tab to jump to it
            </p>

            <PricingCard config={config} price={price} onOrder={onOrder} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`grid h-9 w-9 place-items-center rounded-full border backdrop-blur transition ${
        active
          ? 'border-amber-400/70 bg-amber-400 text-black'
          : 'border-white/10 bg-black/60 text-neutral-300 hover:border-white/25 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-white/10 bg-black/60 px-3 py-1 text-xs font-medium text-neutral-300 backdrop-blur">
      {children}
    </span>
  );
}

function Panel({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: typeof Ruler;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-neutral-950/70 p-5 backdrop-blur transition hover:border-white/20">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="h-4 w-4 text-amber-400" /> {title}
        </h3>
        {hint && <span className="text-xs text-neutral-500">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function UnitToggle({ unit, onChange }: { unit: Unit; onChange: (u: Unit) => void }) {
  return (
    <span className="flex rounded-full border border-white/10 p-0.5">
      {(['in', 'cm', 'mm'] as const).map((u) => (
        <button
          key={u}
          onClick={() => onChange(u)}
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${
            unit === u ? 'bg-amber-400 text-black' : 'text-neutral-400 hover:text-white'
          }`}
        >
          {u}
        </button>
      ))}
    </span>
  );
}

function DimensionSlider({
  label,
  unit,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  unit: Unit;
  /** Inches */
  value: number;
  min: number;
  max: number;
  onChange: (inches: number) => void;
}) {
  // Local draft lets users type "12" without being clamped mid-keystroke
  const shown = String(toUnit(value, unit));
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);

  const commit = () => {
    const n = parseFloat(draft);
    const next = Number.isNaN(n) ? value : clamp(Math.round((n / UNIT_FACTOR[unit]) * 10) / 10, min, max);
    onChange(next);
    setDraft(String(toUnit(next, unit)));
  };

  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-neutral-300">{label}</span>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            className="w-20 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-right text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
          />
          <span className="w-6 text-xs text-neutral-500">{unit}</span>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={0.5}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mt-2 w-full accent-amber-400"
        aria-label={`${label} in inches`}
      />
      <div className="flex justify-between text-[11px] text-neutral-500">
        <span>
          {toUnit(min, unit)} {unit}
        </span>
        <span>
          {toUnit(max, unit)} {unit}
        </span>
      </div>
    </div>
  );
}

function PrintMethodPicker({
  config,
  price,
  onMethod,
  onInk,
}: {
  config: BoxConfig;
  price: PriceBreakdown;
  onMethod: (m: PrintMethod) => void;
  onInk: (id: InkId) => void;
}) {
  const method = PRINT_METHODS[config.printMethod];
  const flexo = config.printMethod === 'flexo';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {(Object.keys(PRINT_METHODS) as PrintMethod[]).map((id) => {
          const m = PRINT_METHODS[id];
          const active = config.printMethod === id;
          return (
            <button
              key={id}
              onClick={() => onMethod(id)}
              className={`rounded-xl border p-3 text-left transition ${
                active ? 'border-amber-400/70 bg-amber-400/10 ring-1 ring-amber-400/70' : 'border-white/10 hover:border-white/25'
              }`}
            >
              <span className="flex items-center justify-between text-sm font-semibold">
                {m.name.replace(' Printing', '')}
                {active && <Check className="h-4 w-4 text-amber-400" />}
              </span>
              <span className="mt-0.5 block text-xs text-neutral-500">{m.tagline}</span>
              {id === 'offset' && (
                <span className="mt-2 flex gap-1">
                  {['#22d3ee', '#e879f9', '#facc15', '#171717'].map((c) => (
                    <span key={c} className="h-1 w-4 rounded-full" style={{ background: c }} />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-neutral-400">
        {method.perks.map((p) => (
          <li key={p} className="flex items-center gap-1.5">
            <Check className="h-3 w-3 shrink-0 text-amber-400" /> {p}
          </li>
        ))}
      </ul>

      {flexo && (
        <div>
          <p className="mb-2 text-xs text-neutral-400">
            Ink colour: <span className="font-semibold text-white">{inkOf(config.ink).name}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {INKS.map((i) => (
              <button
                key={i.id}
                onClick={() => onInk(i.id)}
                aria-label={`${i.name} ink`}
                title={i.name}
                className={`h-8 w-8 rounded-lg border border-white/15 transition ${
                  config.ink === i.id ? 'ring-2 ring-amber-400/70 ring-offset-2 ring-offset-neutral-950' : 'hover:scale-110'
                }`}
                style={{
                  background: i.metallic ? `linear-gradient(135deg, ${i.hex}, #ffffff 45%, ${i.hex})` : i.hex,
                }}
              />
            ))}
          </div>
        </div>
      )}

      <p className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200">
        {flexo
          ? `Printing charge: ${inr(FLEXO_CHARGE_PER_SIDE)} per printed side (any qty)`
          : `Printing charge: ${inr(OFFSET_SETUP_CHARGE)} setup (any qty, all sides)`}
        {price.printedSides > 0 && (
          <span className="block text-amber-200/70">
            {price.printedSides} side{price.printedSides > 1 ? 's' : ''} printed → {inr(price.printingCharge)}
          </span>
        )}
      </p>
    </div>
  );
}

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface ArtworkManagerProps {
  artworks: Artwork[];
  selectedId: string | null;
  printSide: PrintSide;
  flexo: boolean;
  inkName: string;
  onSelect: (id: string | null) => void;
  onAdd: (files: File[]) => string[];
  onAddText: () => string;
  onUpdate: (id: string, patch: ArtworkPatch) => void;
  onRemove: (art: Artwork) => void;
}

/** Upload images or add text, then place each on any side (outside or inside) with size / position / rotation. */
function ArtworkManager({
  artworks,
  selectedId,
  printSide,
  flexo,
  inkName,
  onSelect,
  onAdd,
  onAddText,
  onUpdate,
  onRemove,
}: ArtworkManagerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remaining = MAX_ARTWORKS - artworks.length;

  const accept = (fileList: FileList | null | undefined) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;

    const valid = files.filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type) && f.size <= MAX_IMAGE_BYTES);
    const skipped = files.length - valid.length;
    const toAdd = valid.slice(0, Math.max(0, remaining));

    const problems: string[] = [];
    if (skipped) problems.push(`${skipped} file(s) skipped: use PNG, JPG or WebP under 5 MB.`);
    if (valid.length > toAdd.length) problems.push(`You can add up to ${MAX_ARTWORKS} items.`);
    setError(problems.length ? problems.join(' ') : null);

    if (toAdd.length) {
      const ids = onAdd(toAdd);
      onSelect(ids[ids.length - 1]);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    accept(e.dataTransfer.files);
  };

  return (
    <div className="space-y-4">
      {remaining > 0 && (
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-3 text-center transition ${
              artworks.length ? 'py-3' : 'py-5'
            } ${dragging ? 'border-amber-400/70 bg-amber-400/10' : 'border-white/10 hover:border-white/25 hover:bg-white/5'}`}
          >
            <ImagePlus className="h-5 w-5 text-neutral-500" />
            <p className="mt-1.5 text-sm font-medium">{artworks.length ? 'Add images' : 'Drop logo / artwork'}</p>
            <p className="text-[11px] text-neutral-500">PNG, JPG, WebP · multiple OK</p>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              className="hidden"
              onChange={(e) => {
                accept(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
          <button
            onClick={() => onSelect(onAddText())}
            className="flex w-24 flex-col items-center justify-center rounded-xl border-2 border-dashed border-white/10 px-2 text-center transition hover:border-white/25 hover:bg-white/5"
          >
            <Type className="h-5 w-5 text-neutral-500" />
            <span className="mt-1.5 text-sm font-medium">Add text</span>
          </button>
        </div>
      )}
      <p className="text-[11px] text-neutral-500">
        New items go on the {printSide === 'inside' ? 'inside' : 'outside'} of the box.
        {flexo && ` Flexo prints everything in ${inkName.toLowerCase()} ink.`}
      </p>
      {error && <p className="text-xs text-rose-400">{error}</p>}

      {artworks.length > 0 && (
        <ul className="space-y-2">
          {artworks.map((art) => {
            const active = art.id === selectedId;
            return (
              <li key={art.id}>
                <div
                  className={`flex items-center gap-3 rounded-xl border p-2 transition ${
                    active ? 'border-amber-400/70 bg-amber-400/10 ring-1 ring-amber-400/70' : 'border-white/10 hover:border-white/25'
                  }`}
                >
                  <button
                    onClick={() => onSelect(active ? null : art.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    aria-expanded={active}
                  >
                    {art.kind === 'text' ? (
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/5">
                        <Type className="h-4 w-4 text-amber-400" />
                      </span>
                    ) : (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={art.url} alt="" className="h-10 w-10 shrink-0 rounded-lg bg-white/5 object-contain p-1" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{art.name}</span>
                      <span className="block text-xs text-neutral-500">
                        {faceLabel(art.face)} · {Math.round(art.size * 100)}%{art.rotation ? ` · ${art.rotation}°` : ''}
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={() => onRemove(art)}
                    className="rounded-lg p-2 text-neutral-500 hover:bg-white/10 hover:text-rose-400"
                    aria-label={`Remove ${art.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {active && <ArtworkEditor art={art} flexo={flexo} onChange={(patch) => onUpdate(art.id, patch)} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FaceButtons({ faces, current, onPick }: { faces: { id: Face; label: string }[]; current: Face; onPick: (f: Face) => void }) {
  return (
    <div className="grid grid-cols-6 gap-1">
      {faces.map((f) => (
        <button
          key={f.id}
          onClick={() => onPick(f.id)}
          className={`rounded-lg px-1 py-1.5 text-[11px] font-medium transition ${
            current === f.id ? 'bg-amber-400 text-black' : 'bg-white/[0.04] text-neutral-400 hover:bg-white/10'
          }`}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

function ArtworkEditor({ art, flexo, onChange }: { art: Artwork; flexo: boolean; onChange: (patch: ArtworkPatch) => void }) {
  const text = art.text;

  return (
    <div className="mt-2 space-y-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      {text && (
        <div className="space-y-3">
          <textarea
            value={text.content}
            rows={2}
            maxLength={80}
            onChange={(e) => onChange({ text: { ...text, content: e.target.value } })}
            placeholder="Type your text"
            className="w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-neutral-100 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
          />
          <div className="flex flex-wrap items-center gap-1">
            {FONTS.map((f) => (
              <button
                key={f.id}
                onClick={() => onChange({ text: { ...text, font: f.id } })}
                className={`rounded-lg px-2.5 py-1.5 text-xs transition ${
                  text.font === f.id ? 'bg-amber-400 text-black' : 'bg-white/[0.04] text-neutral-400 hover:bg-white/10'
                }`}
              >
                {f.label}
              </button>
            ))}
            <button
              onClick={() => onChange({ text: { ...text, bold: !text.bold } })}
              aria-pressed={text.bold}
              className={`ml-auto rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${
                text.bold ? 'bg-amber-400 text-black' : 'bg-white/[0.04] text-neutral-400 hover:bg-white/10'
              }`}
            >
              B
            </button>
            {!flexo && (
              <label className="relative grid h-7 w-7 cursor-pointer place-items-center rounded-lg border border-white/15" title="Text colour">
                <span className="h-4 w-4 rounded" style={{ background: text.color }} />
                <input
                  type="color"
                  value={text.color}
                  onChange={(e) => onChange({ text: { ...text, color: e.target.value } })}
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
              </label>
            )}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium text-neutral-400">Outside</p>
        <FaceButtons faces={OUTSIDE_FACES} current={art.face} onPick={(face) => onChange({ face })} />
        <p className="pt-1 text-xs font-medium text-neutral-400">Inside</p>
        <FaceButtons faces={INSIDE_FACES} current={art.face} onPick={(face) => onChange({ face })} />
      </div>

      <RangeControl label="Size" value={Math.round(art.size * 100)} min={10} max={100} unit="%" onChange={(v) => onChange({ size: v / 100 })} />
      <RangeControl label="Left / right" value={Math.round(art.offsetX * 100)} min={-50} max={50} onChange={(v) => onChange({ offsetX: v / 100 })} />
      <RangeControl label="Down / up" value={Math.round(art.offsetY * 100)} min={-50} max={50} onChange={(v) => onChange({ offsetY: v / 100 })} />
      <RangeControl label="Rotation" value={art.rotation} min={-180} max={180} step={5} unit="°" onChange={(v) => onChange({ rotation: v })} />

      <button
        onClick={() => onChange({ size: art.kind === 'text' ? 0.6 : 0.5, offsetX: 0, offsetY: 0, rotation: 0 })}
        className="text-xs font-medium text-amber-400 hover:underline"
      >
        Reset placement
      </button>
    </div>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex justify-between text-xs">
        <span className="font-medium text-neutral-400">{label}</span>
        <span className="tabular-nums text-neutral-500">
          {value}
          {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-amber-400"
      />
    </label>
  );
}

function QuantitySelector({ config, onChange }: { config: BoxConfig; onChange: (q: number) => void }) {
  const { presets, minQty } = PRINT_METHODS[config.printMethod];
  const unitAt = (q: number) => calculatePrice({ ...priceInputOf(config), quantity: q }).unitCost;
  const baseUnit = unitAt(presets[0]);
  const custom = !presets.includes(config.quantity);

  const [draft, setDraft] = useState(custom ? String(config.quantity) : '');
  useEffect(() => {
    if (!presets.includes(config.quantity)) setDraft(String(config.quantity));
  }, [config.quantity, presets]);

  const commit = () => {
    const n = Math.round(Number(draft));
    if (!draft.trim() || Number.isNaN(n)) return;
    const q = clamp(n, minQty, MAX_QTY);
    onChange(q);
    setDraft(String(q));
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {presets.map((q, i) => {
          const unit = unitAt(q);
          const savings = Math.round((1 - unit / baseUnit) * 100);
          const last = i === presets.length - 1;
          const badge = last ? 'Best Value' : i === 1 ? 'Popular' : savings > 0 ? `Save ${savings}%` : null;
          const active = config.quantity === q;

          return (
            <button
              key={q}
              onClick={() => onChange(q)}
              className={`relative rounded-xl border p-3 pt-4 text-left transition ${
                active ? 'border-amber-400/70 bg-amber-400/10 ring-1 ring-amber-400/70' : 'border-white/10 hover:border-white/25'
              }`}
            >
              {badge && (
                <span
                  className={`absolute -top-2 right-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    last ? 'bg-amber-400 text-black' : 'bg-neutral-800 text-neutral-200'
                  }`}
                >
                  {badge}
                </span>
              )}
              <span className="block text-base font-semibold">{q.toLocaleString('en-IN')} units</span>
              <span className="block text-xs text-neutral-500">{inr(unit, 2)} / box</span>
            </button>
          );
        })}
      </div>

      <label
        className={`flex items-center gap-2 rounded-xl border px-3 py-2 transition ${
          custom ? 'border-amber-400/70 bg-amber-400/10' : 'border-white/10'
        }`}
      >
        <span className="text-xs font-medium text-neutral-400">Custom quantity</span>
        <input
          type="number"
          inputMode="numeric"
          min={minQty}
          max={MAX_QTY}
          placeholder={`${minQty}+`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          className="ml-auto w-24 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-right text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
        />
        <span className="text-xs text-neutral-500">boxes</span>
      </label>
    </div>
  );
}

function PricingCard({ config, price, onOrder }: { config: BoxConfig; price: PriceBreakdown; onOrder: () => void }) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const flexo = config.printMethod === 'flexo';

  return (
    <div
      id="pricing"
      className="scroll-mt-24 rounded-3xl border border-amber-400/20 bg-gradient-to-br from-neutral-900 via-neutral-950 to-black p-6 text-white shadow-[0_0_60px_-24px_rgba(245,165,36,0.45)]"
    >
      <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex gap-8">
          <div>
            <p className="text-xs uppercase tracking-wider text-neutral-500">Per box</p>
            <motion.p
              key={price.unitCost}
              initial={{ opacity: 0.4, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="font-display text-3xl font-bold sm:text-4xl"
            >
              {inr(price.unitCost, 2)}
            </motion.p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-neutral-500">
              Total · {config.quantity.toLocaleString('en-IN')} units
            </p>
            <motion.p
              key={price.total}
              initial={{ opacity: 0.4, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="font-display text-3xl font-bold text-amber-300 sm:text-4xl"
            >
              {inr(price.total)}
            </motion.p>
          </div>
        </div>

        <button
          onClick={onOrder}
          className="group inline-flex items-center justify-center gap-2 rounded-full bg-amber-400 px-6 py-3.5 font-semibold text-black shadow-[0_0_40px_-8px_rgba(245,165,36,0.7)] transition hover:bg-amber-300"
        >
          Order Now <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
        </button>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={() => setShowBreakdown((s) => !s)}
          className="text-xs font-medium text-neutral-500 underline-offset-4 hover:text-white hover:underline"
        >
          {showBreakdown ? 'Hide' : 'Show'} price breakdown
        </button>
        <span className="flex items-center gap-1.5 text-xs text-emerald-300">
          <BadgeCheck className="h-3.5 w-3.5" /> Free design review before production
        </span>
      </div>

      <AnimatePresence initial={false}>
        {showBreakdown && (
          <motion.dl
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-4 grid gap-2 border-t border-white/10 pt-4 text-sm sm:grid-cols-2 sm:gap-x-8">
              <Row label="Surface area" value={`${price.surfaceArea.toFixed(1)} sq in`} />
              <Row label="Material cost / box" value={inr(price.baseMaterialCost, 2)} />
              <Row
                label={`Print cost / box${flexo && price.printedSides > 1 ? ` (${price.printedSides} sides)` : ''}`}
                value={inr(price.printCostPerUnit, 2)}
              />
              <Row
                label={
                  price.printedSides === 0
                    ? 'Printing charge'
                    : flexo
                      ? `Printing charge (${price.printedSides} × ${inr(FLEXO_CHARGE_PER_SIDE)})`
                      : 'Offset setup (one-time)'
                }
                value={price.printedSides === 0 ? 'No print' : inr(price.printingCharge)}
              />
            </div>
            <p className="mt-3 text-xs text-neutral-500">Prices exclude GST and shipping.</p>
          </motion.dl>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ================================================================== */
/* How it works + social proof                                        */
/* ================================================================== */

const STEPS = [
  {
    icon: Ruler,
    title: 'Customize Size & Upload Logo in 3D',
    body: 'Dial in exact dimensions, choose a finish, and place your artwork on any side of a live 3D mailer box.',
  },
  {
    icon: Zap,
    title: 'Get Instant Wholesale Price',
    body: 'Transparent per-box and total pricing that updates as you design. No sales calls.',
  },
  {
    icon: Truck,
    title: 'Receive Production-Grade Samples at your Doorstep',
    body: 'Approve your proof, and we dispatch within 7 days, anywhere in India.',
  },
];

// Placeholder testimonials. Replace with real customer quotes before launch.
const TESTIMONIALS = [
  { quote: 'We launched with 200 boxes instead of 5,000. Unboxing finally matches our brand.', name: 'Founder', brand: 'Skincare brand' },
  { quote: 'The 3D preview meant zero surprises. What we saw is exactly what arrived.', name: 'Co-founder', brand: 'Coffee roaster' },
  { quote: 'Instant pricing saved us a week of back-and-forth with vendors.', name: 'Ops lead', brand: 'Apparel label' },
];

function HowItWorks({ onLaunchStudio }: { onLaunchStudio: () => void }) {
  return (
    <section id="how-it-works" className="relative scroll-mt-16 border-t border-white/[0.06] py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading index="02" eyebrow="How it works" title="From idea to doorstep" accent="in three steps." />

        <div className="mt-16 grid gap-5 md:grid-cols-3">
          {STEPS.map(({ icon: Icon, title, body }, i) => (
            <motion.div
              key={title}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ delay: i * 0.12 }}
              className="group relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent p-8 transition hover:border-amber-400/40"
            >
              {/* Hover glow */}
              <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-white/0 blur-3xl transition group-hover:bg-amber-500/20" />
              <span className="font-serif-accent absolute right-6 top-2 text-8xl text-white/[0.06] transition group-hover:text-amber-400/20">
                {i + 1}
              </span>
              <span className="relative grid h-12 w-12 place-items-center rounded-2xl border border-amber-400/30 bg-amber-400/10 text-amber-400">
                <Icon className="h-5 w-5" />
              </span>
              <h3 className="font-display relative mt-6 text-xl font-semibold leading-snug">{title}</h3>
              <p className="relative mt-3 text-sm leading-relaxed text-neutral-400">{body}</p>
            </motion.div>
          ))}
        </div>

        <div className="mt-20 grid gap-5 md:grid-cols-3">
          {TESTIMONIALS.map((t, i) => (
            <motion.figure
              key={t.brand}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ delay: i * 0.12 }}
              className="relative rounded-3xl border border-white/10 bg-white/[0.02] p-8"
            >
              <span className="font-serif-accent absolute -top-5 left-6 text-7xl leading-none text-amber-400">&ldquo;</span>
              <div className="flex gap-0.5 text-amber-400">
                {Array.from({ length: 5 }).map((_, s) => (
                  <Star key={s} className="h-4 w-4 fill-current" />
                ))}
              </div>
              <blockquote className="mt-4 text-lg leading-relaxed text-neutral-200">{t.quote}</blockquote>
              <figcaption className="mt-6 text-sm">
                <span className="font-semibold text-white">{t.name}</span>
                <span className="text-neutral-500"> · {t.brand}</span>
              </figcaption>
            </motion.figure>
          ))}
        </div>

        {/* CTA slab */}
        <div className="relative mt-20 overflow-hidden rounded-[2rem] bg-gradient-to-br from-amber-300 via-amber-500 to-orange-700 p-10 text-black sm:p-14">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(0,0,0,0.15)_1px,transparent_1px)] bg-[size:18px_18px]" />
          <Package className="pointer-events-none absolute -bottom-10 -right-6 h-64 w-64 rotate-12 text-black/10" strokeWidth={1} />
          <div className="relative flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-end">
            <div>
              <h3 className="font-display max-w-2xl text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
                Ditch the 5,000-unit <span className="font-serif-accent">minimum.</span>
              </h3>
              <p className="mt-3 text-lg text-black/70">Design your first 100 boxes in under five minutes.</p>
            </div>
            <button
              onClick={onLaunchStudio}
              className="group inline-flex shrink-0 items-center gap-2 rounded-full bg-black px-7 py-4 font-semibold text-white transition hover:bg-neutral-800"
            >
              Launch 3D Studio <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionHeading({
  index,
  eyebrow,
  title,
  accent,
  subtitle,
}: {
  index: string;
  eyebrow: string;
  title: string;
  accent?: string;
  subtitle?: string;
}) {
  return (
    <div className="mx-auto max-w-3xl text-center">
      <p className="inline-flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.25em] text-amber-400">
        <span className="text-neutral-600">{index}</span>
        <span className="h-px w-8 bg-amber-400/50" />
        {eyebrow}
      </p>
      <h2 className="font-display mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
        {title} {accent && <span className="font-serif-accent text-kraft pr-1">{accent}</span>}
      </h2>
      {subtitle && <p className="mx-auto mt-5 max-w-xl text-neutral-400">{subtitle}</p>}
    </div>
  );
}

function Footer() {
  return (
    <footer className="relative overflow-hidden border-t border-white/[0.06] pt-14">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 text-sm text-neutral-500 sm:flex-row sm:px-6 lg:px-8">
        <Wordmark size="sm" />
        <span>© {new Date().getFullYear()} Kraftify. Low-MOQ packaging, made in India.</span>
      </div>
      {/* Oversized outlined wordmark */}
      <p
        aria-hidden
        className="font-display pointer-events-none mt-6 select-none text-center text-[22vw] font-bold leading-[0.8] tracking-tighter text-transparent [-webkit-text-stroke:1px_rgba(245,165,36,0.18)]"
      >
        Kraftify
      </p>
    </footer>
  );
}

/* ================================================================== */
/* Checkout drawer: Razorpay + WhatsApp                               */
/* ================================================================== */

interface LeadForm {
  brandName: string;
  founderName: string;
  email: string;
  phone: string;
  pincode: string;
}
type FormErrors = Partial<Record<keyof LeadForm, string>>;

const EMPTY_FORM: LeadForm = { brandName: '', founderName: '', email: '', phone: '', pincode: '' };

function validate(f: LeadForm): FormErrors {
  const e: FormErrors = {};
  if (!f.brandName.trim()) e.brandName = 'Brand name is required';
  if (!f.founderName.trim()) e.founderName = 'Your name is required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = 'Enter a valid email';
  if (!/^(\+?91[-]?)?[6-9]\d{9}$/.test(f.phone.replace(/\s/g, ''))) e.phone = 'Enter a valid 10-digit mobile number';
  if (!/^[1-9]\d{5}$/.test(f.pincode.trim())) e.pincode = 'Enter a valid 6-digit pincode';
  return e;
}

const WHATSAPP_NUMBER = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? '919999999999';

type ProofOption = 'review' | 'as-is';

const PROOF_OPTIONS: { id: ProofOption; title: string; body: string }[] = [
  { id: 'review', title: 'Send me a proof to approve', body: 'Our designer checks your artwork and sends a proof before printing.' },
  { id: 'as-is', title: 'Print as designed', body: 'Skip the proof and go straight to production.' },
];

/** One-line print summary, e.g. "Flexo, black ink · 2 sides". */
const printSummary = (config: BoxConfig, price: PriceBreakdown) =>
  price.printedSides === 0
    ? 'No printing (plain box)'
    : `${config.printMethod === 'flexo' ? `Flexo, ${inkOf(config.ink).name.toLowerCase()} ink` : 'Offset, full colour'} · ${
        price.printedSides
      } side${price.printedSides > 1 ? 's' : ''}`;

/** Builds a wa.me deep link with the full order spec URL-encoded. */
function buildWhatsAppUrl(mode: CheckoutMode, form: LeadForm, config: BoxConfig, price: PriceBreakdown, proof: ProofOption) {
  const lines =
    mode === 'sample'
      ? [
          '*Kraftify: Free Sample Kit Request*',
          '',
          `Brand: ${form.brandName}`,
          `Founder: ${form.founderName}`,
          `Email: ${form.email}`,
          `Phone: ${form.phone}`,
          `Delivery pincode: ${form.pincode}`,
        ]
      : [
          '*Kraftify: Quote & 3D Proof Request*',
          '',
          `Brand: ${form.brandName}`,
          `Founder: ${form.founderName}`,
          `Email: ${form.email}`,
          `Phone: ${form.phone}`,
          `Delivery pincode: ${form.pincode}`,
          '',
          '*Box specs*',
          'Style: Mailer box',
          `Size (L × W × H): ${sizeLabel(config)}`,
          `Material: ${materialName(config.material)}`,
          `Base colour: ${config.color.toUpperCase()}`,
          `Printing: ${printSummary(config, price)}`,
          ...(config.artworks.length
            ? [
                `Artwork (${config.artworks.length}, will share image files in this chat):`,
                ...config.artworks.map(
                  (a, i) =>
                    `  ${i + 1}. ${a.kind === 'text' ? `Text "${a.text?.content.replace(/\n/g, ' ')}"` : a.name}: ${faceLabel(
                      a.face,
                    )}, ${Math.round(a.size * 100)}% wide${a.rotation ? `, rotated ${a.rotation}°` : ''}`,
                ),
              ]
            : ['Artwork: None']),
          `Quantity: ${config.quantity.toLocaleString('en-IN')} units`,
          `Proof: ${PROOF_OPTIONS.find((p) => p.id === proof)!.title}`,
          '',
          '*Pricing*',
          `Per box: ${inr(price.unitCost, 2)}`,
          `Printing charge: ${inr(price.printingCharge)}`,
          `Total: ${inr(price.total)} (excl. GST & shipping)`,
        ];

  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;
}

/* ---------- Razorpay loader ---------- */

interface RazorpayInstance {
  open: () => void;
}
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

function loadRazorpay(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);

  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-razorpay]');
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => resolve(true));
    script.addEventListener('error', () => resolve(false));
    if (!existing) {
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.async = true;
      script.dataset.razorpay = 'true';
      document.body.appendChild(script);
    }
  });
}

/* ---------- Drawer ---------- */

interface CheckoutDrawerProps {
  mode: CheckoutMode | null;
  onClose: () => void;
  config: BoxConfig;
  price: PriceBreakdown;
}

function CheckoutDrawer({ mode, onClose, config, price }: CheckoutDrawerProps) {
  const [form, setForm] = useState<LeadForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [status, setStatus] = useState<'idle' | 'paying' | 'paid' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [proof, setProof] = useState<ProofOption>('review');
  const open = mode !== null;

  // Reset transient state each time the drawer opens
  useEffect(() => {
    if (open) {
      setStatus('idle');
      setMessage(null);
      setErrors({});
    }
  }, [open]);

  // Esc to close + body scroll lock
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  const setField = (key: keyof LeadForm, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const checkValid = () => {
    const e = validate(form);
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleWhatsApp = () => {
    if (!mode || !checkValid()) return;
    window.open(buildWhatsAppUrl(mode, form, config, price, proof), '_blank', 'noopener,noreferrer');
  };

  const handlePay = async () => {
    if (!checkValid()) return;

    const key = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    if (!key) {
      setStatus('error');
      setMessage('Online payments are not configured yet. Use WhatsApp to get your quote.');
      return;
    }

    setStatus('paying');
    setMessage(null);

    const loaded = await loadRazorpay();
    if (!loaded || !window.Razorpay) {
      setStatus('error');
      setMessage('Could not load Razorpay. Check your connection and try again.');
      return;
    }

    const rzp = new window.Razorpay({
      key,
      amount: Math.round(price.total * 100), // paise
      currency: 'INR',
      name: 'Kraftify',
      description: `${config.quantity} × Mailer box ${sizeLabel(config)}`,
      // PRODUCTION: create the order server-side (POST /api/razorpay/order) and pass `order_id` here,
      // then verify `razorpay_signature` in a server route before confirming the order.
      prefill: { name: form.founderName, email: form.email, contact: form.phone },
      notes: {
        brand: form.brandName,
        pincode: form.pincode,
        size: sizeLabel(config),
        material: materialName(config.material),
        color: config.color,
        printing: printSummary(config, price),
        quantity: String(config.quantity),
        proof,
      },
      theme: { color: '#f5a524' },
      handler: (res: { razorpay_payment_id: string }) => {
        setStatus('paid');
        setMessage(`Payment received · ID ${res.razorpay_payment_id}`);
      },
      modal: { ondismiss: () => setStatus('idle') },
    });
    rzp.open();
  };

  const isSample = mode === 'sample';

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
          />
          <motion.aside
            key="drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="checkout-title"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-white/10 bg-neutral-950 shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
              <div>
                <h2 id="checkout-title" className="font-display text-lg font-semibold">
                  {isSample ? 'Request Free Sample Kit' : 'Complete your order'}
                </h2>
                <p className="text-xs text-neutral-500">
                  {isSample ? 'Feel our materials and finishes before you order.' : 'Pay online or get your quote on WhatsApp.'}
                </p>
              </div>
              <button onClick={onClose} className="rounded-lg p-2 text-neutral-500 hover:bg-white/10" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
              {status === 'paid' ? (
                <div className="flex flex-col items-center py-12 text-center">
                  <span className="grid h-14 w-14 place-items-center rounded-full bg-emerald-400/15 text-emerald-300">
                    <BadgeCheck className="h-7 w-7" />
                  </span>
                  <h3 className="font-display mt-4 text-xl font-semibold">Order confirmed!</h3>
                  <p className="mt-2 text-sm text-neutral-400">
                    We&apos;ll send your 3D proof to {form.email} within 24 hours.
                  </p>
                  {message && <p className="mt-3 text-xs text-neutral-500">{message}</p>}
                </div>
              ) : (
                <>
                  {/* Order summary */}
                  {!isSample && (
                    <div className="rounded-2xl bg-white/[0.03] p-4">
                      <dl className="space-y-2 text-sm">
                        <Row label="Size" value={sizeLabel(config)} />
                        <Row label="Material" value={materialName(config.material)} />
                        <Row
                          label="Colour"
                          value={
                            <span className="inline-flex items-center gap-2">
                              <span className="h-3.5 w-3.5 rounded-full border border-white/15" style={{ background: config.color }} />
                              {config.color.toUpperCase()}
                            </span>
                          }
                        />
                        <Row label="Printing" value={printSummary(config, price)} />
                        <Row
                          label="Artwork"
                          value={
                            config.artworks.length
                              ? `${config.artworks.length} item(s) · ${[...new Set(config.artworks.map((a) => faceLabel(a.face)))].join(', ')}`
                              : 'None'
                          }
                        />
                        <Row label="Quantity" value={`${config.quantity.toLocaleString('en-IN')} units`} />
                      </dl>
                      <div className="mt-3 flex items-end justify-between border-t border-white/10 pt-3">
                        <span className="text-sm text-neutral-500">{inr(price.unitCost, 2)} / box</span>
                        <span className="font-display text-2xl font-bold">{inr(price.total)}</span>
                      </div>
                    </div>
                  )}

                  {/* Proof approval */}
                  {!isSample && price.printedSides > 0 && (
                    <fieldset className="space-y-2">
                      <legend className="mb-2 text-sm font-medium text-neutral-300">Before we print</legend>
                      {PROOF_OPTIONS.map((p) => (
                        <label
                          key={p.id}
                          className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition ${
                            proof === p.id ? 'border-amber-400/70 bg-amber-400/10' : 'border-white/10 hover:border-white/25'
                          }`}
                        >
                          <input
                            type="radio"
                            name="proof"
                            value={p.id}
                            checked={proof === p.id}
                            onChange={() => setProof(p.id)}
                            className="mt-0.5 accent-amber-400"
                          />
                          <span>
                            <span className="block text-sm font-medium">{p.title}</span>
                            <span className="block text-xs text-neutral-500">{p.body}</span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  )}

                  {/* Lead form */}
                  <div className="grid gap-4">
                    <Field label="Brand name" value={form.brandName} error={errors.brandName} autoComplete="organization" onChange={(e) => setField('brandName', e.target.value)} />
                    <Field label="Founder name" value={form.founderName} error={errors.founderName} autoComplete="name" onChange={(e) => setField('founderName', e.target.value)} />
                    <Field label="Email" type="email" value={form.email} error={errors.email} autoComplete="email" onChange={(e) => setField('email', e.target.value)} />
                    <div className="grid grid-cols-[1fr_120px] gap-3">
                      <Field label="Phone / WhatsApp" type="tel" inputMode="tel" value={form.phone} error={errors.phone} autoComplete="tel" onChange={(e) => setField('phone', e.target.value)} />
                      <Field label="Pincode" inputMode="numeric" maxLength={6} value={form.pincode} error={errors.pincode} autoComplete="postal-code" onChange={(e) => setField('pincode', e.target.value.replace(/\D/g, ''))} />
                    </div>
                  </div>

                  {message && status === 'error' && (
                    <p className="rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{message}</p>
                  )}
                </>
              )}
            </div>

            {/* Actions */}
            {status !== 'paid' && (
              <div className="space-y-3 border-t border-white/10 px-6 py-5">
                {!isSample && (
                  <button
                    onClick={handlePay}
                    disabled={status === 'paying'}
                    className="flex w-full items-center justify-center gap-2 rounded-full bg-amber-400 px-6 py-3.5 font-semibold text-black transition hover:bg-amber-300 disabled:opacity-60"
                  >
                    {status === 'paying' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                    Pay {inr(price.total)} securely
                  </button>
                )}
                <button
                  onClick={handleWhatsApp}
                  className="flex w-full items-center justify-center gap-2 rounded-full bg-[#25D366] px-6 py-3.5 font-semibold text-white transition hover:brightness-95"
                >
                  <MessageCircle className="h-4 w-4" />
                  {isSample ? 'Request kit on WhatsApp' : 'Send Quote & 3D Proof to WhatsApp'}
                </button>
                <p className="flex items-center justify-center gap-1.5 text-xs text-neutral-500">
                  <ShieldCheck className="h-3.5 w-3.5" /> 100% Quality Guarantee · Secure payments by Razorpay
                </p>
              </div>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function Field({ label, error, ...props }: { label: string; error?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-neutral-300">{label}</span>
      <input
        {...props}
        aria-invalid={!!error}
        className={`mt-1.5 w-full rounded-xl border bg-black/40 px-3.5 py-2.5 text-sm text-neutral-100 transition focus:outline-none focus:ring-2 ${
          error ? 'border-rose-500/60 focus:ring-rose-500/30' : 'border-white/10 focus:border-amber-400 focus:ring-amber-400/20'
        }`}
      />
      {error && <span className="mt-1 block text-xs text-rose-400">{error}</span>}
    </label>
  );
}
