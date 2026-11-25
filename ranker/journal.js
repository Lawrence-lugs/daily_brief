// Feed aliases used by the RSS TOCs and OpenAlex venue records.
const venues = [
  ['jssc', /\bJSSC\b|journal of solid.state circuits/i],
  ['jetcas', /\bJETCAS\b|emerging and selected topics in circuits and systems/i],
  ['tcasai', /\bTCASAI\b|circuits and systems for artificial intelligence/i],
  ['tcas1', /\bTCAS-I\b|circuits and systems[ ,:-]+I\b/i],
];

export function circuitJournal(item) {
  const name = [item.source, item.feed].join(' ');
  return venues.find(([, pattern]) => pattern.test(name))?.[0];
}

export function journalFrontMatter(item) {
  return !!circuitJournal(item) && /^(table of contents|corrections? to|errat(?:um|a) to|new associate editors?|guest editorial|.*\b(?:information for authors|publication information)\s*$|\w+ \d{4} issue of\b)/i.test(item.title.trim());
}
