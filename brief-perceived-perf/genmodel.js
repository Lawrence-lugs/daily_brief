// Pure presentation model for the generation panel (no DOM). Classic script: sets globalThis.GenModel.
// Also imported by node tests (it has no exports on purpose, so the same file works in both worlds).
//
// Honesty rule: the bar only advances on REAL events (phase / desk stage) or by a time creep that is
// capped below the end of the segment it belongs to, so it can never claim "done" early or go backwards
// (the client additionally keeps a running max).
(function (root) {
  const PREP_END = 0.15, EDIT_END = 0.92, COMMIT_END = 0.99;
  const creep = (t, tau) => 0.92 * (1 - Math.exp(-Math.max(0, t) / tau)); // always < 0.92

  const deskNames = (p) => Object.keys((p && p.desks) || {});

  /** c = { nowS, startS, deskStartS: {name: seconds}, commitStartS: seconds|null } */
  function fraction(p, c) {
    const since = (t) => c.nowS - (t == null ? c.nowS : t);
    if (!p || p.phase === 'fetching' || p.phase === 'selecting') return PREP_END * creep(c.nowS - c.startS, 15);
    if (p.phase === 'done') return 1;
    if (p.phase === 'committing') return EDIT_END + (COMMIT_END - EDIT_END) * creep(since(c.commitStartS), 3);
    const names = deskNames(p);
    const slice = (EDIT_END - PREP_END) / Math.max(1, names.length);
    let f = PREP_END;
    for (const n of names) {
      const d = p.desks[n];
      if (d.stage === 'edited') f += slice;
      else if (d.working) f += slice * creep(since((c.deskStartS || {})[n]), 30);
    }
    return Math.min(f, EDIT_END);
  }

  function steps(p) {
    const phase = p ? p.phase : 'fetching';
    const prep = phase === 'fetching' || phase === 'selecting';
    const out = [{ key: 'prep', label: 'Gathering and ranking sources', state: prep ? 'active' : 'done' }];
    for (const n of deskNames(p)) {
      const d = p.desks[n];
      out.push({ key: 'desk:' + n, label: 'Editing ' + (d.title || n),
        state: d.stage === 'edited' ? 'done' : d.working ? 'active' : 'todo' });
    }
    out.push({ key: 'save', label: 'Saving the edition',
      state: phase === 'done' ? 'done' : phase === 'committing' ? 'active' : 'todo' });
    return out;
  }

  function title(p) {
    if (!p || p.phase === 'fetching') return 'Gathering the latest items…';
    if (p.phase === 'selecting') return 'Choosing today’s stories…';
    if (p.phase === 'committing' || p.phase === 'done') return 'Saving the edition…';
    const ds = deskNames(p).map((n) => p.desks[n]);
    if (ds.length && ds.every((d) => d.stage === 'edited')) return 'Finishing up…';
    if (ds.some((d) => d.stage === 'raw' || d.stage === 'edited')) return 'Your stories are in. The editor is polishing the headlines.';
    return 'The editor is writing up your stories…';
  }

  function note(p, elapsedS) {
    const phase = p ? p.phase : 'fetching';
    if (phase !== 'editing') return '';
    if (elapsedS < 100) return 'Usually takes 60 to 90 seconds. You can keep reading.';
    if (elapsedS < 170) return 'Taking a little longer than usual.';
    return 'Still working. The editor model may be retrying; this page will update by itself.';
  }

  root.GenModel = { fraction, steps, title, note, PREP_END, EDIT_END, COMMIT_END };
})(typeof globalThis !== 'undefined' ? globalThis : this);
