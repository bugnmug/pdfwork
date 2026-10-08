---
title: "e-PAN card PDF password: it's your date of birth"
seoTitle: "e-PAN card PDF password (Protean and UTIITSL)"
description: "An e-PAN PDF from Protean (NSDL) or UTIITSL opens with your date of birth as DDMMYYYY, like 05031990. Companies use the date of incorporation."
date: 2026-10-08
tags: [Passwords, PAN]
tools: [remove-password, redact-pdf]
faq:
  - q: What is the password of an e-PAN card PDF?
    a: Your date of birth as eight digits, day then month then year, with no slashes. Born on 5 March 1990, you type 05031990.
  - q: What is the e-PAN password for a company or firm?
    a: The date of incorporation or formation, in the same DDMMYYYY form.
  - q: Is the password different for UTIITSL e-PAN?
    a: "Guides report the same format for UTIITSL as for Protean (NSDL): your date of birth as DDMMYYYY."
  - q: Can I remove the password from my e-PAN?
    a: Yes. [Remove Password](/remove-password) makes an unlocked copy on your device. Keep the original download as well, since it carries the issuer's digital signature intact.
---

**An e-PAN PDF opens with your date of birth as eight digits: day, month, year, no slashes.** Born on 5 March 1990, you type `05031990`. Protean (formerly NSDL e-Gov) states this for the e-PAN it issues ([Protean](https://www.proteantech.in/articles/download-e-pan-card-using-pan-number)), and guides report the same for UTIITSL ([Motilal Oswal](https://www.motilaloswal.com/personal-finance/pan-card/how-to-download-e-pan-card-online-nsdl-and-utiitsl)).

| Who | Password | Example |
| --- | --- | --- |
| A person | Date of birth as DDMMYYYY | `05031990` |
| A company, firm or trust | Date of incorporation or formation as DDMMYYYY | `14082015` |

## Why it fails

- **Slashes or dashes.** `05/03/1990` fails; type only the digits.
- **A two-digit year.** `050390` fails; use all four digits of the year.
- **Month first.** `03051990` is 3 May, not 5 March.
- **A different date on record.** Use the date of birth your PAN record has, which is the one printed on the card.

## Unlock it for uploads

Many forms want a PAN copy that opens without a password. Once you know it:

<!-- tool:remove-password -->

1. Open [Remove Password](/remove-password) and choose your e-PAN.
2. Type your date of birth once.
3. Download the unlocked copy. Nothing is uploaded; your browser does the work.

Keep the original download as well: like e-Aadhaar, an e-PAN is digitally signed, and changing the file in any way means the signature no longer checks out. If you are sharing the copy widely, consider blacking out what the recipient doesn't need with [Redact PDF](/redact-pdf).

## Sources

- [Protean: download e-PAN using your PAN](https://www.proteantech.in/articles/download-e-pan-card-using-pan-number)
- [Motilal Oswal: download e-PAN from NSDL and UTIITSL](https://www.motilaloswal.com/personal-finance/pan-card/how-to-download-e-pan-card-online-nsdl-and-utiitsl)
