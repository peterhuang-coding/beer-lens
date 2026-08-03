import type { BeerRecord } from './contracts.ts';
const strip = (s: string) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}=["']([^"']+)`, 'i'))?.[1] ?? '';
const first = (html: string, re: RegExp) => { const m = html.match(re); return m ? strip(m[1]) : ''; };
const list = (html: string, re: RegExp) => [...html.matchAll(re)].map(m => strip(m[1])).filter(Boolean);
export interface ListBeer { source_id: string; name: string; url: string; }
export function parseList(html: string, base = 'https://untappd.com'): ListBeer[] {
  const out: ListBeer[] = []; const seen = new Set<string>();
  for (const m of html.matchAll(/<([a-z0-9]+)\b[^>]*data-beer-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi)) {
    const id = m[2], body = m[3]; const name = first(body, /<(?:a|h[1-6]|span)[^>]*class=["'][^"']*(?:beer-name|name)[^"']*["'][^>]*>([\s\S]*?)<\//i) || strip(body).slice(0, 120); const href = body.match(/href=["']([^"']*\/beer\/[^"']*)/i)?.[1] ?? `/beer/${id}`;
    if (!seen.has(id)) { seen.add(id); out.push({ source_id: id, name, url: new URL(href, base).href }); }
  }
  return out;
}
export function parseDetail(html: string, base: ListBeer): BeerRecord {
  const text = strip(html); const number = (re: RegExp) => { const n = Number(first(html, re).replace(',', '.')); return Number.isFinite(n) ? n : null; };
  const section = (key: string) => { const m = html.match(new RegExp(`(?:data-tab|id)=["']${key}["'][^>]*>([\\s\\S]*?)(?=<[^>]+(?:data-tab|id)=["'](?:info|ratings|tags|food|similar)["']|$)`, 'i')); return m?.[1] ?? ''; };
  const values = (key: string) => list(section(key), /<(?:li|a|span|div)[^>]*>([\s\S]*?)<\//gi);
  const rating = number(/(?:rating|score)[^>]*>\s*([0-5](?:\.\d+)?)/i) ?? number(/([0-5](?:\.\d+)?)\s*\/\s*5/);
  const ids = [...section('similar').matchAll(/(?:data-beer-id|\/beer\/)(?:[="']|\/)?(\d+)/gi)].map(m => m[1]);
  return { source: 'untappd', source_id: base.source_id, name: first(html, /<h1[^>]*>([\s\S]*?)<\//i) || base.name, brewery_id: first(html, /(?:brewery-id|data-brewery-id)=["']([^"']+)/i) || null, style: first(html, /class=["'][^"']*style[^"']*["'][^>]*>([\s\S]*?)<\//i) || null, abv: number(/ABV[^\d]*([\d.]+)/i), ibu: number(/IBU[^\d]*([\d.]+)/i), rating, rating_count: number(/(?:ratings?|reviews?)[^\d]*([\d,]+)/i), description: first(html, /class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\//i) || null, labels: values('tags'), food_pairing: values('food'), similar_ids: [...new Set(ids)], url: base.url, fetched_at: new Date().toISOString() };
}
