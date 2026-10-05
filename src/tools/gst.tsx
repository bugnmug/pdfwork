import { FileUp, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useFilePicker } from "@/components/dropzone";
import { ResultList } from "@/components/results";
import { Button, Input, Notice, Panel, Select } from "@/components/ui";
import { gstSummary, inr, STATES, stateFromGstin, type GstRow } from "@/lib/pdf/business";
import type { OutFile } from "@/lib/pdf/core";
import { usePersistent } from "@/lib/storage";
import type { Tool } from "@/lib/tools/catalog";
import { L, NumInput, RemoveRow, Section, StateSelect } from "./biz-common";

type Row = Omit<GstRow, "interstate">;
const ROW: Row = { type: "B2C", inv: "", date: "", party: "", gstin: "", pos: "", taxable: 0, rate: 18 };
type Biz = { business: string; gstin: string; period: string };

/** Map spreadsheet columns to invoice fields by their header names. */
function fromCsv(table: string[][]): Row[] {
  if (table.length < 2) return [];
  const head = table[0].map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const find = (...keys: string[]) => head.findIndex((h) => keys.some((k) => h.includes(k)));
  const c = {
    inv: find("invoiceno", "invoicenumber", "invno", "invoice", "billno", "number"),
    date: find("date"),
    party: find("party", "customer", "buyer", "name", "receiver"),
    gstin: find("gstin", "gst"),
    pos: find("placeofsupply", "pos", "state"),
    taxable: find("taxable", "value", "amount", "base"),
    rate: find("rate", "taxrate", "gstrate"),
  };
  if (c.taxable < 0) throw new Error("Couldn't find a taxable value column. Name it “Taxable value”.");
  const num = (s: string | undefined) => Number(String(s ?? "").replace(/[₹,\s%]/g, "")) || 0;
  return table.slice(1).flatMap((r) => {
    if (!r.some((x) => x.trim())) return [];
    const gstin = c.gstin >= 0 ? (r[c.gstin] ?? "").trim().toUpperCase() : "";
    const posRaw = c.pos >= 0 ? (r[c.pos] ?? "").trim() : "";
    const pos = /^\d{1,2}/.test(posRaw) ? posRaw.slice(0, 2).padStart(2, "0") : Object.entries(STATES).find(([, n]) => posRaw && n.toLowerCase().startsWith(posRaw.toLowerCase().slice(0, 5)))?.[0] ?? stateFromGstin(gstin) ?? "";
    return [
      {
        type: gstin.length === 15 ? "B2B" : "B2C",
        inv: c.inv >= 0 ? (r[c.inv] ?? "") : "",
        date: c.date >= 0 ? (r[c.date] ?? "") : "",
        party: c.party >= 0 ? (r[c.party] ?? "") : "",
        gstin,
        pos,
        taxable: num(r[c.taxable]),
        rate: c.rate >= 0 ? num(r[c.rate]) : 18,
      } as Row,
    ];
  });
}

