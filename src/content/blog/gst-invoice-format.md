---
title: "GST invoice format: the fields a tax invoice must have"
seoTitle: "GST invoice format: mandatory fields under Rule 46"
description: "Every field a GST tax invoice must carry under Rule 46, how many HSN digits to use, when e-invoicing applies, and a free generator that fills it in for you."
date: 2026-10-08
tags: [GST, Business]
tools: [gst-invoice, gst-filing, pos-bill]
faq:
  - q: What are the mandatory fields in a GST invoice?
    a: The supplier's name, address and GSTIN; a unique serial number of up to 16 characters; the date; the recipient's details; HSN or SAC codes; description, quantity and value of each item; taxable value; tax rates and amounts; place of supply; whether reverse charge applies; and the supplier's signature. The full list is in Rule 46 of the CGST Rules.
  - q: How many digits of HSN code must I show?
    a: With annual turnover up to Rs 5 crore, 4 digits on invoices to registered buyers (B2B). Above Rs 5 crore, 6 digits on all invoices.
  - q: When is e-invoicing mandatory?
    a: For businesses with aggregate turnover above Rs 5 crore in any year since 2017-18, from 1 August 2023. Their B2B invoices must be reported to the Invoice Registration Portal to get an IRN and QR code.
  - q: CGST and SGST or IGST, which one applies?
    a: If the place of supply is in the same state as the supplier, charge CGST and SGST. If it is in another state, charge IGST.
  - q: Is there a free GST invoice generator?
    a: Yes. [GST Invoice Generator](/gst-invoice) works out CGST and SGST or IGST from the state codes, adds the HSN summary, amount in words and a UPI QR code, and saves the PDF without uploading your data.
---

**A GST tax invoice must carry the fields listed in Rule 46 of the CGST Rules: who supplied what to whom, when, under which serial number, with HSN codes, values, tax rates and amounts, the place of supply, the reverse-charge status and the supplier's signature** ([CBIC](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html)). Here is the full list, in plain words.

## The fields a tax invoice must have

| Field | What to write |
| --- | --- |
| Supplier | Name, address and GSTIN |
| Invoice number | Consecutive serial number, up to 16 characters (letters, numbers, `-` and `/`), unique for the financial year |
| Date | Date of issue |
| Recipient (registered) | Name, address and GSTIN or UIN |
| Recipient (unregistered) | Name, address and delivery address with the state's name and code, when the taxable value is Rs 50,000 or more, or when the buyer asks |
| HSN or SAC code | For each item; digits as below |
| Description | Of the goods or services |
| Quantity | For goods, with the unit or UQC |
| Total value | Of the supply |
| Taxable value | After any discount or abatement |
| Tax rates | CGST, SGST or UTGST, IGST and cess, as they apply |
| Tax amounts | For each tax charged |
| Place of supply | With the state's name, for supplies between states |
| Delivery address | When it differs from the place of supply |
| Reverse charge | Whether tax is payable on reverse charge |
| Signature | Of the supplier or an authorised person, or a digital signature |

## How many HSN digits

| Annual turnover | Invoices to registered buyers (B2B) | Invoices to consumers (B2C) |
| --- | --- | --- |
| Up to Rs 5 crore | 4 digits | Optional |
| Above Rs 5 crore | 6 digits | 6 digits |

Source: [GST Council](https://gstcouncil.gov.in/sites/default/files/2024-02/press_release_hs_code_sac_issue.pdf).

## When e-invoicing applies

- **Turnover above Rs 5 crore:** since 1 August 2023, B2B invoices must be reported to the Invoice Registration Portal, which returns an IRN and a QR code to print on the invoice ([EY](https://www.ey.com/en_in/technical/alerts-hub/2023/05/cbic-lowers-turnover-threshold-for-e-invoicing-to-inr5-crores-with-effect-from-1-august-2023)).
- **Turnover of Rs 10 crore or more:** since 1 April 2025, e-invoices must be reported within 30 days of the invoice date ([ClearTax](https://cleartax.in/s/time-limit-for-reporting-e-invoices-on-the-irp-portal)).
- **Turnover above Rs 500 crore:** B2C invoices need a dynamic QR code too ([TaxHeal](https://www.taxheal.com/notification-no-14-2020-central-tax-qr-code-on-b2c-invoices-from-1st-oct-2020-if-turnover-above-500-crore.html)).

Below Rs 5 crore, a regular tax invoice like the one below is all you need.

## CGST and SGST, or IGST?

Compare the place of supply with your own state. Same state: split the tax equally into CGST and SGST (UTGST in a union territory). Different state: charge the whole rate as IGST. For an 18% item worth Rs 10,000, that is Rs 900 CGST plus Rs 900 SGST within the state, or Rs 1,800 IGST across states.

## Make one in two minutes

[GST Invoice Generator](/gst-invoice) builds a tax invoice with these fields:

<!-- tool:gst-invoice -->

- CGST and SGST or IGST chosen from your state and the place of supply
- HSN or SAC for each item, with an HSN summary at the foot
- Reverse charge marked yes or no
- Amount in words, bank details and a UPI QR code for payment
- Your signature or stamp, added as an image
- Your business details remembered in this browser for next time

Everything is worked out and saved in your browser; your invoices and customers' details are not uploaded. At the end of the month, [GST Filing Prep](/gst-filing) totals your invoices by tax rate as a working paper for GSTR-1 and GSTR-3B. Shops can print [POS receipts](/pos-bill) on 58 or 80 mm thermal paper.

The generator makes regular tax invoices. If e-invoicing applies to you, report the invoice on the Invoice Registration Portal to get its IRN and QR code.

## Sources

- [CBIC: Rule 46, tax invoice](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html)
- [GST Council: HSN codes on invoices](https://gstcouncil.gov.in/sites/default/files/2024-02/press_release_hs_code_sac_issue.pdf)
- [EY: e-invoicing threshold lowered to Rs 5 crore](https://www.ey.com/en_in/technical/alerts-hub/2023/05/cbic-lowers-turnover-threshold-for-e-invoicing-to-inr5-crores-with-effect-from-1-august-2023)
- [ClearTax: 30-day limit for reporting e-invoices](https://cleartax.in/s/time-limit-for-reporting-e-invoices-on-the-irp-portal)
- [TaxHeal: QR code on B2C invoices](https://www.taxheal.com/notification-no-14-2020-central-tax-qr-code-on-b2c-invoices-from-1st-oct-2020-if-turnover-above-500-crore.html)
