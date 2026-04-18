/**
 * BrainBench Category 2 at scale — graph quality on the 240-page rich-prose
 * corpus from eval/data/world-v1/.
 *
 * The existing test/benchmark-graph-quality.ts uses 80 templated pages where
 * every entity ref is a clean `[Name](slug)` markdown link. This benchmark
 * runs the same extraction and graph queries against pages where the prose is
 * Opus-generated multi-paragraph narrative with realistic noise (typos, varied
 * mention styles, multiple references per page, prose-heavy context).
 *
 * The story this surfaces: does extract() hold its precision/recall numbers
 * when the input is real-feeling prose instead of clean templates?
 *
 * Usage: bun eval/runner/graph-rich.ts [--json]
 */

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runExtract } from '../../src/commands/extract.ts';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

interface RichPage {
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  _facts: {
    type: string;
    slug: string;
    name?: string;
    role?: string;
    primary_affiliation?: string;
    secondary_affiliations?: string[];
    founders?: string[];
    employees?: string[];
    investors?: string[];
    advisors?: string[];
    attendees?: string[];
    topic_company?: string;
    related_companies?: string[];
  };
}

interface ExpectedLink {
  from: string;
  to: string;
  type: string;
}

function loadCorpus(dir: string): RichPage[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const out: RichPage[] = [];
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    // Defensive normalization — Opus occasionally emits timeline as a JSON array
    // of bullet strings instead of a single newline-joined string. Join those.
    if (Array.isArray(p.timeline)) p.timeline = p.timeline.join('\n');
    if (Array.isArray(p.compiled_truth)) p.compiled_truth = p.compiled_truth.join('\n\n');
    p.title = String(p.title ?? '');
    p.compiled_truth = String(p.compiled_truth ?? '');
    p.timeline = String(p.timeline ?? '');
    out.push(p as RichPage);
  }
  return out;
}

/**
 * Compute ground truth links from each page's _facts. These are the
 * relationships we EXPECT auto-link to recover from the prose. Note: we
 * deliberately don't expect 100% — Opus may not always weave every fact into
 * the prose. The metric is "of what's expected, how much is found."
 */
function computeExpectedLinks(pages: RichPage[]): ExpectedLink[] {
  const links: ExpectedLink[] = [];
  for (const p of pages) {
    const f = p._facts;
    if (f.type === 'person') {
      if (f.role === 'founder' && f.primary_affiliation) {
        links.push({ from: p.slug, to: f.primary_affiliation, type: 'works_at' });
      } else if (f.role === 'engineer' && f.primary_affiliation) {
        links.push({ from: p.slug, to: f.primary_affiliation, type: 'works_at' });
      } else if (f.role === 'partner' && f.secondary_affiliations) {
        for (const s of f.secondary_affiliations) {
          links.push({ from: p.slug, to: s, type: 'invested_in' });
        }
      } else if (f.role === 'advisor') {
        if (f.primary_affiliation) links.push({ from: p.slug, to: f.primary_affiliation, type: 'advises' });
        for (const s of (f.secondary_affiliations ?? [])) {
          links.push({ from: p.slug, to: s, type: 'advises' });
        }
      }
    } else if (f.type === 'meeting') {
      for (const a of (f.attendees ?? [])) {
        links.push({ from: p.slug, to: a, type: 'attended' });
      }
    } else if (f.type === 'concept') {
      for (const c of (f.related_companies ?? [])) {
        links.push({ from: p.slug, to: c, type: 'mentions' });
      }
    }
    // Companies don't have outgoing facts in our skeleton (relationships are
    // expressed from the people side).
  }
  return links;
}

