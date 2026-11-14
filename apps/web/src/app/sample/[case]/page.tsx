import { notFound } from "next/navigation";
import { Findings } from "@/components/Findings.tsx";
import { SAMPLE_CASES, sampleRows, type SampleCase } from "@/lib/sample.ts";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return SAMPLE_CASES.map((c) => ({ case: c }));
}

export default async function SamplePage({ params }: { params: Promise<{ case: string }> }) {
  const { case: c } = await params;
  if (!(SAMPLE_CASES as readonly string[]).includes(c)) notFound();
  return (
    <section className="py-6">
      <h1 className="text-2xl font-bold">Sample run: {c}</h1>
      <p className="mt-1 text-sm text-muted">
        Sample data made by hand to show how the check page reads. It is not a real strategy and nothing here comes from a chain.
      </p>
      <Findings rows={sampleRows(c as SampleCase)} />
    </section>
  );
}
