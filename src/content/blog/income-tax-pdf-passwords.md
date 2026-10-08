---
title: "Passwords for AIS, TIS, ITR-V, Form 26AS and Form 16 PDFs"
seoTitle: "AIS, ITR-V, 26AS and Form 16 PDF passwords"
description: "Most income tax PDFs open with your PAN in small letters plus your birth date as DDMMYYYY, like abcde1234f05031990. The exceptions, with sources."
date: 2026-10-08
tags: [Passwords, Income tax]
tools: [remove-password, merge-pdf]
faq:
  - q: What is the password of the AIS PDF?
    a: Your PAN in small letters followed by your date of birth as DDMMYYYY, with no space. PAN ABCDE1234F and birth date 5 March 1990 give abcde1234f05031990. Companies and firms use their date of incorporation instead.
  - q: What is the password of the ITR-V acknowledgement?
    a: Your PAN in small letters followed by your date of birth as DDMMYYYY, the same pattern as the AIS PDF.
  - q: What is the password of Form 26AS?
    a: Your date of birth as DDMMYYYY, according to tax guides such as TaxGuru. Some guides say only the text download is protected, so the PDF may open without one.
  - q: What is the password of the Form 16 my employer sent?
    a: There is no single rule, because your employer's payroll software sets it. The email that carried it usually says. Many use your PAN, sometimes with your date of birth.
  - q: Can I upload a password-protected PDF to the income tax portal?
    a: No. The income tax department asks for files without password protection. Unlock a copy first with [Remove Password](/remove-password).
---

**Most income tax PDFs open with your PAN in small letters followed by your date of birth as DDMMYYYY.** PAN `ABCDE1234F` and a birth date of 5 March 1990 give `abcde1234f05031990`. That covers the AIS, the TIS, the ITR-V acknowledgement and the 143(1) intimation. Form 26AS and Form 16 work differently.

## Passwords by document

| Document | Password | Example | Source |
| --- | --- | --- | --- |
| AIS (PDF) | PAN in small letters + date of birth as DDMMYYYY | `abcde1234f05031990` | [Income Tax Department](https://www.incometaxindia.gov.in/w/steps-to-access-ais-information-online) |
| AIS (JSON file for the offline utility) | PAN in capitals + date of birth as DDMMYYYY | `ABCDE1234F05031990` | [Income Tax Department](https://www.incometaxindia.gov.in/w/steps-to-access-ais-information-offline) |
| TIS (PDF) | Same as the AIS PDF | `abcde1234f05031990` | [AIS user guide](https://static.insight.gov.in/resources/pdf/AIS%20Portal%20User%20Guide_v5.0.0.pdf) |
| ITR-V acknowledgement | PAN in small letters + date of birth as DDMMYYYY | `abcde1234f05031990` | [ClearTax](https://cleartax.in/s/itr-pdf-password) |
| Intimation under section 143(1) | PAN in small letters + date of birth as DDMMYYYY | `abcde1234f05031990` | [Business Standard](https://www.business-standard.com/finance/personal-finance/i-t-department-s-email-on-tax-returns-how-to-open-pdf-seek-rectification-125050200411_1.html) |
| Form 26AS (from TRACES) | Date of birth as DDMMYYYY | `05031990` | [TaxGuru](https://taxguru.in/income-tax/download-form-26as.html) |
| Form 16 from your employer | Set by your employer's software; no single rule | Check the email | |
| TDS certificate zip from TRACES (for the employer) | The deductor's TAN in capitals | `ABCD12345E` | [TaxGuru](https://taxguru.in/income-tax/open-password-protected-files-income-tax-tds.html) |

For a company, firm or trust, use the date of incorporation or formation where these say date of birth.

<!-- tool:remove-password -->

## The two mistakes almost everyone makes

1. **Capital letters in the PAN.** The AIS and ITR-V want small letters: `abcde1234f`, not `ABCDE1234F`. Only the AIS JSON file for the offline utility wants capitals.
2. **A short date.** Income tax PDFs use all eight digits: `05031990`, not `050390` or `0503`.

## Form 26AS and Form 16 are the odd ones out

Form 26AS comes from TRACES rather than the e-filing portal. Guides such as TaxGuru report your date of birth as DDMMYYYY; others say only the text version is protected. If one fails, try the other, or open it without a password.

Form 16 is issued by your employer, not the tax department. Part A is generated on TRACES, but the PDF you receive is usually made by your employer's payroll software, which sets its own password. The covering email normally explains it.

## Filing with these files

The income tax department asks you not to upload files with password protection ([Income Tax Department](https://www.incometax.gov.in/iec/foportal/scanning-document?mobile-app=1)). To prepare documents for filing or for your CA:

1. Unlock each file with [Remove Password](/remove-password). The files stay on your device.
2. Combine them into one PDF with [Merge PDF](/merge-pdf) if the portal or your CA wants a single file.

## Sources

- [Income Tax Department: access AIS online](https://www.incometaxindia.gov.in/w/steps-to-access-ais-information-online)
- [Income Tax Department: access AIS offline](https://www.incometaxindia.gov.in/w/steps-to-access-ais-information-offline)
- [AIS portal user guide](https://static.insight.gov.in/resources/pdf/AIS%20Portal%20User%20Guide_v5.0.0.pdf)
- [ClearTax: ITR PDF password](https://cleartax.in/s/itr-pdf-password)
- [Business Standard: opening the tax department's intimation PDF](https://www.business-standard.com/finance/personal-finance/i-t-department-s-email-on-tax-returns-how-to-open-pdf-seek-rectification-125050200411_1.html)
- [TaxGuru: download Form 26AS](https://taxguru.in/income-tax/download-form-26as.html)
- [TaxGuru: password-protected income tax and TDS files](https://taxguru.in/income-tax/open-password-protected-files-income-tax-tds.html)
- [Income Tax Department: scanning documents](https://www.incometax.gov.in/iec/foportal/scanning-document?mobile-app=1)
