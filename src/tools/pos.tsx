import { Plus, ReceiptText } from "lucide-react";
import { useMemo, useState } from "react";
import { ResultList } from "@/components/results";
import { Button, Input, Notice, Panel, Segmented, Select, Switch, Textarea } from "@/components/ui";
import { inr, type PosBill } from "@/lib/pdf/business";
import type { OutFile } from "@/lib/pdf/core";
import { usePersistent } from "@/lib/storage";
import type { Tool } from "@/lib/tools/catalog";
import { L, nextNumber, NumInput, RemoveRow, Section } from "./biz-common";

type Shop = Pick<PosBill, "shop" | "address" | "gstin" | "phone" | "upi" | "footer" | "width" | "gstRate" | "gstInclusive">;
const SHOP: Shop = { shop: "", address: "", gstin: "", phone: "", upi: "", footer: "Thank you! Visit again.", width: 80, gstRate: 5, gstInclusive: true };
type Bill = { billNo: string; cashier: string; customer: string; items: PosBill["items"]; discount: number; payment: string };
const BILL: Bill = { billNo: "1001", cashier: "", customer: "", items: [{ name: "", qty: 1, rate: 0 }], discount: 0, payment: "Cash" };

export default function Pos({ tool }: { tool: Tool }) {
  const [shop, setShop] = usePersistent<Shop>("pos-shop", SHOP);
  const [bill, setBill] = usePersistent<Bill>("pos-bill", BILL);
  const [results, setResults] = useState<OutFile[] | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const t = useMemo(() => {
    const items = bill.items.filter((i) => i.name.trim() && i.qty);
    const subtotal = items.reduce((s, i) => s + i.qty * i.rate, 0);
    const discount = Math.min(subtotal, bill.discount || 0);
    const base = subtotal - discount;
    const rate = shop.gstRate ?? 0;
    const tax = shop.gstInclusive ? base - base / (1 + rate / 100) : (base * rate) / 100;
    return { subtotal, discount, tax, total: Math.round(shop.gstInclusive ? base : base + tax), count: items.length };
  }, [bill, shop]);

  const setItem = (i: number, patch: Partial<PosBill["items"][number]>) => setBill((b) => ({ ...b, items: b.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));

  const download = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (!shop.shop.trim()) throw new Error("Enter the shop name.");
      const { posBillPdf } = await import("@/lib/pdf/business");
      setResults([await posBillPdf({ ...shop, ...bill })]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid gap-4">
        <Section title="Shop">
          <div className="grid gap-4 sm:grid-cols-2">
            <L label="Shop name">
              <Input value={shop.shop} onChange={(e) => setShop((s) => ({ ...s, shop: e.target.value }))} />
            </L>
            <L label="Phone">
              <Input value={shop.phone ?? ""} onChange={(e) => setShop((s) => ({ ...s, phone: e.target.value }))} inputMode="tel" />
            </L>
          </div>
          <L label="Address">
            <Textarea rows={2} value={shop.address} onChange={(e) => setShop((s) => ({ ...s, address: e.target.value }))} className="min-h-16" />
          </L>
          <div className="grid gap-4 sm:grid-cols-2">
            <L label="GSTIN (optional)">
              <Input value={shop.gstin ?? ""} onChange={(e) => setShop((s) => ({ ...s, gstin: e.target.value.toUpperCase() }))} className="font-mono text-[13px] uppercase" maxLength={15} />
            </L>
            <L label="UPI ID for the payment QR (optional)">
              <Input value={shop.upi ?? ""} onChange={(e) => setShop((s) => ({ ...s, upi: e.target.value.trim() }))} placeholder="shop@bank" spellCheck={false} />
            </L>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <L label="Paper width">
              <Segmented
                label="Paper width"
                value={String(shop.width ?? 80)}
                onChange={(v) => setShop((s) => ({ ...s, width: Number(v) as 58 | 80 }))}
                options={[
                  { value: "58", label: "58 mm" },
                  { value: "80", label: "80 mm" },
                ]}
                className="w-48"
              />
            </L>
            <L label="GST rate">
              <Select value={String(shop.gstRate ?? 0)} onChange={(e) => setShop((s) => ({ ...s, gstRate: Number(e.target.value) }))} className="w-28">
                {[0, 5, 12, 18, 28, 40].map((r) => (
                  <option key={r} value={r}>
                    {r}%
                  </option>
                ))}
              </Select>
            </L>
            <div className="pb-2">
              <Switch checked={!!shop.gstInclusive} onChange={(v) => setShop((s) => ({ ...s, gstInclusive: v }))} label="Prices include GST" />
            </div>
          </div>
          <L label="Footer message">
            <Input value={shop.footer ?? ""} onChange={(e) => setShop((s) => ({ ...s, footer: e.target.value }))} />
          </L>
        </Section>
        <Section title="Bill">
          <div className="grid gap-4 sm:grid-cols-3">
            <L label="Bill number">
              <Input value={bill.billNo} onChange={(e) => setBill((b) => ({ ...b, billNo: e.target.value }))} />
            </L>
            <L label="Customer (optional)">
              <Input value={bill.customer} onChange={(e) => setBill((b) => ({ ...b, customer: e.target.value }))} />
            </L>
            <L label="Cashier (optional)">
              <Input value={bill.cashier} onChange={(e) => setBill((b) => ({ ...b, cashier: e.target.value }))} />
            </L>
          </div>
          <div className="grid gap-2">
            <div className="hidden grid-cols-[1fr_80px_100px_36px] gap-2 px-1 text-xs font-medium text-ink-3 sm:grid">
              <span>Item</span>
              <span>Qty</span>
              <span>Price (₹)</span>
              <span />
            </div>
            {bill.items.map((it, i) => (
              <div key={i} className="grid grid-cols-[1fr_64px_88px_36px] gap-2 sm:grid-cols-[1fr_80px_100px_36px]">
                <Input value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} placeholder={`Item ${i + 1}`} aria-label="Item name" />
                <NumInput value={it.qty} onChange={(n) => setItem(i, { qty: n })} aria-label="Quantity" />
                <NumInput value={it.rate} onChange={(n) => setItem(i, { rate: n })} aria-label="Price" />
                <RemoveRow onClick={() => setBill((b) => ({ ...b, items: b.items.length > 1 ? b.items.filter((_, j) => j !== i) : [{ name: "", qty: 1, rate: 0 }] }))} label={`Remove item ${i + 1}`} />
              </div>
            ))}
            <Button variant="ghost" className="justify-self-start" onClick={() => setBill((b) => ({ ...b, items: [...b.items, { name: "", qty: 1, rate: 0 }] }))}>
              <Plus /> Add item
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <L label="Discount (₹)">
              <NumInput value={bill.discount} onChange={(n) => setBill((b) => ({ ...b, discount: n }))} />
            </L>
            <L label="Paid by">
              <Select value={bill.payment} onChange={(e) => setBill((b) => ({ ...b, payment: e.target.value }))}>
                {["Cash", "UPI", "Card", "Credit"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </Select>
            </L>
          </div>
        </Section>
      </div>
      <aside className="grid content-start gap-3 lg:sticky lg:top-20">
        <Panel className="grid gap-3 p-4">
          <p className="text-xs font-medium tracking-wide text-ink-3 uppercase">To pay</p>
          <p className="text-3xl font-bold tabular">{inr(t.total, true)}</p>
          <dl className="grid gap-1 text-sm tabular">
            <div className="flex justify-between">
              <dt className="text-ink-2">
                {t.count} item{t.count === 1 ? "" : "s"}
              </dt>
              <dd>{inr(t.subtotal, true)}</dd>
            </div>
            {t.discount ? (
              <div className="flex justify-between">
                <dt className="text-ink-2">Discount</dt>
                <dd>−{inr(t.discount, true)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between">
              <dt className="text-ink-2">GST {shop.gstRate}% {shop.gstInclusive ? "(included)" : ""}</dt>
              <dd>{inr(t.tax, true)}</dd>
            </div>
          </dl>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button variant="primary" size="lg" onClick={download} busy={busy} disabled={busy}>
            {tool.cta}
          </Button>
          {results ? (
            <>
              <ResultList results={results} tool={tool.slug} />
              <Button
                variant="secondary"
                onClick={() => {
                  setBill((b) => ({ ...BILL, billNo: nextNumber(b.billNo), cashier: b.cashier, payment: b.payment }));
                  setResults(null);
                }}
              >
                <ReceiptText /> Next bill ({nextNumber(bill.billNo)})
              </Button>
            </>
          ) : null}
        </Panel>
      </aside>
    </div>
  );
}
