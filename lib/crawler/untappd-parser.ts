import type { BeerRecord } from './contracts.ts';
const strip = (s: string) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}=["']([^"']+)`, 'i'))?.[1] ?? '';
const first = (html: string, re: RegExp) => { const m = html.match(re); return m ? strip(m[1]) : ''; };
const list = (html: string, re: RegExp) => [...html.matchAll(re)].map(m => strip(m[1])).filter(Boolean);
export interface ListBeer { source_id: string; name: string; url: string; }
export function parseList(html: string, base = 'https://untappd.com'): ListBeer[] {
  const candidates: (ListBeer & { position: number })[] = [];
  const beerUrl = (href: string) => {
    try {
      const url = new URL(href.replace(/&amp;/g, '&'), base);
      if (!['untappd.com', 'www.untappd.com'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) return null;
      return /^\/(?:b\/[^/]+\/\d+|beer\/[^/]+)\/?$/.test(url.pathname) ? url : null;
    } catch { return null; }
  };
  // Canonical links also appear on cards with no data-beer-id attribute.
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const url = beerUrl(attr(m[1], 'href'));
    const id = url?.pathname.match(/^\/b\/[^/]+\/(\d+)\/?$/)?.[1]
      ?? url?.pathname.match(/^\/beer\/(\d+)\/?$/)?.[1];
    if (id && url) candidates.push({ source_id: id, name: strip(m[2]), url: url.href, position: m.index });
  }
  // Preserve older cards whose /beer/<slug> links need the explicit ID.
  for (const m of html.matchAll(/<([a-z0-9]+)\b[^>]*data-beer-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi)) {
    const body = m[3];
    const link = [...body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
      .map(a => ({ url: beerUrl(attr(a[1], 'href')), name: strip(a[2]) })).find(a => a.url);
    if (link?.url) candidates.push({ source_id: m[2], name: link.name || strip(body).slice(0, 120), url: link.url.href, position: m.index });
  }
  const out = new Map<string, ListBeer>();
  for (const { position, ...beer } of candidates.sort((a, b) => a.position - b.position)) {
    const existing = out.get(beer.source_id);
    if (!existing) out.set(beer.source_id, beer);
    else if (!existing.name && beer.name) existing.name = beer.name;
  }
  return [...out.values()];
}
export function parseDetail(html: string, base: ListBeer): BeerRecord {
  const text = strip(html.replace(/<\/(?:p|div|li|span|h[1-6])>/gi, ' | '));
  const number = (re: RegExp, input = text) => {
    const raw = first(input, re);
    if (!raw) return null;
    const n = Number(raw.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const section = (key: string) => { const m = html.match(new RegExp(`(?:data-tab|id)=["']${key}["'][^>]*>([\\s\\S]*?)(?=<[^>]+(?:data-tab|id)=["'](?:info|ratings|tags|food|similar)["']|$)`, 'i')); return m?.[1] ?? ''; };
  const values = (key: string) => list(section(key), /<(?:li|a|span|div)[^>]*>([\s\S]*?)<\//gi);
  const rating = number(/class=["'][^"']*\b(?:rating|score)\b[^"']*["'][^>]*>\s*([0-5](?:\.\d+)?)(?![\d.])/i, html) ?? number(/([0-5](?:\.\d+)?)\s*\/\s*5/);
  const ids = [...section('similar').matchAll(/(?:data-beer-id|\/beer\/)(?:[="']|\/)?(\d+)/gi)].map(m => m[1]);
  return { source: 'untappd', source_id: base.source_id, name: first(html, /<h1[^>]*>([\s\S]*?)<\//i) || base.name, brewery_id: first(html, /(?:brewery-id|data-brewery-id)=["']([^"']+)/i) || null, style: first(html, /class=["'][^"']*style[^"']*["'][^>]*>([\s\S]*?)<\//i) || null, abv: number(/\bABV\s*:?\s*(\d+(?:\.\d+)?)/i) ?? number(/\b(\d+(?:\.\d+)?)\s*%?\s*ABV\b/i), ibu: number(/\bIBU\s*:?\s*(\d+(?:\.\d+)?)/i) ?? number(/\b(\d+(?:\.\d+)?)\s*IBU\b/i), rating, rating_count: number(/\b(?:ratings?|reviews?)\s*:?\s*(\d[\d,]*)/i) ?? number(/\b(\d[\d,]*)\s*(?:ratings?|reviews?)\b/i), description: first(html, /class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\//i) || null, labels: values('tags'), food_pairing: values('food'), similar_ids: [...new Set(ids)], url: base.url, fetched_at: new Date().toISOString() };
}
