import { createFileRoute } from "@tanstack/react-router";
import { MeterInline } from "@/components/meter";
import { Page } from "@/components/shell";
import { BRAND } from "@/lib/brand";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: `How privacy works | ${BRAND.name}` },
      { name: "description", content: `${BRAND.name} processes PDFs inside your browser. Here is exactly what uses the network, what is stored, and how to check it yourself.` },
    ],
    links: BRAND.url ? [{ rel: "canonical", href: `${BRAND.url}/privacy` }] : [],
  }),
  component: PrivacyPage,
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 border-t border-line pt-8 md:grid-cols-[14rem_1fr] md:gap-10">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="grid max-w-prose gap-3 text-[15px] leading-relaxed text-ink-2 [&_b]:font-medium [&_b]:text-ink">{children}</div>
    </section>
  );
}

function PrivacyPage() {
  return (
    <Page className="max-w-4xl pt-10 pb-6 sm:pt-14">
      <h1 className="text-4xl font-bold tracking-tight">How privacy works</h1>
      <p className="mt-4 max-w-2xl text-lg text-ink-2">
        {BRAND.name} is a set of tools that run inside your browser. Files are opened, edited and saved right on your computer or phone, so we have nothing to store, scan, leak or delete.
      </p>
      <p className="mt-4 text-ink-2">
        Right now: <MeterInline />
      </p>
      <div className="mt-10 grid gap-8">
        <Section title="What happens to a file">
          <p>When you choose or drop a file, your browser reads it into this tab&apos;s memory. The tool works on that copy with JavaScript and WebAssembly running on your device, builds the result in memory, and hands it back to you as a download.</p>
          <p>Close the tab and the copies are gone. Nothing is written to a server, because nothing is sent to one.</p>
        </Section>
        <Section title="What uses the network">
          <p>
            <b>Loading the site.</b> Your browser downloads the app, fonts and engines (PDF.js, pdf-lib, Tesseract OCR and its language data) from this site. These are downloads only; nothing of yours goes up.
          </p>
          <p>
            <b>Optional AI answers.</b> If the site owner has enabled an AI service, Chat with PDF and the Summarizer offer AI answers. Only your question and the few passages needed to answer it are sent, never the file, and only when you choose AI mode. The local mode sends nothing.
          </p>
          <p>
            <b>Optional audio.</b> Transcribing a recording or downloading an MP3 of a PDF sends that audio or text to the speech service, when enabled. Live dictation relies on the speech recognition that comes with your browser, and some browsers send that audio to their maker&apos;s servers.
          </p>
          <p>
            <b>P2P Share and the whiteboard.</b> A public connection broker helps two browsers find each other. Your files and drawings then travel directly between the devices through an encrypted WebRTC channel. Add a password and files are also encrypted end to end with AES-256 before they leave your device.
          </p>
        </Section>
        <Section title="What is stored">
          <p>Some tools remember things for you in this browser&apos;s local storage: saved signatures, your business details for invoices, a resume draft, saved workflows and your theme. They stay on this device and you can clear them with your browser&apos;s site-data settings.</p>
          <p>There are no accounts, no analytics and no advertising trackers.</p>
        </Section>
        <Section title="Check it yourself">
          <p>
            <b>The meter.</b> The counter in the top bar wraps every way a web page can send data (fetch, XHR, beacons, WebSockets and WebRTC) and adds up the bytes. Click it to see each request.
          </p>
          <p>
            <b>Developer tools.</b> Open your browser&apos;s developer tools, choose the Network tab, and run a tool. You will see downloads of the app&apos;s own files, and no uploads.
          </p>
          <p>
            <b>Go offline.</b> Open a tool, let it load, then turn off Wi-Fi. Most tools keep working, because they never needed the internet to do the work.
          </p>
        </Section>
      </div>
    </Page>
  );
}
