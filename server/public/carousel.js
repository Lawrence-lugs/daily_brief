// Carousel pagination dots: one per visible story. The active dot follows the scroll position; a click scrolls to that story.
// Autoplay is opt-in via ?autoplay=1 (requires ?carousel=1), advances every 6s, pauses on hover/focus/tab-hidden,
// and stops permanently once the user interacts (dot click).
(function () {
  var track = document.querySelector('[data-desks]');
  var nav = document.getElementById('cr-dots');
  if (!track || !nav) return;
  var dots = [];
  var carouselActive = function () { return document.documentElement.classList.contains('cr'); };
  var slides = function () { return track.querySelectorAll('article.story-card:not([data-cr-out])'); };
  var mark = function () {
    var i = track.clientWidth ? Math.round(track.scrollLeft / track.clientWidth) : 0;
    dots.forEach(function (d, j) {
      var active = j === i;
      d.setAttribute('aria-current', active ? 'true' : 'false');
      d.classList.toggle('active', active);
    });
  };
  Array.prototype.forEach.call(slides(), function (_, i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'carousel-dot';
    b.setAttribute('aria-label', 'Story ' + (i + 1));
    b.onclick = function () { goToSlide(i); };
    nav.appendChild(b);
    dots.push(b);
  });

  /* ---- autoplay (opt-in via ?autoplay=1, 6s interval) ---- */
  var params = new URLSearchParams(location.search);
  var autoplayEnabled = params.get('autoplay') === '1';
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var userStopped = false;
  var hovered = false;
  var focused = false;
  var timer = null;

  function scrollToSlide(index) {
    var s = slides();
    if (!s.length || index < 0 || index >= s.length) return;
    track.scrollTo({ left: index * track.clientWidth, behavior: 'smooth' });
    mark();
  }

  function goToSlide(index) {
    scrollToSlide(index);
    userStopped = true;
    clearTimer();
  }

  function clearTimer() { clearInterval(timer); timer = null; }

  function shouldRotate() {
    return carouselActive() && autoplayEnabled && !reduced && !userStopped && !hovered && !focused && !document.hidden;
  }

  function nextSlide() {
    var s = slides();
    if (!s.length) return;
    var i = track.clientWidth ? Math.round(track.scrollLeft / track.clientWidth) : 0;
    scrollToSlide((i + 1) % s.length);
  }

  function start() { if (shouldRotate() && !timer) timer = setInterval(tick, 6000); }
  function stop() { clearTimer(); }
  function tick() { if (shouldRotate()) nextSlide(); else stop(); }

  track.addEventListener('scroll', mark, { passive: true });
  window.addEventListener('resize', mark);

  track.addEventListener('pointerenter', function () { hovered = true; stop(); });
  track.addEventListener('pointerleave', function () { hovered = false; start(); });
  nav.addEventListener('focusin', function () { focused = true; stop(); });
  nav.addEventListener('focusout', function () { focused = false; start(); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });

  mark();
  if (autoplayEnabled && !reduced) start();
})();
