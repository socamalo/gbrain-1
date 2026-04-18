/**
 * BrainBench Category 1 at scale — search quality on the 240-page rich-prose
 * corpus from eval/data/world-v1/.
 *
 * Tests keyword search (no embeddings — keeps the benchmark CI-friendly without
 * an OpenAI key) against rich-prose pages. Compares two configurations:
 *   A: keyword search only (no backlink boost)
 *   B: keyword search + backlink boost (+ 5% × log(1 + n))
 *
 * Synthesized queries from world structure: "who is X?", "what does Y do?",
 * "AI companies", etc. Each query has expected slugs computed from the facts
 * embedded in each page.
 *
 * Usage: bun eval/runner/search-rich.ts [--json]
 */

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
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
    name?: string;
    role?: string;
    industry?: string;
    category?: string;
    primary_affiliation?: string;
  };
}

function loadCorpus(dir: string): RichPage[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const out: RichPage[] = [];
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    if (Array.isArray(p.timeline)) p.timeline = p.timeline.join('\n');
    if (Array.isArray(p.compiled_truth)) p.compiled_truth = p.compiled_truth.join('\n\n');
    p.title = String(p.title ?? '');
    p.compiled_truth = String(p.compiled_truth ?? '');
    p.timeline = String(p.timeline ?? '');
    out.push(p as RichPage);
  }
  return out;
}

interface Query {
  question: string;
  /** Expected primary answer slug (top-1 ideal). */
  primary: string;
  /** Additional relevant slugs (graded relevance — appearing anywhere in top-K is good). */
  related?: string[];
}

function buildQueries(pages: RichPage[]): Query[] {
  const queries: Query[] = [];

  // Entity-lookup queries: "who is X?" / "what does Y do?"
  // Sample 20 random people and 20 random companies.
  const people = pages.filter(p => p._facts.type === 'person').slice(0, 20);
  const companies = pages.filter(p => p._facts.type === 'company').slice(0, 20);
  for (const p of people) {
    if (p._facts.name) {
      queries.push({ question: `who is ${p._facts.name}?`, primary: p.slug });
    }
  }
  for (const c of companies) {
    queries.push({ question: `what is ${c.title}?`, primary: c.slug });
  }

  // Industry queries: "AI infrastructure companies"
  // Group companies by industry; top-3 industries become queries.
  const byIndustry = new Map<string, string[]>();
  for (const c of companies) {
    if (c._facts.industry) {
      if (!byIndustry.has(c._facts.industry)) byIndustry.set(c._facts.industry, []);
      byIndustry.get(c._facts.industry)!.push(c.slug);
    }
  }
  for (const [industry, slugs] of [...byIndustry.entries()].slice(0, 5)) {
    if (slugs.length >= 2) {
      queries.push({
        question: `${industry} companies`,
        primary: slugs[0],
        related: slugs.slice(1),
      });
    }
  }

  // Role queries
  queries.push({ question: 'founders', primary: people[0].slug, related: people.slice(1, 5).map(p => p.slug) });
  queries.push({ question: 'partners venture capital', primary: people.find(p => p._facts.role === 'partner')?.slug ?? people[0].slug });

  return queries;
}

interface QueryResult {
  question: string;
  rankWithoutBoost: number;
  rankWithBoost: number;
  topKWithoutBoost: string[];
  topKWithBoost: string[];
  primary: string;
}

