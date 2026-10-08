---
title: "Is it safe to upload documents to free PDF websites?"
seoTitle: "Is it safe to upload PDFs to online converters?"
description: "Big PDF sites delete uploads within hours, but scam converters steal data. How to tell if a tool uploads your file, and safer ways to handle private documents."
date: 2026-10-08
tags: [Privacy, How-to]
tools: [remove-password, compress-pdf, privacy-scanner]
faq:
  - q: Is iLovePDF safe?
    a: iLovePDF is a long-running company that says it encrypts transfers and deletes processed files within two hours. The remaining risk is that your document sits on its servers in the meantime. For Aadhaar, bank statements and contracts, a tool that never uploads the file removes that question.
  - q: Is Smallpdf safe?
    a: Smallpdf says it deletes uploaded files after one hour. Like any upload-based site, your document is copied to its servers while it works. Sensitive files are better handled by a tool that runs on your device.
  - q: Can online PDF converters steal your data?
    a: Fake ones can. In March 2025 the FBI warned that some free online converters scrape uploaded files for ID numbers, banking details and passwords, and install malware.
  - q: How can I tell if a PDF tool uploads my file?
    a: Load the tool, switch off your internet, then run the task. If it still works, the file was processed on your device. DoYourPDF also shows a meter counting every byte of your files sent anywhere.
  - q: Which documents should I never upload?
    a: "Anything that identifies you or your money: Aadhaar, PAN, passport, bank and card statements, salary slips, Form 16, medical reports, signed contracts and your employer's documents."
---

**Uploading a PDF to a well-known site such as iLovePDF or Smallpdf is reasonably safe, because they delete files within hours. But fake converter sites do steal data, and even a reputable site keeps a copy of your document on its servers while it works.** For an Aadhaar card, a bank statement or a contract, use a tool that processes the file on your own device, so there is nothing to trust in the first place.

## What happens when you upload a PDF

Upload-based sites copy your file to their servers, process it there and send the result back. Then they delete it, on their own schedule:

| Site | Where your file goes | When it is deleted |
| --- | --- | --- |
| iLovePDF | Its servers | Within 2 hours ([iLovePDF](https://www.ilovepdf.com/help/security)) |
| Smallpdf | Its servers | After 1 hour ([Smallpdf](https://smallpdf.com/blog/is-smallpdf-safe)) |
| Sejda | Its servers | After processing ([Sejda](https://www.sejda.com/)) |
| PDF24 | Its servers | After a short time ([PDF24](https://tools.pdf24.org/en/)) |
| DoYourPDF | Stays on your device | Never uploaded |

These companies describe encrypted transfers and automatic deletion, and we know of no evidence that they misuse files. The point is simpler: while your file is on someone else's server, its safety depends on them.

## What has actually gone wrong

- **Fake converters.** In March 2025 the FBI's Denver office warned that some free online file converters do convert your file, but also scrape it for personal information such as ID numbers, dates of birth, banking details and passwords, and can install malware ([FBI](https://www.fbi.gov/contact-us/field-offices/denver/news/fbi-denver-warns-of-online-file-converter-scam)).
- **Leaky storage.** In July 2024, researchers found that two converter sites, PDF Pro and Help PDF, had left 89,062 uploaded files open to anyone, including passports, IDs and contracts ([BGR](https://bgr.com/tech/online-pdf-converters-leaked-thousands-of-user-uploaded-documents/)).
- **Government advice.** India's National Informatics Centre tells government staff not to use outside websites or cloud services to convert or compress government documents ([NIC guidelines](https://avnl.co.in/files/avnl_documents/Cyber-do-dont.pdf)).

## How to check whether a tool uploads your file

1. **The airplane mode test.** Open the tool, switch off Wi-Fi and mobile data, then run the task. If it still works, the file never left your device.
2. **Watch the network.** On a computer, open the browser's developer tools, choose the Network tab and run the task. A large upload the size of your file means it went to a server.
3. **Read the privacy page.** Words like "uploaded", "our servers" and "deleted after" tell you the file leaves your device.

DoYourPDF shows a meter in the top bar counting every byte of your files sent anywhere. Run any tool and it stays at 0 B.

<!-- tool:privacy-scanner -->

## Documents you shouldn't upload

- Aadhaar, PAN, passport, voter ID and driving licence
- Bank and credit card statements, salary slips, Form 16 and ITR documents
- Medical reports and insurance papers
- Signed contracts, offer letters and anything from your employer

## Safer ways to work with them

- **Tools that run in your browser without uploading.** All 75 DoYourPDF tools work this way, from [Compress PDF](/compress-pdf) to [Remove Password](/remove-password).
- **Desktop software that works offline.** Several PDF companies offer desktop apps that process files on your computer.
- **The source itself.** For example, download a masked e-Aadhaar straight from UIDAI instead of editing a full copy ([how to mask Aadhaar](/blog/mask-aadhaar-number-in-pdf)).

Before you share a document, the [Privacy Risk Scanner](/privacy-scanner) shows what personal data and hidden information it contains, also without uploading it.

## Sources

- [FBI Denver: online file converter scam](https://www.fbi.gov/contact-us/field-offices/denver/news/fbi-denver-warns-of-online-file-converter-scam) (7 March 2025)
- [BGR: online PDF converters leaked user documents](https://bgr.com/tech/online-pdf-converters-leaked-thousands-of-user-uploaded-documents/) (11 July 2024)
- [NIC cyber security dos and don'ts](https://avnl.co.in/files/avnl_documents/Cyber-do-dont.pdf)
- [iLovePDF: security](https://www.ilovepdf.com/help/security)
- [Smallpdf: is Smallpdf safe?](https://smallpdf.com/blog/is-smallpdf-safe)
- [Sejda](https://www.sejda.com/), [PDF24](https://tools.pdf24.org/en/)
