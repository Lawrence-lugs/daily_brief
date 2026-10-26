// Tiny node helper for tools/parity.js parity check.
// Fetches GET /api/briefs/<id> from the running server and renders each story
// with makeRenderer().renderStory, emitting JSON {story_id, desk, position, html}.
import { makeRenderer } from '../server/lib/render.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const [briefId, server] = process.argv.slice(2);
const renderer = makeRenderer({
  templatesDir: path.join(root, 'server', 'templates'),
  cssFile: path.join(root, 'tailwind.css'),
  paperName: 'The Daily Brief',
});

const res = await fetch(`${server}/api/briefs/${briefId}`);
if (!res.ok) throw new Error(`GET /api/briefs/${briefId} -> ${res.status}`);
const d = await res.json();

const out = [];
for (const desk of Object.keys(d.desks)) {
  for (const [i, s] of d.desks[desk].stories.entries()) {
    out.push({
      story_id: s.story_id,
      desk,
      position: i,
      html: renderer.renderStory(s, i === 0),
    });
  }
}
process.stdout.write(JSON.stringify(out));