async function main() {
  const json = process.argv.includes('--json');
  const log = json ? () => {} : console.log;

  log('# BrainBench Category 1 at scale — Rich Corpus Search Quality\n');
  log(`Generated: ${new Date().toISOString().slice(0, 19)}`);

  const dir = 'eval/data/world-v1';
  const pages = loadCorpus(dir);
  log(`Corpus: ${pages.length} rich-prose pages from ${dir}/`);

  const queries = buildQueries(pages);
  log(`Queries: ${queries.length}`);

  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  log('\n## Seeding corpus + chunks');
  for (const p of pages) {
    await engine.putPage(p.slug, {
      type: p.type as 'person' | 'company' | 'meeting' | 'concept',
      title: p.title,
      compiled_truth: p.compiled_truth,
      timeline: p.timeline,
    });
    // searchKeyword joins content_chunks; populate one chunk per page.
    await engine.upsertChunks(p.slug, [
      { chunk_index: 0, chunk_text: `${p.title}\n${p.compiled_truth}`, chunk_source: 'compiled_truth' },
    ]);
  }
  log(`Seeded ${pages.length} pages with chunks.`);

  // Run extract to populate links (so backlink boost has data to work with).
  log('\n## Running extract for backlink boost data');
  const captureLog = console.error;
  console.error = () => {};
  try {
    const { runExtract } = await import('../../src/commands/extract.ts');
    await runExtract(engine, ['links', '--source', 'db']);
  } finally {
    console.error = captureLog;
  }
  const stats = await engine.getStats();
  log(`Links extracted: ${stats.link_count}`);

  // ── Run queries against both configurations ──
  log('\n## Running queries (A: no boost, B: backlink boost)');
  const results: QueryResult[] = [];
  for (const q of queries) {
    const raw = await engine.searchKeyword(q.question, { limit: 50 });

    // Page-level dedup by slug (keep best score per slug).
    const seenA = new Set<string>();
    const sortedA = [...raw]
      .sort((a, b) => b.score - a.score)
      .filter(r => { if (seenA.has(r.slug)) return false; seenA.add(r.slug); return true; });

    // Apply backlink boost.
    const counts = await engine.getBacklinkCounts(sortedA.map(r => r.slug));
    const boosted = sortedA.map(r => ({
      ...r,
      score: r.score * (1 + 0.05 * Math.log(1 + (counts.get(r.slug) ?? 0))),
    }));
    const sortedB = [...boosted].sort((a, b) => b.score - a.score);

    const rankOf = (sorted: typeof sortedA, slug: string): number => {
      const idx = sorted.findIndex(r => r.slug === slug);
      return idx === -1 ? 0 : idx + 1;
    };

    results.push({
      question: q.question,
      primary: q.primary,
      rankWithoutBoost: rankOf(sortedA, q.primary),
      rankWithBoost: rankOf(sortedB, q.primary),
      topKWithoutBoost: sortedA.slice(0, 5).map(r => r.slug),
      topKWithBoost: sortedB.slice(0, 5).map(r => r.slug),
    });
  }

  await engine.disconnect();

  // ── Metrics ──
  const found = (r: QueryResult, sorted: 'A' | 'B'): boolean => (sorted === 'A' ? r.rankWithoutBoost : r.rankWithBoost) > 0;
  const p1 = (sorted: 'A' | 'B'): number => results.filter(r => (sorted === 'A' ? r.rankWithoutBoost : r.rankWithBoost) === 1).length / results.length;
  const r5 = (sorted: 'A' | 'B'): number => results.filter(r => {
    const rk = sorted === 'A' ? r.rankWithoutBoost : r.rankWithBoost;
    return rk > 0 && rk <= 5;
  }).length / results.length;
  const mrr = (sorted: 'A' | 'B'): number => results.reduce((s, r) => {
    const rk = sorted === 'A' ? r.rankWithoutBoost : r.rankWithBoost;
    return s + (rk > 0 ? 1 / rk : 0);
  }, 0) / results.length;
  const avgRank = (sorted: 'A' | 'B'): number => {
    const ranks = results.map(r => sorted === 'A' ? r.rankWithoutBoost : r.rankWithBoost).filter(r => r > 0);
    return ranks.length > 0 ? ranks.reduce((a, b) => a + b, 0) / ranks.length : 0;
  };

  log('\n## Metrics: A (no boost) vs B (backlink boost)');
  log('| Metric         | A: no boost | B: with boost | Δ           |');
  log('|----------------|-------------|---------------|-------------|');
  const fmt = (a: number, b: number, isPct: boolean = true) => {
    const d = b - a;
    const aStr = isPct ? `${(a * 100).toFixed(1)}%` : a.toFixed(2);
    const bStr = isPct ? `${(b * 100).toFixed(1)}%` : b.toFixed(2);
    const dStr = isPct ? `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}pts` : `${d >= 0 ? '+' : ''}${d.toFixed(2)}`;
    return `| ${aStr.padEnd(11)} | ${bStr.padEnd(13)} | ${dStr.padEnd(11)} |`;
  };
  log(`| P@1            ${fmt(p1('A'), p1('B'))}`);
  log(`| Recall@5       ${fmt(r5('A'), r5('B'))}`);
  log(`| MRR            ${fmt(mrr('A'), mrr('B'), false)}`);
  log(`| Avg rank       ${fmt(avgRank('A'), avgRank('B'), false)}`);

  log('\n## Per-query breakdown (first 15)');
  log('| Question                         | A: rank | B: rank | A top-1                    | B top-1                    |');
  log('|----------------------------------|---------|---------|----------------------------|----------------------------|');
  for (const r of results.slice(0, 15)) {
    log(`| ${r.question.slice(0, 32).padEnd(32)} | ${String(r.rankWithoutBoost).padEnd(7)} | ${String(r.rankWithBoost).padEnd(7)} | ${(r.topKWithoutBoost[0] || 'none').slice(0, 26).padEnd(26)} | ${(r.topKWithBoost[0] || 'none').slice(0, 26).padEnd(26)} |`);
  }

  log('\n## What this benchmark surfaces');
  log('Keyword-only search (no embeddings) against 240 rich-prose pages.');
  log(`Queries that found primary in top-5: ${results.filter(r => r.rankWithBoost > 0 && r.rankWithBoost <= 5).length}/${results.length}`);
  log(`Queries that missed entirely (not in top-50): ${results.filter(r => r.rankWithBoost === 0).length}/${results.length}`);
  log('');
  log('Without OpenAI embeddings, semantic search is unavailable — the benchmark');
  log('measures pure tsvector/keyword performance on real prose. The backlink boost');
  log('moves well-connected entities up the ranking when keyword scores are tied.');

  if (json) {
    process.stdout.write(JSON.stringify({
      pages: pages.length,
      queries: queries.length,
      metrics: {
        a: { p1: p1('A'), r5: r5('A'), mrr: mrr('A'), avgRank: avgRank('A') },
        b: { p1: p1('B'), r5: r5('B'), mrr: mrr('B'), avgRank: avgRank('B') },
      },
      perQuery: results,
    }, null, 2) + '\n');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
