---
title: "Masked Aadhaar: how to hide your Aadhaar number in a PDF"
seoTitle: "Masked Aadhaar: hide the first 8 digits in a PDF, free"
description: "A masked Aadhaar shows only the last four digits of your number. Download one from UIDAI, or mask a copy you already have, on your own device."
date: 2026-10-08
tags: [Aadhaar, Privacy]
tools: [redact-pdf, auto-redact, remove-password]
faq:
  - q: What is a masked Aadhaar?
    a: An e-Aadhaar in which the first eight digits of the Aadhaar number are replaced with xxxx-xxxx, so only the last four digits show, such as xxxx-xxxx-9012.
  - q: How do I download a masked Aadhaar?
    a: On UIDAI's myAadhaar website, choose to download your Aadhaar and tick the option for a masked Aadhaar before downloading. It opens with the same password as a regular e-Aadhaar.
  - q: Can I mask the Aadhaar number in a PDF I already have?
    a: Yes. In [Redact PDF](/redact-pdf), search for the first eight digits or draw a box over them on every page where the number appears, then save. The digits are removed from the file, not just covered.
  - q: Is drawing a black box over the number enough?
    a: Not in most PDF editors. A drawn box only hides the digits on screen; they can still be copied or found by search. Use a redaction tool that deletes what is underneath, and test the result by searching for the digits.
  - q: What is the password of a masked Aadhaar?
    a: The same as for any e-Aadhaar, the first four letters of your name in capitals plus your year of birth, such as RAHU1990. See [e-Aadhaar PDF password](/blog/e-aadhaar-pdf-password).
---

**A masked Aadhaar shows only the last four digits of your Aadhaar number, as `xxxx-xxxx-9012`. Download one from UIDAI, or mask a copy you already have by redacting the first eight digits.** Either way, the full number never has to travel with the document.

## Option 1: download a masked Aadhaar from UIDAI

UIDAI offers a masked version of every e-Aadhaar, with the first eight digits replaced by `xxxx-xxxx` ([UIDAI](https://uidai.gov.in/en/my-aadhaar/get-aadhaar)):

1. Go to UIDAI's myAadhaar website and choose to download your Aadhaar.
2. Sign in with your Aadhaar number and the OTP sent to your registered mobile.
3. Tick the option for a **masked Aadhaar** before downloading.
4. Open the PDF with the usual password: the first four letters of your name in capitals plus your year of birth ([details](/blog/e-aadhaar-pdf-password)).

This is the best option when you can do it: the document stays digitally signed by UIDAI.

## Option 2: mask a copy you already have

If you only have a full e-Aadhaar, a scan or a photo, hide the first eight digits yourself with [Redact PDF](/redact-pdf):

1. If the PDF is password-protected, unlock a copy first with [Remove Password](/remove-password).
2. Open the copy in [Redact PDF](/redact-pdf).
3. Search for the first eight digits as they appear, such as `1234 5678`, and mark every match. On a scan or photo, drag a box over them instead.
4. Check every place the number appears; an e-Aadhaar prints it more than once.
5. Press **Redact and save**.

<!-- tool:redact-pdf -->

Redaction deletes the digits from the file: the page under each box is redrawn without them, so they can't be copied, searched or recovered. To check, open the result and search for the digits. Everything happens in your browser; the Aadhaar is never uploaded.

To hide the whole number instead, [Auto-Redact PII](/auto-redact) finds every Aadhaar number in a document (it checks the digits the way UIDAI's numbers are built) along with PAN, phone numbers and more, and lets you review the matches before removing them.

## Don't just draw a black box

Most PDF editors' boxes are only a layer on top. The digits underneath are still in the file, and anyone can copy them out. This is how text under black boxes leaked from the US Justice Department's Epstein files in December 2025 ([Mediaite](https://www.mediaite.com/media/news/doj-redactions-of-some-epstein-files-easily-revealed-with-copy-and-paste)). A redaction tool deletes what is underneath; a highlighter or shape tool doesn't.

## When to share a masked copy

Use a masked Aadhaar when someone needs proof of identity or address but not the number itself, such as a hotel check-in or a rental agreement. If an organisation needs the full number, it will ask for it; share the full copy only then.

## Sources

- [UIDAI: Get Aadhaar (e-Aadhaar and masked Aadhaar)](https://uidai.gov.in/en/my-aadhaar/get-aadhaar)
- [Mediaite: Epstein file redactions revealed by copy and paste](https://www.mediaite.com/media/news/doj-redactions-of-some-epstein-files-easily-revealed-with-copy-and-paste)
