// Carousel pagination dots: one per visible story. The active dot follows the scroll position; a click scrolls to that story.
(function () {
  var track = document.querySelector('[data-desks]');
  var nav = document.getElementById('cr-dots');
  if (!track || !nav) return;
  var dots = [];
  var slides = function () { return track.querySelectorAll('article.story-card:not([data-cr-out])'); };
  var mark = function () {
    var i = track.clientWidth ? Math.round(track.scrollLeft / track.clientWidth) : 0;
    dots.forEach(function (d, j) { d.setAttribute('aria-current', j === i ? 'true' : 'false'); });
  };
  Array.prototype.forEach.call(slides(), function (_, i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cr-dot';
    b.setAttribute('aria-label', 'Story ' + (i + 1));
    b.onclick = function () { track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' }); };
    nav.appendChild(b);
    dots.push(b);
  });
  track.addEventListener('scroll', mark, { passive: true });
  window.addEventListener('resize', mark);
  mark();
})();
