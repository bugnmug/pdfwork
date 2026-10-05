/**
 * Site identity in one place. Rename the product by editing these values;
 * every page title, footer, PDF producer field and share card reads from here.
 */
export const BRAND = {
  name: "SpitePDF",
  /** The part of the name shown in the accent colour in the header. */
  accent: "PDF",
  tagline: "Every PDF tool. None of the uploading.",
  description:
    "Free PDF tools that run in your browser. Merge, split, compress, convert, edit, sign, OCR and redact. No upload, no watermark, no account.",
  /**
   * Public address, e.g. "https://example.com", used for share cards, canonical links and the sitemap.
   * Filled in automatically on Vercel and Netlify; elsewhere set SITE_URL when building.
   */
  url: __SITE_URL__,
} as const;
