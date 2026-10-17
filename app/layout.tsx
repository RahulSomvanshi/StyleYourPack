import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter, Instrument_Serif, Space_Grotesk } from 'next/font/google';
import './globals.css';

// Body font: crisp, highly legible UI sans
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

// Display font: geometric headlines
const display = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['500', '600', '700'],
  display: 'swap',
});

// Editorial serif italic for accent words in headlines
const serif = Instrument_Serif({
  subsets: ['latin'],
  variable: '--font-serif',
  weight: '400',
  style: ['normal', 'italic'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Kraftify — Custom Printed Boxes from 100 Units',
  description:
    'Design custom mailer boxes in 3D, get instant wholesale pricing, and order premium packaging without 5,000 unit minimums.',
  openGraph: {
    title: 'Kraftify — Low-MOQ Packaging Studio for D2C Brands',
    description: 'Design in 3D. Instant pricing. Starting at just 100 units.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#000000',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable} ${serif.variable}`}>
      <body className="grain bg-black text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
