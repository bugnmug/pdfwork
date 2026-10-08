---
title: "e-Aadhaar PDF password: the format, with examples"
seoTitle: "e-Aadhaar PDF password format, with examples"
description: "The e-Aadhaar password is the first four letters of your name in capitals plus your year of birth, like RAHU1990. Examples for short names, spaces and initials."
date: 2026-10-08
tags: [Aadhaar, Passwords]
tools: [remove-password, redact-pdf]
faq:
  - q: What is the password to open e-Aadhaar?
    a: The first four letters of your name as printed on your Aadhaar, in capital letters, followed by your year of birth. For RAHUL KUMAR born in 1990, it is RAHU1990.
  - q: Is the password for a masked Aadhaar different?
    a: No. A masked e-Aadhaar is the same download with the first eight digits of the number hidden, and it opens with the same password.
  - q: What if my name has fewer than four letters?
    a: Use the whole name. UIDAI's own example is RIA, born in 1990, whose password is RIA1990.
  - q: Do I type the space or the dot in my name?
    a: Spaces are skipped, so SAI KUMAR becomes SAIK1990. A dot that is part of the name stays, so P. KUMAR becomes P.KU1990.
  - q: Can I remove the password from my e-Aadhaar?
    a: Yes, if you know it. Open [Remove Password](/remove-password), type the password once and download a copy that opens without one. The file is processed on your device and never uploaded. Keep the original download too, because only the original carries UIDAI's digital signature intact.
---

**The e-Aadhaar password is the first four letters of your name in CAPITAL letters, followed by your year of birth in four digits.** For RAHUL KUMAR, born in 1990, the password is `RAHU1990`. UIDAI uses the same rule for every e-Aadhaar, including the masked version ([UIDAI](https://uidai.gov.in/en/283-faqs/aadhaar-online-services/e-aadhaar/1891-what-is-the-password-of-e-aadhaar.html)).

## Examples

These are the cases UIDAI itself uses to explain the rule:

| Name on Aadhaar | Year of birth | Password |
| --- | --- | --- |
| SURESH KUMAR | 1990 | `SURE1990` |
| SAI KUMAR | 1990 | `SAIK1990` |
| P. KUMAR | 1990 | `P.KU1990` |
| RIA | 1990 | `RIA1990` |

## The rule, step by step

1. Take your name exactly as it is printed in English on your Aadhaar. Not a nickname, and not the spelling on your PAN or passport.
2. Write it in capital letters.
3. Take the first four characters, skipping spaces. If your first name is shorter than four letters, carry on into the next word: SAI KUMAR gives `SAIK`.
4. Keep a dot if it is part of the name: P. KUMAR gives `P.KU`. If the whole name has fewer than four letters, use all of it.
5. Add your year of birth with no space: `SAIK` + `1990` = `SAIK1990`.

## Why the password isn't working

- **Small letters.** `rahu1990` fails. The letters must be capitals.
- **The full date of birth.** Only the year counts. `RAHU05031990` fails.
- **A different spelling.** The password follows UIDAI's record of your name. If your Aadhaar says MOHD RAFI, the password starts `MOHD`, not `MOHA` as in MOHAMMED.
- **The phone keyboard.** Autocorrect can add a space or capitalise only the first letter. Type slowly, or paste the password from a notes app.
- **A different year.** Use the year printed on your Aadhaar, even if your other documents show another.

## How to stop typing the password every time

If you open your e-Aadhaar often, or a website refuses password-protected files, make an unlocked copy:

1. Open [Remove Password](/remove-password).
2. Choose your e-Aadhaar PDF and type the password once.
3. Download the copy. It opens without a password.

<!-- tool:remove-password -->

The file is opened and unlocked inside your browser, so your Aadhaar is never uploaded to a server. Keep the unlocked copy private: anyone who gets it can open it.

**Keep the original download as well.** e-Aadhaar is digitally signed by UIDAI ([UIDAI](https://uidai.gov.in/en/my-aadhaar/get-aadhaar)). Any change to the file, including removing the password, means the signature no longer checks out. If an office wants to verify your e-Aadhaar's signature, send the original.

## Share less: the masked Aadhaar

A masked e-Aadhaar shows only the last four digits of your Aadhaar number, as `xxxx-xxxx-1234`, and opens with the same password. You can choose it when you download your e-Aadhaar from UIDAI's myAadhaar website. If you already have a full copy, you can [hide the first eight digits yourself](/blog/mask-aadhaar-number-in-pdf).

## Sources

- [UIDAI: What is the password of e-Aadhaar?](https://uidai.gov.in/en/283-faqs/aadhaar-online-services/e-aadhaar/1891-what-is-the-password-of-e-aadhaar.html)
- [UIDAI: Get Aadhaar (e-Aadhaar and masked Aadhaar)](https://uidai.gov.in/en/my-aadhaar/get-aadhaar)
