// Lightweight UI helpers: mobile nav + filters (no framework).
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Mobile nav toggle
  const menuBtn = $('#menuBtn');
  const mobileNav = $('#mobileNav');
  if (menuBtn && mobileNav) {
    const setOpen = (open) => {
      mobileNav.classList.toggle('open', open);
      menuBtn.setAttribute('aria-expanded', String(open));
    };
    menuBtn.addEventListener('click', () => {
      const open = !mobileNav.classList.contains('open');
      setOpen(open);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
    });
    document.addEventListener('click', (e) => {
      if (!mobileNav.classList.contains('open')) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest('#mobileNav')) return;
      if (target.closest('#menuBtn')) return;
      setOpen(false);
    });
  }

  // Search + tag filter for any .filterable list
  const searchInput = $('#searchInput');
  const pills = $$('.pill[data-filter]');
  const cards = $$('.card[data-search]');

  if ((searchInput || pills.length) && cards.length) {
    let activeFilter = 'all';

    const normalize = (s) =>
      (s || '')
        .toString()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

    const matchesFilter = (card) => {
      if (activeFilter === 'all') return true;
      const tags = normalize(card.getAttribute('data-tags'));
      return tags.split(',').map((t) => t.trim()).includes(activeFilter);
    };

    const matchesQuery = (card) => {
      const q = normalize(searchInput ? searchInput.value : '');
      if (!q) return true;
      const hay = normalize(card.getAttribute('data-search'));
      return hay.includes(q);
    };

    const apply = () => {
      let shown = 0;
      for (const card of cards) {
        const ok = matchesFilter(card) && matchesQuery(card);
        card.style.display = ok ? '' : 'none';
        if (ok) shown += 1;
      }
      const counter = $('#resultsCount');
      if (counter) counter.textContent = String(shown);
    };

    for (const pill of pills) {
      pill.addEventListener('click', () => {
        activeFilter = pill.getAttribute('data-filter') || 'all';
        for (const p of pills) p.setAttribute('aria-pressed', 'false');
        pill.setAttribute('aria-pressed', 'true');
        apply();
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', apply);
    }

    apply();
  }
})();