export default function Gst({ tool }: { tool: Tool }) {
  const [biz, setBiz] = usePersistent<Biz>("gst-business", { business: "", gstin: "", period: "" });
  const [rows, setRows] = usePersistent<Row[]>("gst-rows", [{ ...ROW }]);
  const [results, setResults] = useState<OutFile[] | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const home = stateFromGstin(biz.gstin);

  const full: GstRow[] = useMemo(() => rows.map((r) => ({ ...r, interstate: !!home && !!r.pos && r.pos !== home })), [rows, home]);
  const valid = full.filter((r) => r.inv.trim() || r.taxable);
  const s = useMemo(() => gstSummary(valid), [valid]);

  const picker = useFilePicker(".csv,.tsv,.txt,text/csv", false, async (files) => {
    try {
      const { parseCsv } = await import("@/lib/pdf/office");
      const imported = fromCsv(parseCsv(await files[0].text()));
      if (!imported.length) throw new Error("No invoice rows found in that file.");
      setRows((cur) => [...cur.filter((r) => r.inv.trim() || r.taxable), ...imported]);
      toast.success(`Imported ${imported.length} invoice${imported.length === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  });

  const setRow = (i: number, patch: Partial<Row>) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const download = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { gstWorkingPaperPdf, gstCsv } = await import("@/lib/pdf/business");
      setResults([await gstWorkingPaperPdf(full, biz), gstCsv(full)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-5">
      <Section title="Your business">
        <div className="grid gap-4 sm:grid-cols-3">
          <L label="Business name">
            <Input value={biz.business} onChange={(e) => setBiz((b) => ({ ...b, business: e.target.value }))} />
          </L>
          <L label="GSTIN" hint={home ? `Home state: ${STATES[home]}. Sales to other states are treated as inter-state (IGST).` : "Used to tell intra-state from inter-state sales."}>
            <Input value={biz.gstin} onChange={(e) => setBiz((b) => ({ ...b, gstin: e.target.value.toUpperCase().trim() }))} maxLength={15} className="font-mono text-[13px] uppercase placeholder:normal-case" />
          </L>
          <L label="Return period">
            <Input value={biz.period} onChange={(e) => setBiz((b) => ({ ...b, period: e.target.value }))} placeholder="e.g. September 2026" />
          </L>
        </div>
      </Section>

      <Section
        title={`Invoices (${valid.length})`}
        aside={
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={picker.open}>
              <FileUp /> Import CSV
            </Button>
            <Button variant="ghost" size="sm" onClick={() => confirm("Remove all invoice rows?") && setRows([{ ...ROW }])}>
              Clear
            </Button>
          </div>
        }
      >
        {picker.input}
        <p className="text-xs text-ink-3">CSV columns are matched by name: invoice no, date, party, GSTIN, place of supply, taxable value, rate. Rows with a 15-character GSTIN count as B2B.</p>
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-ink-3">
                <th className="pb-2 font-medium">Type</th>
                <th className="pb-2 font-medium">Invoice</th>
                <th className="pb-2 font-medium">Date</th>
                <th className="pb-2 font-medium">Party</th>
                <th className="pb-2 font-medium">GSTIN</th>
                <th className="pb-2 font-medium">Place of supply</th>
                <th className="pb-2 font-medium">Taxable ₹</th>
                <th className="pb-2 font-medium">Rate</th>
                <th className="pb-2 text-right font-medium">Tax ₹</th>
                <th />
              </tr>
            </thead>
            <tbody className="align-top">
              {rows.map((r, i) => {
                const calc = full[i];
                const tax = (calc.taxable * calc.rate) / 100;
                return (
                  <tr key={i} className="border-t border-line-2">
                    <td className="py-1.5 pr-1.5">
                      <Select value={r.type} onChange={(e) => setRow(i, { type: e.target.value as Row["type"] })} className="h-9 w-20 text-[13px]" aria-label="Type">
                        <option>B2B</option>
                        <option>B2C</option>
                      </Select>
                    </td>
                    <td className="py-1.5 pr-1.5">
                      <Input value={r.inv} onChange={(e) => setRow(i, { inv: e.target.value })} className="h-9 w-28 text-[13px]" aria-label="Invoice number" />
                    </td>
                    <td className="py-1.5 pr-1.5">
                      <Input type="date" value={r.date} onChange={(e) => setRow(i, { date: e.target.value })} className="h-9 w-36 text-[13px]" aria-label="Date" />
                    </td>
                    <td className="py-1.5 pr-1.5">
                      <Input value={r.party} onChange={(e) => setRow(i, { party: e.target.value })} className="h-9 w-40 text-[13px]" aria-label="Party" />
                    </td>
                    <td className="py-1.5 pr-1.5">
                      <Input
                        value={r.gstin}
                        onChange={(e) => {
                          const g = e.target.value.toUpperCase().trim();
                          setRow(i, { gstin: g, ...(g.length === 15 ? { type: "B2B" as const, pos: r.pos || stateFromGstin(g) || "" } : {}) });
                        }}
                        maxLength={15}
                        className="h-9 w-40 font-mono text-[12px] uppercase placeholder:normal-case"
                        aria-label="GSTIN"
                      />
                    </td>
                    <td className="py-1.5 pr-1.5">
                      <div className="w-44 [&_select]:h-9 [&_select]:text-[13px]">
                        <StateSelect value={r.pos} onChange={(v) => setRow(i, { pos: v })} placeholder="Same state" />
                      </div>
                    </td>
                    <td className="py-1.5 pr-1.5">
                      <NumInput value={r.taxable} onChange={(n) => setRow(i, { taxable: n })} className="h-9 w-28 text-[13px]" aria-label="Taxable value" />
                    </td>
                    <td className="py-1.5 pr-1.5">
                      <Select value={String(r.rate)} onChange={(e) => setRow(i, { rate: Number(e.target.value) })} className="h-9 w-20 text-[13px]" aria-label="Rate">
                        {[0, 0.25, 3, 5, 12, 18, 28, 40].map((x) => (
                          <option key={x} value={x}>
                            {x}%
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="py-1.5 pr-1.5 text-right text-[13px] whitespace-nowrap tabular">
                      {inr(tax)}
                      <span className="block text-[11px] text-ink-3">{calc.interstate ? "IGST" : "CGST+SGST"}</span>
                    </td>
                    <td className="py-1.5">
                      <RemoveRow onClick={() => setRows((cur) => (cur.length > 1 ? cur.filter((_, j) => j !== i) : [{ ...ROW }]))} label={`Remove row ${i + 1}`} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Button variant="ghost" className="justify-self-start" onClick={() => setRows((cur) => [...cur, { ...ROW, rate: cur[cur.length - 1]?.rate ?? 18 }])}>
          <Plus /> Add invoice
        </Button>
      </Section>

      <Panel className="grid gap-4 p-4 sm:p-5">
        <h2 className="text-[15px] font-semibold">Summary by tax rate</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm tabular">
            <thead>
              <tr className="text-left text-xs text-ink-3">
                <th className="pb-2 font-medium">Rate</th>
                <th className="pb-2 text-right font-medium">Invoices</th>
                <th className="pb-2 text-right font-medium">Taxable</th>
                <th className="pb-2 text-right font-medium">IGST</th>
                <th className="pb-2 text-right font-medium">CGST</th>
                <th className="pb-2 text-right font-medium">SGST</th>
              </tr>
            </thead>
            <tbody>
              {s.byRate.map(([rate, v]) => (
                <tr key={rate} className="border-t border-line-2">
                  <td className="py-1.5">{rate}%</td>
                  <td className="py-1.5 text-right">{v.count}</td>
                  <td className="py-1.5 text-right">{inr(v.taxable)}</td>
                  <td className="py-1.5 text-right">{inr(v.igst)}</td>
                  <td className="py-1.5 text-right">{inr(v.cgst)}</td>
                  <td className="py-1.5 text-right">{inr(v.sgst)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-line font-semibold">
                <td className="py-2">Total</td>
                <td className="py-2 text-right">{valid.length}</td>
                <td className="py-2 text-right">{inr(s.totals.taxable)}</td>
                <td className="py-2 text-right">{inr(s.totals.igst)}</td>
                <td className="py-2 text-right">{inr(s.totals.cgst)}</td>
                <td className="py-2 text-right">{inr(s.totals.sgst)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm text-ink-2">
          Total tax: <b className="text-ink tabular">{inr(s.totals.igst + s.totals.cgst + s.totals.sgst, true)}</b>
        </p>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="lg" onClick={download} busy={busy} disabled={busy || !valid.length}>
            {tool.cta}
          </Button>
        </div>
        {results ? <ResultList results={results} tool={tool.slug} /> : null}
        <p className="text-xs text-ink-3">A working paper to help prepare GSTR-1 and GSTR-3B. It is not a filed return: check the figures against the GST portal before filing.</p>
      </Panel>
    </div>
  );
}
