/** Marker labels for items the legacy keyword groups cannot place.
 *
 * `classify()` (brief.js) never rejects an item, so unplaced items need a
 * value in the NOT NULL `candidate_pool.subtopic` / `desk` columns. These
 * markers are that value. They are deliberately kept in their own dependency
 * free module: brief.js reads them at admission, agent.js reads them when it
 * renders candidates, and importing brief.js from agent.js would create a
 * cycle (brief.js already imports agent.js).
 */
export const UNPLACED_SUBTOPIC = 'unclassified';
export const UNPLACED_DESK = 'misc';

/** True when a candidate's subtopic is a real keyword placement. */
export function isPlaced(subtopic) {
  return Boolean(subtopic) && subtopic !== UNPLACED_SUBTOPIC;
}
