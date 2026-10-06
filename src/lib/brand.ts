/**
 * Site identity in one place. Rename the product by editing these values;
 * every page title, footer, PDF producer field and share card reads from here.
 */
export const BRAND = {
  name: "DoYourPDF",
  /** The part of the name shown in the accent colour in the header. */
  accent: "PDF",
  tagline: "Every PDF tool. None of the uploading.",
  description:
    "Free, private PDF tools that work right on your device. Compress, combine, split, sign, edit, convert, OCR and redact PDFs with no uploads and no sign-up.",
  /**
   * Public address, e.g. "https://example.com", used for share cards, canonical links and the sitemap.
   * Filled in automatically on Vercel and Netlify; elsewhere set SITE_URL when building.
   */
  url: __SITE_URL__,
  /**
   * Plausible's script for this site: cookie-free visit counting, loaded only at the
   * address above. The privacy meter lists what it sends. Leave empty to turn it off.
   */
  analytics: "https://plausible.io/js/pa-H7TRr-l2XiAaeSUCD25v9.js",
} as const;
