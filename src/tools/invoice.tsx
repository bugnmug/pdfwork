import { CircleAlert, CircleCheck, FilePlus2, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ResultList } from "@/components/results";
import { Button, Input, Notice, Panel, Segmented, Select, Switch, Textarea } from "@/components/ui";
import { computeInvoice, inr, rupeesInWords, STATES, stateFromGstin, validGstin, type Invoice, type InvoiceItem } from "@/lib/pdf/business";
import type { OutFile } from "@/lib/pdf/core";
import { usePersistent } from "@/lib/storage";
import type { Tool } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";
import { dataUrlToImage, ImageSlot, L, nextNumber, NumInput, RemoveRow, Section, StateSelect, today } from "./biz-common";

const RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];

type Seller = Invoice["seller"] & { logo?: string; signature?: string; bank: NonNullable<Invoice["bank"]>; upi: string; terms: string; accent: string };
const SELLER: Seller = { name: "", address: "", gstin: "", state: "", phone: "", email: "", pan: "", bank: { name: "", account: "", ifsc: "", branch: "", holder: "" }, upi: "", terms: "Payment due within 15 days.\nPlease quote the invoice number with your payment.", accent: "#1f3a5f" };
const ITEM: InvoiceItem = { desc: "", hsn: "", qty: 1, unit: "Nos", rate: 0, discount: 0, gst: 18 };
type Draft = { number: string; date: string; dueDate: string; buyer: Invoice["buyer"]; shipTo: string; placeOfSupply: string; reverseCharge: boolean; items: InvoiceItem[]; notes: string; copy: string };
const DRAFT: Draft = { number: "INV-0001", date: "", dueDate: "", buyer: { name: "", address: "", gstin: "", state: "", phone: "" }, shipTo: "", placeOfSupply: "", reverseCharge: false, items: [{ ...ITEM }], notes: "", copy: "Original for recipient" };

function GstinField({ value, onChange, onState }: { value: string; onChange: (v: string) => void; onState: (code: string) => void }) {
  const v = value.trim().toUpperCase();
  const ok = v.length === 15 && validGstin(v);
  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(e) => {
          const next = e.target.value.toUpperCase().replace(/\s/g, "");
          onChange(next);
          const st = stateFromGstin(next);
          if (st && next.length >= 2) onState(st);
        }}
        placeholder="e.g. 29ABCDE1234F1Z5"
        maxLength={15}
        spellCheck={false}
        className="pr-9 font-mono text-[13px] uppercase placeholder:normal-case"
      />
      {v.length === 15 ? (
        <span className="absolute top-1/2 right-2.5 -translate-y-1/2" title={ok ? "Valid GSTIN" : "Check digit doesn't match: please re-check"}>
          {ok ? <CircleCheck className="size-4 text-ok" /> : <CircleAlert className="size-4 text-warn" />}
        </span>
      ) : null}
    </div>
  );
}

