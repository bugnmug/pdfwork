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
  /** Public URL once deployed, used for share cards. Leave empty to use relative URLs. */
  url: "",
} as const;