async function main() {
  const json = process.argv.includes('--json');
  const log = json ? () => {} : console.log;

  log('# BrainBench Category 2 at scale — Rich Corpus Graph Quality\n');
  log(`Generated: ${new Date().toISOString().slice(0, 19)}`);

  const dir = 'eval/data/world-v1';
  const pages = loadCorpus(dir);
  log(`Corpus: ${pages.length} rich-prose pages from ${dir}/`);

  const expected = computeExpectedLinks(pages);
  log(`Expected ground-truth links (computed from _facts): ${expected.length}`);

  const byType = new Map<string, number>();
  for (const e of expected) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  log(`  by type: ${[...byType.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);

  // ── Spin up engine, seed corpus, run extract ──
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  log('\n## Seeding corpus into PGLite');
  for (const p of pages) {
    await engine.putPage(p.slug, {
      type: p.type as 'person' | 'company' | 'meeting' | 'concept',
      title: p.title,
      compiled_truth: p.compiled_truth,
      timeline: p.timeline,
    });
  }
  const stats0 = await engine.getStats();
  log(`Seeded: ${stats0.page_count} pages, ${stats0.link_count} links pre-extract`);

  log('\n## Running extract --source db (auto-link extraction on rich prose)');
  const captureLog = console.error;
  console.error = () => {};
  try {
    await runExtract(engine, ['links', '--source', 'db']);
    await runExtract(engine, ['timeline', '--source', 'db']);
  } finally {
    console.error = captureLog;
  }

  const stats = await engine.getStats();
  log(`After extract: ${stats.link_count} links, ${stats.timeline_entry_count} timeline entries`);

  // ── Metrics ──

  // Link recall + precision (page-pair, ignoring type for recall — type accuracy separate).
  const expectedPairs = new Set(expected.map(e => `${e.from}|${e.to}`));
  let pairHits = 0, totalExtracted = 0, validExtracted = 0;
  for (const p of pages) {
    const links = await engine.getLinks(p.slug);
    for (const l of links) {
      totalExtracted++;
      if (expectedPairs.has(`${p.slug}|${l.to_slug}`)) validExtracted++;
    }
  }
  for (const e of expected) {
    const links = await engine.getLinks(e.from);
    if (links.some(l => l.to_slug === e.to)) pairHits++;
  }
  const linkRecall = expected.length > 0 ? pairHits / expected.length : 1;
  const linkPrecision = totalExtracted > 0 ? validExtracted / totalExtracted : 1;

  // Type accuracy: for hits, did we get the right type?
  let typeCorrect = 0, typeTotal = 0;
  const typeConfusion: Record<string, Record<string, number>> = {};
  for (const e of expected) {
    const links = await engine.getLinks(e.from);
    const match = links.find(l => l.to_slug === e.to);
    if (match) {
      typeTotal++;
      if (match.link_type === e.type) typeCorrect++;
      typeConfusion[match.link_type] ??= {};
      typeConfusion[match.link_type][e.type] = (typeConfusion[match.link_type][e.type] ?? 0) + 1;
    }
  }
  const typeAccuracy = typeTotal > 0 ? typeCorrect / typeTotal : 1;

  // Per-link-type recall breakdown
  const typeBreakdown: Record<string, { expected: number; found: number; correctType: number }> = {};
  for (const e of expected) {
    typeBreakdown[e.type] ??= { expected: 0, found: 0, correctType: 0 };
    typeBreakdown[e.type].expected++;
    const links = await engine.getLinks(e.from);
    const match = links.find(l => l.to_slug === e.to);
    if (match) {
      typeBreakdown[e.type].found++;
      if (match.link_type === e.type) typeBreakdown[e.type].correctType++;
    }
  }

  // Idempotency: re-run extract, count should be unchanged
  const linkCountBefore = stats.link_count;
  console.error = () => {};
  try {
    await runExtract(engine, ['links', '--source', 'db']);
  } finally {
    console.error = captureLog;
  }
  const stats2 = await engine.getStats();
  const idempotent = stats2.link_count === linkCountBefore;

  await engine.disconnect();

  // ── Output ──
  log('\n## Metrics');
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  log('| Metric            | Value     |');
  log('|-------------------|-----------|');
  log(`| Total extracted   | ${totalExtracted}        |`);
  log(`| Expected (truth)  | ${expected.length}        |`);
  log(`| Link recall       | ${pct(linkRecall)}     |`);
  log(`| Link precision    | ${pct(linkPrecision)}     |`);
  log(`| Type accuracy     | ${pct(typeAccuracy)}     |`);
  log(`| Idempotent        | ${idempotent ? 'true' : 'false'}      |`);

  log('\n## Per-link-type breakdown');
  log('| Link type    | Expected | Found (any type) | Correct type | Recall  | Type acc |');
  log('|--------------|----------|------------------|--------------|---------|----------|');
  for (const [t, b] of Object.entries(typeBreakdown)) {
    const rec = b.expected > 0 ? b.found / b.expected : 0;
    const ta = b.found > 0 ? b.correctType / b.found : 0;
    log(`| ${t.padEnd(12)} | ${String(b.expected).padEnd(8)} | ${String(b.found).padEnd(16)} | ${String(b.correctType).padEnd(12)} | ${pct(rec).padEnd(7)} | ${pct(ta).padEnd(8)} |`);
  }

  log('\n## Type confusion (predicted -> { actual })');
  for (const [pred, actuals] of Object.entries(typeConfusion)) {
    log(`  ${pred}: ${JSON.stringify(actuals)}`);
  }

  log('\n## Comparison vs templated 80-page benchmark (test/benchmark-graph-quality.ts)');
  log('| Metric          | Templated 80-page | Rich-prose 240-page |');
  log('|-----------------|-------------------|---------------------|');
  log(`| Link recall     | 94.4%             | ${pct(linkRecall).padEnd(19)} |`);
  log(`| Link precision  | 100.0%            | ${pct(linkPrecision).padEnd(19)} |`);
  log(`| Type accuracy   | 94.4%             | ${pct(typeAccuracy).padEnd(19)} |`);

  if (json) {
    process.stdout.write(JSON.stringify({
      pages: pages.length,
      expected_links: expected.length,
      total_extracted: totalExtracted,
      linkRecall, linkPrecision, typeAccuracy, idempotent,
      typeBreakdown, typeConfusion,
    }, null, 2) + '\n');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
