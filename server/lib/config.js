/** Config loader + validator for the desk/keyword contract (Phase 0).
 *
 * Reads `config.json` (which now owns `desks` and `keywords`, moved out of
 * `sources.json`) and exports:
 *   - DESKS: ordered list of { key, title }
 *   - subtopicToDesk: map from subtopic -> desk key
 *   - warnings: strings (non-fatal config issues)
 *
 * Validation rules:
 *   - Every desk subtopic must have a keyword group  -> hard error
 *   - Every keyword group must be assigned to a desk  -> warning (decision 4:
 *     the keyword round-robin depends on every subtopic belonging to a desk)
 *   - A subtopic may not be assigned to two desks      -> hard error
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../../user/config.js';

function loadJson(file, def = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return def; }
}

/** Load and validate desk/keyword config.
 * @param {string} dataDir   directory containing config.json
 * @returns {{DESKS:Array<{key:string,title:string}>, subtopicToDesk:Object<string,string>, warnings:string[]}}
 */
export function loadDesksConfig(dataDir) {
  const cfg = loadConfig(dataDir, 'config.json') ?? {};
  const desksRaw = cfg.desks ?? {};
  const keywords = cfg.keywords ?? {};

  const DESKS = [];
  const subtopicToDesk = {};
  const warnings = [];
  const errors = [];

  // Preserve insertion order of desks as declared in config.json.
  for (const [key, spec] of Object.entries(desksRaw)) {
    const title = (spec && typeof spec === 'object' && spec.title) ? String(spec.title) : key;
    const description = (spec && typeof spec === 'object' && spec.description) ? String(spec.description) : '';
    DESKS.push({ key, title, description });
    const subs = (spec && spec["keyword-model-subtopics"]) ? spec["keyword-model-subtopics"]
      : (spec && spec.subtopics) ? spec.subtopics
      : [];
    for (const s of subs) {
      if (subtopicToDesk[s]) {
        errors.push(`subtopic "${s}" is assigned to more than one desk: "${subtopicToDesk[s]}" and "${key}"`);
      } else {
        subtopicToDesk[s] = key;
      }
      // Every desk subtopic must have a keyword group (hard error).
      if (!(s in keywords)) {
        errors.push(`desk "${key}" references subtopic "${s}" but no keyword group "${s}" exists in config.keywords`);
      }
    }
    // Desks other than the catch-all `misc` should carry a description so the
    // editor LLM knows how to write headlines and blurbs. `misc` may rely on
    // its title alone.
    if (!description && key !== 'misc') {
      warnings.push(`desk "${key}" has no description; the editor will infer scope from its title`);
    }
  }

  // Decision 4: every keyword group should be assigned to a desk. A keyword
  // group with no desk can never be selected by the keyword round-robin.
  for (const sub of Object.keys(keywords)) {
    if (!(sub in subtopicToDesk)) {
      warnings.push(`keyword group "${sub}" is not assigned to any desk (items matching it will not be picked)`);
    }
  }

  if (errors.length) {
    throw new Error(`[config] invalid desk/keyword config:\n  - ${errors.join('\n  - ')}`);
  }

  return { DESKS, subtopicToDesk, warnings };
}

export { loadJson };
