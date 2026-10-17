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
  Palette,
  Ruler,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  Truck,
  X,
  Zap,
} from 'lucide-react';
import type { ArtworkPlacement, Face, MaterialId } from '@/components/3d/BoxCanvas';

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

const QUANTITIES = [100, 200, 500, 1000] as const;
type Quantity = (typeof QUANTITIES)[number];

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

/** Per-unit print cost (₹), which drops as volume rises: the low-MOQ price-break ladder. */
const PRINT_COST_PER_UNIT: Record<Quantity, number> = { 100: 18, 200: 14, 500: 10, 1000: 7 };
const PRINT_SETUP_FEE = 500;

interface PriceInput {
  length: number;
  width: number;
  height: number;
  material: MaterialId;
  quantity: Quantity;
}

interface PriceBreakdown {
  surfaceArea: number;
  baseMaterialCost: number;
  printCostPerUnit: number;
  unitCost: number;
  setupFee: number;
  total: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 *   Surface Area       = 2 × (L·W + L·H + W·H)
 *   Base Material Cost = Surface Area × Material Rate
 *   Unit Cost          = Base Material Cost + Per-Unit Print Cost
 *   Total              = Unit Cost × Quantity + Setup Fee
 */
function calculatePrice({ length, width, height, material, quantity }: PriceInput): PriceBreakdown {
  const rate = MATERIALS.find((m) => m.id === material)!.rate;
  const surfaceArea = 2 * (length * width + length * height + width * height);
  const baseMaterialCost = round2(surfaceArea * rate);
  const printCostPerUnit = PRINT_COST_PER_UNIT[quantity];
  const unitCost = round2(baseMaterialCost + printCostPerUnit);
  const total = Math.round(unitCost * quantity + PRINT_SETUP_FEE);
  return { surfaceArea, baseMaterialCost, printCostPerUnit, unitCost, setupFee: PRINT_SETUP_FEE, total };
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

/** An uploaded image plus where and how it sits on the box. */
type Artwork = ArtworkPlacement & { name: string };

interface BoxConfig {
  length: number;
  width: number;
  height: number;
  material: MaterialId;
  color: string;
  quantity: Quantity;
  artworks: Artwork[];
}

const DEFAULT_CONFIG: BoxConfig = {
  length: 10,
  width: 8,
  height: 4,
  material: 'kraft',
  color: '#b0855a',
  quantity: 200,
  artworks: [],
};

const FACES: { id: Face; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'front', label: 'Front' },
  { id: 'back', label: 'Back' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
];

const faceLabel = (face: Face) => FACES.find((f) => f.id === face)!.label;

const MAX_ARTWORKS = 10;

const COLOR_SWATCHES = ['#b0855a', '#f5f5f4', '#111827', '#1e3a8a', '#065f46', '#9f1239', '#f59e0b', '#7c3aed'];

const sizeLabel = (c: Pick<BoxConfig, 'length' | 'width' | 'height'>) =>
  `${c.length}" × ${c.width}" × ${c.height}"`;

const materialName = (id: MaterialId) => MATERIALS.find((m) => m.id === id)!.name;

/* ================================================================== */
/* Page                                                               */
/* ================================================================== */

type CheckoutMode = 'order' | 'sample';

export default function HomePage() {
  const [config, setConfig] = useState<BoxConfig>(DEFAULT_CONFIG);
  const [checkoutMode, setCheckoutMode] = useState<CheckoutMode | null>(null);
  // Every object URL handed out, so each can be revoked (no memory leaks)
  const objectUrls = useRef(new Set<string>());

  const price = useMemo(() => calculatePrice(config), [config]);

  const update = useCallback(<K extends keyof BoxConfig>(key: K, value: BoxConfig[K]) => {
    setConfig((c) => ({ ...c, [key]: value }));
  }, []);

  /** Adds files as artworks, filling empty faces first (top → front → right → left → back). */
  const addArtworks = useCallback((files: File[]): string[] => {
    const created = files.map((file) => {
      const url = URL.createObjectURL(file);
      objectUrls.current.add(url);
      return { id: crypto.randomUUID(), url, name: file.name };
    });

    setConfig((c) => {
      const order: Face[] = ['top', 'front', 'right', 'left', 'back'];
      const used = new Set(c.artworks.map((a) => a.face));
      const added = created.map((f) => {
        const face = order.find((o) => !used.has(o)) ?? 'top';
        used.add(face);
        return { ...f, face, size: 0.5, offsetX: 0, offsetY: 0, rotation: 0 };
      });
      return { ...c, artworks: [...c.artworks, ...added] };
    });
    return created.map((f) => f.id);
  }, []);

  const updateArtwork = useCallback((id: string, patch: Partial<ArtworkPlacement>) => {
    setConfig((c) => ({ ...c, artworks: c.artworks.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
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
        onAddArtworks={addArtworks}
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
  const sample = calculatePrice({ ...DEFAULT_CONFIG, quantity: 100 });

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

interface StudioProps {
  config: BoxConfig;
  price: PriceBreakdown;
  update: <K extends keyof BoxConfig>(key: K, value: BoxConfig[K]) => void;
  onAddArtworks: (files: File[]) => string[];
  onUpdateArtwork: (id: string, patch: Partial<ArtworkPlacement>) => void;
  onRemoveArtwork: (art: Artwork) => void;
  onOrder: () => void;
}

function Studio({ config, price, update, onAddArtworks, onUpdateArtwork, onRemoveArtwork, onOrder }: StudioProps) {
  return (
    <section id="studio" className="relative scroll-mt-16 py-24">
      <div className="pointer-events-none absolute left-1/2 top-40 h-[500px] w-[800px] -translate-x-1/2 rounded-full bg-amber-500/[0.07] blur-[120px]" />
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          index="01"
          eyebrow="3D Studio"
          title="Design your box."
          accent="See the price instantly."
          subtitle="Set your size, pick a finish, and place your logo or artwork on any side. The price updates as you go."
        />

        <div className="mt-12 grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
          {/* ---------- Configurator sidebar ---------- */}
          <aside className="order-2 space-y-4 lg:order-1">
            <Panel icon={Ruler} title="Dimensions" hint="Inner size, in inches">
              <div className="space-y-5">
                <DimensionSlider label="Length" value={config.length} min={4} max={16} onChange={(v) => update('length', v)} />
                <DimensionSlider label="Width" value={config.width} min={4} max={14} onChange={(v) => update('width', v)} />
                <DimensionSlider label="Height" value={config.height} min={2} max={8} onChange={(v) => update('height', v)} />
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

            <Panel icon={ImagePlus} title="Logo & artwork" hint={`${config.artworks.length}/${MAX_ARTWORKS} images`}>
              <ArtworkManager
                artworks={config.artworks}
                onAdd={onAddArtworks}
                onUpdate={onUpdateArtwork}
                onRemove={onRemoveArtwork}
              />
            </Panel>

            <Panel icon={Boxes} title="Quantity" hint="Low MOQ: start at 100">
              <QuantitySelector config={config} onChange={(q) => update('quantity', q)} />
            </Panel>
          </aside>

          {/* ---------- Canvas + pricing ---------- */}
          <div className="order-1 space-y-4 self-start lg:sticky lg:top-24 lg:order-2">
            <div className="relative h-[380px] overflow-hidden rounded-3xl border border-white/10 bg-[radial-gradient(ellipse_at_50%_40%,#2a2117_0%,#0e0e0e_55%,#050505_100%)] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] sm:h-[480px] lg:h-[540px]">
              <BoxCanvas
                length={config.length}
                width={config.width}
                height={config.height}
                color={config.color}
                material={config.material}
                artworks={config.artworks}
              />
              <div className="pointer-events-none absolute left-4 top-4 flex flex-wrap gap-2">
                <Chip>{sizeLabel(config)}</Chip>
                <Chip>{materialName(config.material)}</Chip>
              </div>
              <div className="pointer-events-none absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur">
                <MousePointer2 className="h-3.5 w-3.5" /> Drag to rotate · Scroll to zoom
              </div>
            </div>

            <PricingCard config={config} price={price} onOrder={onOrder} />
          </div>
        </div>
      </div>
    </section>
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
  hint?: string;
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

function DimensionSlider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  // Local draft lets users type "12" without being clamped mid-keystroke
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const n = parseFloat(draft);
    const next = Number.isNaN(n) ? value : clamp(Math.round(n * 2) / 2, min, max);
    onChange(next);
    setDraft(String(next));
  };

  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-neutral-300">{label}</span>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={0.5}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            className="w-16 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-right text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
          />
          <span className="text-xs text-neutral-500">in</span>
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
        <span>{min}&quot;</span>
        <span>{max}&quot;</span>
      </div>
    </div>
  );
}

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface ArtworkManagerProps {
  artworks: Artwork[];
  onAdd: (files: File[]) => string[];
  onUpdate: (id: string, patch: Partial<ArtworkPlacement>) => void;
  onRemove: (art: Artwork) => void;
}

/** Upload several images, then place each one on any face with size / position / rotation controls. */
function ArtworkManager({ artworks, onAdd, onUpdate, onRemove }: ArtworkManagerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = artworks.find((a) => a.id === selectedId) ?? null;
  const remaining = MAX_ARTWORKS - artworks.length;

  const accept = (fileList: FileList | null | undefined) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;

    const valid = files.filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type) && f.size <= MAX_IMAGE_BYTES);
    const skipped = files.length - valid.length;
    const toAdd = valid.slice(0, Math.max(0, remaining));

    const problems: string[] = [];
    if (skipped) problems.push(`${skipped} file(s) skipped: use PNG, JPG or WebP under 5 MB.`);
    if (valid.length > toAdd.length) problems.push(`You can add up to ${MAX_ARTWORKS} images.`);
    setError(problems.length ? problems.join(' ') : null);

    if (toAdd.length) {
      const ids = onAdd(toAdd);
      setSelectedId(ids[ids.length - 1]);
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
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 text-center transition ${
            artworks.length ? 'py-3' : 'py-6'
          } ${dragging ? 'border-amber-400/70 bg-amber-400/10' : 'border-white/10 hover:border-white/25 hover:bg-white/5'}`}
        >
          <ImagePlus className="h-6 w-6 text-neutral-500" />
          <p className="mt-2 text-sm font-medium">{artworks.length ? 'Add more images' : 'Drop your logo or artwork here'}</p>
          <p className="text-xs text-neutral-500">Multiple files OK · PNG with transparency works best</p>
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
      )}
      {error && <p className="text-xs text-rose-400">{error}</p>}

      {/* Uploaded artwork list */}
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
                    onClick={() => setSelectedId(active ? null : art.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    aria-expanded={active}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={art.url} alt="" className="h-10 w-10 shrink-0 rounded-lg bg-white/5 object-contain p-1" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{art.name}</span>
                      <span className="block text-xs text-neutral-500">
                        {faceLabel(art.face)} · {Math.round(art.size * 100)}%{art.rotation ? ` · ${art.rotation}°` : ''}
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      if (active) setSelectedId(null);
                      onRemove(art);
                    }}
                    className="rounded-lg p-2 text-neutral-500 hover:bg-white/10 hover:text-rose-600"
                    aria-label={`Remove ${art.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {/* Placement editor for the selected artwork */}
                {active && selected && (
                  <ArtworkEditor art={selected} onChange={(patch) => onUpdate(selected.id, patch)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ArtworkEditor({ art, onChange }: { art: Artwork; onChange: (patch: Partial<ArtworkPlacement>) => void }) {
  return (
    <div className="mt-2 space-y-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div>
        <p className="mb-2 text-xs font-medium text-neutral-400">Box side</p>
        <div className="grid grid-cols-5 gap-1">
          {FACES.map((f) => (
            <button
              key={f.id}
              onClick={() => onChange({ face: f.id })}
              className={`rounded-lg px-1 py-1.5 text-xs font-medium transition ${
                art.face === f.id ? 'bg-amber-400 text-black' : 'bg-white/[0.04] text-neutral-400 hover:bg-white/10'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <RangeControl
        label="Size"
        value={Math.round(art.size * 100)}
        min={10}
        max={100}
        unit="%"
        onChange={(v) => onChange({ size: v / 100 })}
      />
      <RangeControl
        label="Left / right"
        value={Math.round(art.offsetX * 100)}
        min={-50}
        max={50}
        onChange={(v) => onChange({ offsetX: v / 100 })}
      />
      <RangeControl
        label="Down / up"
        value={Math.round(art.offsetY * 100)}
        min={-50}
        max={50}
        onChange={(v) => onChange({ offsetY: v / 100 })}
      />
      <RangeControl
        label="Rotation"
        value={art.rotation}
        min={-180}
        max={180}
        step={5}
        unit="°"
        onChange={(v) => onChange({ rotation: v })}
      />

      <button
        onClick={() => onChange({ size: 0.5, offsetX: 0, offsetY: 0, rotation: 0 })}
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

function QuantitySelector({ config, onChange }: { config: BoxConfig; onChange: (q: Quantity) => void }) {
  const unitAt = (q: Quantity) => calculatePrice({ ...config, quantity: q }).unitCost;
  const baseUnit = unitAt(100);

  return (
    <div className="grid grid-cols-2 gap-2">
      {QUANTITIES.map((q) => {
        const unit = unitAt(q);
        const savings = Math.round((1 - unit / baseUnit) * 100);
        const badge = q === 1000 ? 'Best Value' : q === 200 ? 'Popular' : savings > 0 ? `Save ${savings}%` : null;
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
                  q === 1000 ? 'bg-amber-400 text-black' : 'bg-neutral-800 text-neutral-200'
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
  );
}

function PricingCard({ config, price, onOrder }: { config: BoxConfig; price: PriceBreakdown; onOrder: () => void }) {
  const [showBreakdown, setShowBreakdown] = useState(false);

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
            <p className="text-xs uppercase tracking-wider text-neutral-500">Total · {config.quantity} units</p>
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

      <button
        onClick={() => setShowBreakdown((s) => !s)}
        className="mt-5 text-xs font-medium text-neutral-500 underline-offset-4 hover:text-white hover:underline"
      >
        {showBreakdown ? 'Hide' : 'Show'} price breakdown
      </button>

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
              <Row label="Print cost / box" value={inr(price.printCostPerUnit, 2)} />
              <Row label="Print setup (one-time)" value={inr(price.setupFee)} />
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

/** Builds a wa.me deep link with the full order spec URL-encoded. */
function buildWhatsAppUrl(mode: CheckoutMode, form: LeadForm, config: BoxConfig, price: PriceBreakdown) {
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
          ...(config.artworks.length
            ? [
                `Artwork (${config.artworks.length}, will share files in this chat):`,
                ...config.artworks.map(
                  (a, i) =>
                    `  ${i + 1}. ${a.name}: ${faceLabel(a.face)}, ${Math.round(a.size * 100)}% wide${
                      a.rotation ? `, rotated ${a.rotation}°` : ''
                    }`,
                ),
              ]
            : ['Artwork: None']),
          `Quantity: ${config.quantity} units`,
          '',
          '*Pricing*',
          `Per box: ${inr(price.unitCost, 2)}`,
          `Print setup: ${inr(price.setupFee)}`,
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
    window.open(buildWhatsAppUrl(mode, form, config, price), '_blank', 'noopener,noreferrer');
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
        quantity: String(config.quantity),
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
                        <Row
                          label="Artwork"
                          value={
                            config.artworks.length
                              ? `${config.artworks.length} image(s) · ${[...new Set(config.artworks.map((a) => faceLabel(a.face)))].join(', ')}`
                              : 'None'
                          }
                        />
                        <Row label="Quantity" value={`${config.quantity} units`} />
                      </dl>
                      <div className="mt-3 flex items-end justify-between border-t border-white/10 pt-3">
                        <span className="text-sm text-neutral-500">{inr(price.unitCost, 2)} / box</span>
                        <span className="font-display text-2xl font-bold">{inr(price.total)}</span>
                      </div>
                    </div>
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
