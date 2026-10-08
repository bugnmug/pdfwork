import { createFileRoute, Link } from "@tanstack/react-router";
import { Page } from "@/components/shell";
import { BRAND } from "@/lib/brand";
import { abs, ld, organization, pageHead } from "@/lib/seo";
import { TOOLS } from "@/lib/tools/catalog";

const DESCRIPTION = `${BRAND.name} is a free set of ${TOOLS.length} PDF tools that run inside your browser, so files never leave your device. Who makes it, how it works and what it costs.`;

export const Route = createFileRoute("/about")({
  head: () =>
    pageHead({
      title: `About ${BRAND.name}: free PDF tools that never upload your files`,
      description: DESCRIPTION,
      path: "/about",
      extra: [organization(), ld({ "@type": "AboutPage", name: `About ${BRAND.name}`, url: abs("/about"), description: DESCRIPTION, about: { "@type": "Organization", name: BRAND.name, url: abs("/") } })],
    }),
  component: AboutPage,
});

const FACTS: [string, string][] = [
  ["Price", "Free. Every tool, no paid tier"],
  ["Files uploaded", "None. Your browser does the work"],
  ["Account", "Not needed"],
  ["Limits", "No daily or hourly caps; your device's memory is the only ceiling"],
  ["Watermark", "Never"],
  ["Tools", `${TOOLS.length}, from merging and compressing to OCR, redaction and GST invoices`],
  ["OCR languages", "English and Hindi"],
  ["Works on", "Android, iPhone, Windows, Mac and Linux, in any modern browser"],
];

function AboutPage() {
  return (
    <Page className="max-w-4xl pt-10 pb-6 sm:pt-14">
      <h1 className="text-4xl font-bold tracking-tight">About {BRAND.name}</h1>
      <p className="mt-4 max-w-2xl text-lg text-ink-2">
        {BRAND.name} is a free set of {TOOLS.length} PDF tools that work inside your browser. Your Aadhaar card, bank statement or contract is opened and processed on your own phone or computer, and never uploaded to anyone&apos;s server, including ours.
      </p>
      <div className="mt-10 grid gap-10 text-[15px] leading-relaxed text-ink-2">
        <section>
          <h2 className="text-xl font-semibold text-ink">Why it exists</h2>
          <p className="mt-3 max-w-prose">
            Most PDF websites ask you to upload your file to their servers, then promise to delete it an hour or two later. That is a lot of trust to give for unlocking a bank statement. Fake converter sites make it worse: in March 2025 the FBI warned that some steal ID numbers and bank details from the files people upload. {BRAND.name} removes the question by never receiving your file at all.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-ink">How it works</h2>
          <p className="mt-3 max-w-prose">
            Modern browsers can run serious software. {BRAND.name} loads its PDF engines (PDF.js, pdf-lib and the Tesseract OCR engine) into the page, and they do the work on your device. A meter in the top bar counts every byte of your files sent anywhere, so you can check rather than trust. Details are on{" "}
            <Link to="/privacy" className="text-carbon hover:underline">
              how privacy works
            </Link>
            .
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-ink">Facts at a glance</h2>
          <div className="mt-3 overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <tbody>
                {FACTS.map(([k, v]) => (
                  <tr key={k} className="border-b border-line last:border-0">
                    <th scope="row" className="w-40 bg-paper-2 px-4 py-2.5 font-medium text-ink">
                      {k}
                    </th>
                    <td className="px-4 py-2.5">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section>
          <h2 className="text-xl font-semibold text-ink">Who makes it</h2>
          <p className="mt-3 max-w-prose">
            {BRAND.name} is built in India by Harsh, its founder. It includes tools for Indian paperwork that general PDF sites skip: GST invoices and filing summaries, Hindi OCR, and redaction that finds Aadhaar, PAN, GSTIN and UPI IDs. The{" "}
            <Link to="/blog" className="text-carbon hover:underline">
              guides
            </Link>{" "}
            answer the questions people ask most, such as the password of an e-Aadhaar or a bank statement.
          </p>
        </section>
      </div>
    </Page>
  );
}