export default function InvoiceTool({ tool }: { tool: Tool }) {
  const [seller, setSeller, ready] = usePersistent<Seller>("invoice-seller", SELLER);
  const [draft, setDraft] = usePersistent<Draft>("invoice-draft", DRAFT);
  const [results, setResults] = useState<OutFile[] | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sellerOpen, setSellerOpen] = useState<boolean | null>(null);
  // Decide once, after saved details load: open the form only if there's nothing saved yet.
  useEffect(() => {
    if (ready) setSellerOpen((o) => o ?? !seller.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  const showSeller = sellerOpen ?? true;
  const date = draft.date || today();

  const inv: Invoice = useMemo(
    () => ({
      title: draft.reverseCharge ? "Tax Invoice (Reverse Charge)" : "Tax Invoice",
      copy: draft.copy,
      number: draft.number,
      date,
      dueDate: draft.dueDate || undefined,
      seller: { name: seller.name, address: seller.address, gstin: seller.gstin, state: seller.state || stateFromGstin(seller.gstin) || "", phone: seller.phone, email: seller.email, pan: seller.pan },
      buyer: draft.buyer,
      shipTo: draft.shipTo || undefined,
      placeOfSupply: draft.placeOfSupply || draft.buyer.state || stateFromGstin(draft.buyer.gstin) || "",
      reverseCharge: draft.reverseCharge,
      items: draft.items,
      notes: draft.notes || undefined,
      terms: seller.terms || undefined,
      bank: seller.bank.account ? seller.bank : undefined,
      upi: seller.upi || undefined,
      logo: dataUrlToImage(seller.logo),
      signature: dataUrlToImage(seller.signature),
      accent: seller.accent,
    }),
    [seller, draft, date],
  );
  const totals = useMemo(() => computeInvoice(inv), [inv]);

  const setItem = (i: number, patch: Partial<InvoiceItem>) => setDraft((d) => ({ ...d, items: d.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));
  const setBuyer = (patch: Partial<Invoice["buyer"]>) => setDraft((d) => ({ ...d, buyer: { ...d.buyer, ...patch } }));
  const setS = (patch: Partial<Seller>) => setSeller((s) => ({ ...s, ...patch }));

  const download = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { gstInvoicePdf } = await import("@/lib/pdf/business");
      setResults([await gstInvoicePdf(inv)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const newInvoice = () => {
    setDraft((d) => ({ ...DRAFT, number: nextNumber(d.number), copy: d.copy }));
    setResults(null);
  };

  const pos = inv.placeOfSupply;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="grid gap-4">
        <Section
          title={seller.name && !showSeller ? `From: ${seller.name}` : "Your business"}
          aside={
            seller.name ? (
              <Button variant="ghost" size="sm" onClick={() => setSellerOpen(!showSeller)}>
                {showSeller ? "Done" : "Edit"}
              </Button>
            ) : null
          }
        >
          {showSeller ? (
            <div className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <L label="Business name">
                  <Input value={seller.name} onChange={(e) => setS({ name: e.target.value })} />
                </L>
                <L label="GSTIN" hint={seller.gstin && !seller.state ? undefined : seller.state ? `State: ${STATES[seller.state]}` : undefined}>
                  <GstinField value={seller.gstin} onChange={(v) => setS({ gstin: v })} onState={(st) => setS({ state: st })} />
                </L>
              </div>
              <L label="Address">
                <Textarea rows={2} value={seller.address} onChange={(e) => setS({ address: e.target.value })} className="min-h-16" />
              </L>
              <div className="grid gap-4 sm:grid-cols-3">
                <L label="State">
                  <StateSelect value={seller.state} onChange={(v) => setS({ state: v })} />
                </L>
                <L label="Phone">
                  <Input value={seller.phone ?? ""} onChange={(e) => setS({ phone: e.target.value })} inputMode="tel" />
                </L>
                <L label="Email">
                  <Input value={seller.email ?? ""} onChange={(e) => setS({ email: e.target.value })} inputMode="email" />
                </L>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <ImageSlot label="Logo" value={seller.logo} onChange={(v) => setS({ logo: v })} />
                <ImageSlot label="Signature or stamp" value={seller.signature} onChange={(v) => setS({ signature: v })} hint="Tip: a PNG without a background blends in cleanly." />
              </div>
              <p className="text-xs text-ink-3">Saved in this browser only, so you don&apos;t have to type it again.</p>
            </div>
          ) : (
            <p className="text-sm text-ink-2">
              {[seller.gstin && `GSTIN ${seller.gstin}`, seller.state && STATES[seller.state]].filter(Boolean).join(" · ") || "Tap Edit to add your details."}
            </p>
          )}
        </Section>

        <Section title="Bill to">
          <div className="grid gap-4 sm:grid-cols-2">
            <L label="Customer name">
              <Input value={draft.buyer.name} onChange={(e) => setBuyer({ name: e.target.value })} />
            </L>
            <L label="Customer GSTIN" hint="Leave empty for unregistered customers (B2C).">
              <GstinField value={draft.buyer.gstin} onChange={(v) => setBuyer({ gstin: v })} onState={(st) => setBuyer({ state: st })} />
            </L>
          </div>
          <L label="Billing address">
            <Textarea rows={2} value={draft.buyer.address} onChange={(e) => setBuyer({ address: e.target.value })} className="min-h-16" />
          </L>
          <div className="grid gap-4 sm:grid-cols-2">
            <L label="Customer state">
              <StateSelect value={draft.buyer.state} onChange={(v) => setBuyer({ state: v })} />
            </L>
            <L label="Place of supply" hint={pos && inv.seller.state ? (pos === inv.seller.state ? "Same state: CGST + SGST" : "Different state: IGST") : undefined}>
              <StateSelect value={draft.placeOfSupply} onChange={(v) => setDraft((d) => ({ ...d, placeOfSupply: v }))} placeholder="Same as customer state" />
            </L>
          </div>
          <L label="Ship to (if different)">
            <Input value={draft.shipTo} onChange={(e) => setDraft((d) => ({ ...d, shipTo: e.target.value }))} />
          </L>
        </Section>

        <Section title="Invoice details">
          <div className="grid gap-4 sm:grid-cols-3">
            <L label="Invoice number">
              <Input value={draft.number} onChange={(e) => setDraft((d) => ({ ...d, number: e.target.value }))} />
            </L>
            <L label="Invoice date">
              <Input type="date" value={date} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} />
            </L>
            <L label="Due date">
              <Input type="date" value={draft.dueDate} onChange={(e) => setDraft((d) => ({ ...d, dueDate: e.target.value }))} />
            </L>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <Segmented
              label="Copy"
              value={draft.copy}
              onChange={(v) => setDraft((d) => ({ ...d, copy: v }))}
              options={[
                { value: "Original for recipient", label: "Original" },
                { value: "Duplicate for transporter", label: "Duplicate" },
                { value: "Triplicate for supplier", label: "Triplicate" },
              ]}
              className="w-full max-w-sm"
            />
            <Switch checked={draft.reverseCharge} onChange={(v) => setDraft((d) => ({ ...d, reverseCharge: v }))} label="Reverse charge applies" />
          </div>
        </Section>

        <Section title="Items">
          <div className="grid gap-3">
            {draft.items.map((it, i) => (
              <div key={i} className="grid gap-2 rounded-md border border-line-2 bg-paper-2/50 p-3">
                <div className="flex gap-2">
                  <Input value={it.desc} onChange={(e) => setItem(i, { desc: e.target.value })} placeholder={`Item ${i + 1} description`} aria-label="Description" className="flex-1" />
                  <RemoveRow onClick={() => setDraft((d) => ({ ...d, items: d.items.length > 1 ? d.items.filter((_, j) => j !== i) : [{ ...ITEM }] }))} label={`Remove item ${i + 1}`} />
                </div>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  <L label="HSN/SAC">
                    <Input value={it.hsn} onChange={(e) => setItem(i, { hsn: e.target.value })} inputMode="numeric" className="tabular" />
                  </L>
                  <L label="Qty">
                    <NumInput value={it.qty} onChange={(n) => setItem(i, { qty: n })} />
                  </L>
                  <L label="Unit">
                    <Input value={it.unit} onChange={(e) => setItem(i, { unit: e.target.value })} />
                  </L>
                  <L label="Rate (₹)">
                    <NumInput value={it.rate} onChange={(n) => setItem(i, { rate: n })} />
                  </L>
                  <L label="Disc. %">
                    <NumInput value={it.discount} onChange={(n) => setItem(i, { discount: Math.min(100, n) })} />
                  </L>
                  <L label="GST %">
                    <Select value={String(it.gst)} onChange={(e) => setItem(i, { gst: Number(e.target.value) })}>
                      {RATES.map((r) => (
                        <option key={r} value={r}>
                          {r}%
                        </option>
                      ))}
                    </Select>
                  </L>
                </div>
                {totals.rows[i] ? (
                  <p className="text-right text-xs text-ink-3 tabular">
                    Taxable {inr(totals.rows[i].taxable, true)} · Tax {inr(totals.rows[i].cgst + totals.rows[i].sgst + totals.rows[i].igst, true)} · <b className="text-ink">{inr(totals.rows[i].total, true)}</b>
                  </p>
                ) : null}
              </div>
            ))}
            <Button variant="ghost" className="justify-self-start" onClick={() => setDraft((d) => ({ ...d, items: [...d.items, { ...ITEM, gst: d.items[d.items.length - 1]?.gst ?? 18 }] }))}>
              <Plus /> Add item
            </Button>
          </div>
        </Section>

        <Section title="Payment and notes">
          <div className="grid gap-4 sm:grid-cols-2">
            <L label="UPI ID (adds a payment QR code)">
              <Input value={seller.upi} onChange={(e) => setS({ upi: e.target.value.trim() })} placeholder="yourname@bank" spellCheck={false} />
            </L>
            <L label="Account holder">
              <Input value={seller.bank.holder ?? ""} onChange={(e) => setS({ bank: { ...seller.bank, holder: e.target.value } })} />
            </L>
            <L label="Bank name">
              <Input value={seller.bank.name ?? ""} onChange={(e) => setS({ bank: { ...seller.bank, name: e.target.value } })} />
            </L>
            <L label="Account number">
              <Input value={seller.bank.account ?? ""} onChange={(e) => setS({ bank: { ...seller.bank, account: e.target.value } })} inputMode="numeric" className="tabular" />
            </L>
            <L label="IFSC">
              <Input value={seller.bank.ifsc ?? ""} onChange={(e) => setS({ bank: { ...seller.bank, ifsc: e.target.value.toUpperCase() } })} className="uppercase placeholder:normal-case" />
            </L>
            <L label="Branch">
              <Input value={seller.bank.branch ?? ""} onChange={(e) => setS({ bank: { ...seller.bank, branch: e.target.value } })} />
            </L>
          </div>
          <L label="Notes for this invoice">
            <Textarea rows={2} value={draft.notes} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} className="min-h-16" />
          </L>
          <L label="Terms (saved for every invoice)">
            <Textarea rows={3} value={seller.terms} onChange={(e) => setS({ terms: e.target.value })} className="min-h-20" />
          </L>
          <L label="Accent colour">
            <div className="flex items-center gap-2">
              {["#1f3a5f", "#0f766e", "#7c2d12", "#4c1d95", "#111827"].map((c) => (
                <button key={c} type="button" onClick={() => setS({ accent: c })} aria-label={c} className={cn("size-8 rounded-full border-2", seller.accent === c ? "border-carbon" : "border-transparent")}>
                  <span className="block size-full rounded-full border-2 border-paper" style={{ background: c }} />
                </button>
              ))}
            </div>
          </L>
        </Section>
      </div>

      <aside className="grid content-start gap-3 lg:sticky lg:top-20">
        <Panel className="grid gap-3 p-4">
          <p className="text-xs font-medium tracking-wide text-ink-3 uppercase">Invoice total</p>
          <p className="text-3xl font-bold tabular">{inr(totals.total, true)}</p>
          <dl className="grid gap-1 text-sm tabular">
            <div className="flex justify-between">
              <dt className="text-ink-2">Taxable value</dt>
              <dd>{inr(totals.taxable, true)}</dd>
            </div>
            {totals.interstate ? (
              <div className="flex justify-between">
                <dt className="text-ink-2">IGST</dt>
                <dd>{inr(totals.igst, true)}</dd>
              </div>
            ) : (
              <>
                <div className="flex justify-between">
                  <dt className="text-ink-2">CGST</dt>
                  <dd>{inr(totals.cgst, true)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-2">SGST/UTGST</dt>
                  <dd>{inr(totals.sgst, true)}</dd>
                </div>
              </>
            )}
            {totals.roundOff ? (
              <div className="flex justify-between">
                <dt className="text-ink-2">Round off</dt>
                <dd>{inr(totals.roundOff, true)}</dd>
              </div>
            ) : null}
          </dl>
          <p className="text-xs leading-snug text-ink-3">{rupeesInWords(totals.total)}</p>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button variant="primary" size="lg" onClick={download} busy={busy} disabled={busy}>
            {tool.cta}
          </Button>
          {results ? (
            <>
              <ResultList results={results} tool={tool.slug} />
              <Button variant="secondary" onClick={newInvoice}>
                <FilePlus2 /> Start the next invoice ({nextNumber(draft.number)})
              </Button>
            </>
          ) : null}
        </Panel>
        <p className="px-1 text-xs text-ink-3">CGST/SGST or IGST is chosen by checking whether your state matches the place of supply. Check rates for your goods or services before issuing.</p>
      </aside>
    </div>
  );
}
