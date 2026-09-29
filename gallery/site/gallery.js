// Mythic deck gallery: one card at a time, each sliding over the last.
// Standalone: reads cards.json (written by gallery/build.py), nothing else.
(function () {
  'use strict';

  var stage = document.getElementById('stage');
  var thumbsList = document.getElementById('thumbs');
  var prevBtn = document.getElementById('prev');
  var nextBtn = document.getElementById('next');
  var capTitle = document.getElementById('cap-title');
  var capSub = document.getElementById('cap-sub');
  var capEffect = document.getElementById('cap-effect');
  var capCount = document.getElementById('cap-count');
  var live = document.getElementById('live');

  var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var cards = [];
  var slides = [];
  var thumbs = [];
  var current = -1;
  var shownTimer = 0;

  function el(tag, props) {
    var node = document.createElement(tag);
    for (var key in props) {
      if (key === 'style') node.style.cssText = props.style;
      else if (key in node) node[key] = props[key];
      else node.setAttribute(key, props[key]);
    }
    return node;
  }

  function build(data) {
    cards = data.cards;
    var slideFrag = document.createDocumentFragment();
    var thumbFrag = document.createDocumentFragment();
    var lastRank = '';

    cards.forEach(function (card, i) {
      var ar = card.imgW + ' / ' + card.imgH;
      var fig = el('figure', {
        className: 'slide is-ahead',
        style: '--ar:' + ar + ';z-index:' + (i + 1),
        'data-testid': 'gallery-slide',
        'data-card': card.id,
        'aria-roledescription': 'slide',
        'aria-label': card.subtitle,
      });
      var img = el('img', {
        alt: card.alt,
        width: card.imgW,
        height: card.imgH,
        decoding: 'async',
        draggable: false,
      });
      img.dataset.src = card.img;
      fig.appendChild(img);
      slideFrag.appendChild(fig);
      slides.push(fig);

      var rank = card.kind === 'back' ? 'back' : card.id.split('-')[0];
      var li = el('li', {});
      if (rank !== lastRank && rank !== 'glasses') li.className = 'rank-start';
      lastRank = rank;
      var btn = el('button', {
        type: 'button',
        className: 'thumb',
        style: '--ar:' + card.thumbW + ' / ' + card.thumbH,
        'aria-label': card.subtitle + ', ' + card.title,
      });
      btn.appendChild(el('img', {
        src: card.thumb,
        alt: '',
        width: card.thumbW,
        height: card.thumbH,
        loading: 'lazy',
        decoding: 'async',
      }));
      btn.addEventListener('click', function () { go(i); });
      li.appendChild(btn);
      thumbFrag.appendChild(li);
      thumbs.push(btn);
    });

    stage.appendChild(slideFrag);
    thumbsList.appendChild(thumbFrag);
  }

  // Only the cards near the current one fetch their full image.
  function load(i) {
    var fig = slides[i];
    if (!fig) return;
    var img = fig.firstChild;
    if (img.dataset.src) {
      img.src = img.dataset.src;
      delete img.dataset.src;
    }
  }

  function go(target, fromUser) {
    if (fromUser === undefined) fromUser = true;
    target = Math.max(0, Math.min(cards.length - 1, target));
    if (target === current) return;
    var previous = current;
    current = target;

    for (var k = -1; k <= 2; k++) load(current + k);

    clearTimeout(shownTimer);
    slides.forEach(function (fig, i) {
      fig.classList.toggle('is-current', i === current);
      fig.classList.toggle('is-behind', i < current);
      fig.classList.toggle('is-ahead', i > current);
      fig.classList.toggle('is-under', i === current - 1);
      fig.classList.remove('is-shown');
      fig.style.transform = '';
      fig.style.filter = '';
      fig.setAttribute('aria-hidden', i === current ? 'false' : 'true');
    });
    // The card we left stays in view while the new one slides over it (or
    // while it slides away, going back); it hides once the motion ends.
    if (previous >= 0 && !motionQuery.matches) {
      slides[previous].classList.add('is-shown');
      shownTimer = setTimeout(function () {
        slides[previous].classList.remove('is-shown');
      }, 560);
    }

    var card = cards[current];
    capTitle.textContent = card.title;
    capSub.textContent = card.subtitle;
    capEffect.textContent = card.effect;
    capCount.textContent = (current + 1) + ' of ' + cards.length;
    prevBtn.disabled = current === 0;
    nextBtn.disabled = current === cards.length - 1;

    thumbs.forEach(function (btn, i) {
      if (i === current) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
    });
    revealThumb(thumbs[current], !motionQuery.matches && previous >= 0);

    if (fromUser) {
      live.textContent = (current + 1) + ' of ' + cards.length + ': ' + card.subtitle + ', ' + card.title + '.';
    }
    if (history.replaceState) history.replaceState(null, '', '#' + card.id);
  }

  // Centre the current thumbnail inside the index only. (scrollIntoView
  // would also scroll the page's own overflow-hidden box.)
  function revealThumb(btn, smooth) {
    var box = thumbsList.parentNode;
    var b = btn.getBoundingClientRect();
    var r = box.getBoundingClientRect();
    box.scrollTo({
      left: box.scrollLeft + (b.left - r.left) - (r.width - b.width) / 2,
      top: box.scrollTop + (b.top - r.top) - (r.height - b.height) / 2,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  // ---- Swipe: the card follows the finger, then settles or springs back.
  var drag = null;

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, dx: 0, id: e.pointerId, active: false };
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x;
    var dy = e.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;
      drag.active = true;
      stage.classList.add('dragging');
      stage.setPointerCapture(e.pointerId);
    }
    drag.dx = dx;
    var width = stage.clientWidth;
    var p = Math.min(1, Math.abs(dx) / width);
    var cur = slides[current];
    var nxt = slides[current + 1];
    var prv = slides[current - 1];
    if (dx < 0 && nxt) {
      // Pull the next card in over this one.
      load(current + 1);
      nxt.classList.add('is-shown');
      nxt.style.transform = 'translateX(' + (width * 1.12 + dx) + 'px) rotate(' + (3 * (1 - p)) + 'deg)';
      cur.style.transform = 'scale(' + (1 - 0.12 * p) + ')';
      cur.style.filter = 'brightness(' + (1 - 0.62 * p) + ')';
      if (prv) resetInline(prv);
    } else if (dx > 0 && prv) {
      // Slide this card off to reveal the one beneath.
      load(current - 1);
      prv.classList.add('is-shown');
      cur.style.transform = 'translateX(' + dx + 'px) rotate(' + (3 * p) + 'deg)';
      prv.style.transform = 'scale(' + (0.88 + 0.12 * p) + ')';
      prv.style.filter = 'brightness(' + (0.38 + 0.62 * p) + ')';
      if (nxt) resetInline(nxt);
    } else {
      // Past either end: a little resistance, no card to reveal.
      cur.style.transform = 'translateX(' + dx * 0.2 + 'px)';
    }
  }

  function resetInline(fig) {
    fig.style.transform = '';
    fig.style.filter = '';
    if (!fig.classList.contains('is-current')) fig.classList.remove('is-shown');
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag;
    drag = null;
    if (!d.active) return;
    stage.classList.remove('dragging');
    var threshold = Math.min(90, stage.clientWidth * 0.2);
    if (d.dx < -threshold && current < cards.length - 1) go(current + 1);
    else if (d.dx > threshold && current > 0) go(current - 1);
    else {
      [current - 1, current, current + 1].forEach(function (i) {
        if (slides[i]) resetInline(slides[i]);
      });
    }
  }

  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var map = { ArrowRight: 1, ArrowLeft: -1 };
    if (e.key in map) go(current + map[e.key]);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(cards.length - 1);
    else return;
    e.preventDefault();
  }

  function fromHash() {
    var id = decodeURIComponent(location.hash.slice(1));
    for (var i = 0; i < cards.length; i++) if (cards[i].id === id) return i;
    return 0;
  }

  fetch('cards.json')
    .then(function (r) {
      if (!r.ok) throw new Error('cards.json ' + r.status);
      return r.json();
    })
    .then(function (data) {
      build(data);
      go(fromHash(), false);
      prevBtn.addEventListener('click', function () { go(current - 1); });
      nextBtn.addEventListener('click', function () { go(current + 1); });
      document.addEventListener('keydown', onKey);
      stage.addEventListener('pointerdown', onDown);
      stage.addEventListener('pointermove', onMove);
      stage.addEventListener('pointerup', onUp);
      stage.addEventListener('pointercancel', onUp);
      window.addEventListener('hashchange', function () { go(fromHash()); });
      document.body.dataset.ready = 'true';
    })
    .catch(function () {
      stage.innerHTML = '<p class="fallback">The cards could not be loaded. Reload the page to try again.</p>';
    });
})();
