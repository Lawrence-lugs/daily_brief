/** Semantic Scholar Graph API source fetcher (port of src/fetch/semanticscholar.js).

Fetches from https://api.semanticscholar.org/graph/v1 and registers itself as
the "api" fetcher for "semanticscholar" sources.
*/
import { Fetcher, makeItem, canonicalUrl, parseDate, stripHtml, registerApiFetcher } from './fetcher.js';

class SemanticScholarFetcher extends Fetcher {
  async fetch(spec) {
    await this.throttle();
    return s2Items(this, spec);
  }
}

function s2Endpoint(spec) {
  const limit = spec.limit ?? 12;
  const params = new URLSearchParams({
    query: spec.query,
    limit: String(limit),
    fields: 'title,abstract,url,publicationDate,year,externalIds',
  }).toString();
  return `https://api.semanticscholar.org/graph/v1/paper/search?${params}`;
}

async function s2Items(f, spec) {
  const text = await f.get(s2Endpoint(spec));
  const data = JSON.parse(text);
  const out = [];
  for (const item of data.data ?? []) {
    const title = item.title ?? '';
    if (!title) continue;
    const ids = item.externalIds ?? {};
    const arxivId = ids.ArXiv;
    const url = arxivId ? `https://arxiv.org/abs/${arxivId}` : (item.url || `https://www.semanticscholar.org/paper/${item.paperId}`);
    const date = parseDate(item.publicationDate || String(item.year ?? ''));
    const authors = (item.authors ?? []).map(a => a.name).filter(Boolean);
    out.push(makeItem(
      url, title, item.abstract ?? '', date,
      'Semantic Scholar', spec.subtopic, spec.weight,
      undefined, spec.type ?? 'researchlike', authors,
    ));
  }
  return out;
}

export async function fetchSemanticscholar(f, spec) {
  await f.throttle();
  return s2Items(f, spec);
}

registerApiFetcher('semanticscholar', fetchSemanticscholar);
