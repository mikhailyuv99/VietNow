// Search page logic: hero search, Supabase-backed results with media,
// Login/Sign-up modal (Supabase Auth), contact chatbox. Vanilla JS only.
(function () {
  "use strict";

  const cfg = window.VN_CONFIG || {};
  const hasSupabase = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && !cfg.supabaseUrl.includes("YOUR-PROJECT"));
  if (!hasSupabase) console.warn("Supabase is not configured. Edit assets/config.js.");

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function tgUrl() {
    const ch = String(cfg.telegramChannel || "vietnam_now44").replace(/^@/, "");
    return `https://t.me/${ch}`;
  }

  // --- Reference data -----------------------------------------------------
  const CATEGORIES = [
    { id: "housing",     label: "Housing" },
    { id: "visa_legal",  label: "Visa & legal" },
    { id: "jobs",        label: "Jobs" },
    { id: "food",        label: "Food" },
    { id: "transport",   label: "Transport" },
    { id: "health",      label: "Health" },
    { id: "services",    label: "Services" },
    { id: "events",      label: "Events" },
    { id: "classifieds", label: "Classifieds" },
    { id: "tourism",     label: "Tourism" },
    { id: "education",   label: "Education" },
  ];
  const CITIES = ["Hanoi", "HCMC", "Da Nang", "Nha Trang", "Phu Quoc", "Vung Tau", "Da Lat", "Hai Phong", "Mui Ne", "Hoi An"];
  const TIME_RANGES = [
    { id: "hour",   label: "Last hour",    hours: 1 },
    { id: "day",    label: "24h",          hours: 24 },
    { id: "week",   label: "Week",         hours: 24 * 7 },
    { id: "month",  label: "Month",        hours: 24 * 30 },
    { id: "3month", label: "3 months",     hours: 24 * 90 },
    { id: "year",   label: "Year",         hours: 24 * 365 },
    { id: "all",    label: "All time",     hours: null },
  ];
  const PAGE_SIZE = 20;

  // --- State (URL-synced) -------------------------------------------------
  const params = new URLSearchParams(location.search);
  const state = {
    q: params.get("q") || "",
    categories: (params.get("cat") || "").split(",").filter(Boolean),
    cities: (params.get("city") || "").split(",").filter(Boolean),
    range: params.get("t") || "year",
    lang: params.get("lang") || "en",
    page: 0,
    results: [],
    done: false,
  };

  function pushUrl() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.categories.length) p.set("cat", state.categories.join(","));
    if (state.cities.length) p.set("city", state.cities.join(","));
    if (state.range && state.range !== "year") p.set("t", state.range);
    if (state.lang && state.lang !== "en") p.set("lang", state.lang);
    const qs = p.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  }

  function sinceForRange(rangeId) {
    const r = TIME_RANGES.find((x) => x.id === rangeId);
    if (!r || r.hours == null) return null;
    return new Date(Date.now() - r.hours * 3600 * 1000).toISOString();
  }

  // --- Supabase helpers ---------------------------------------------------
  const sbHeaders = () => ({
    "Content-Type": "application/json",
    apikey: cfg.supabaseAnonKey,
    Authorization: `Bearer ${cfg.supabaseAnonKey}`,
  });

  async function sbRpc(fn, body) {
    const resp = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: sbHeaders(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`${fn} HTTP ${resp.status}`);
    return resp.json();
  }

  async function sbInsert(table, row) {
    const resp = await fetch(`${cfg.supabaseUrl}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...sbHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify(row),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`insert ${table} ${resp.status}: ${text}`);
    }
  }

  // --- Search execution ---------------------------------------------------
  async function runSearch({ reset }) {
    if (reset) {
      state.page = 0;
      state.results = [];
      state.done = false;
    }
    if (state.done) return;

    const hasQuery = !!(state.q || state.categories.length || state.cities.length);
    const wrap = $("#resultsWrap");
    if (wrap) wrap.classList.toggle("hidden", !hasQuery);
    if (!hasQuery) return;

    setStatus("Searching…");
    if (!hasSupabase) { setStatus("Search isn't configured yet. Admin: fill in assets/config.js."); return; }

    try {
      const rows = await sbRpc("search_messages", {
        q: state.q || "",
        categories_in: state.categories.length ? state.categories : null,
        cities_in: state.cities.length ? state.cities : null,
        since: sinceForRange(state.range),
        until: null,
        page_size: PAGE_SIZE,
        page_offset: state.page * PAGE_SIZE,
      });
      state.results = state.results.concat(rows);
      if (!rows || rows.length < PAGE_SIZE) state.done = true;
      state.page += 1;
      renderResults();
    } catch (err) {
      console.error(err);
      setStatus("Could not load results. Check your connection.");
    }
  }

  function setStatus(text) {
    const el = $("#searchStatus");
    if (el) el.textContent = text || "";
  }

  // --- Rendering ----------------------------------------------------------
  const escapeHtml = (s) => (s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

  function highlight(text, query) {
    if (!query) return escapeHtml(text);
    const tokens = query.split(/\s+/).filter(Boolean)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .filter((w) => w.length >= 2);
    if (!tokens.length) return escapeHtml(text);
    const re = new RegExp(`(${tokens.join("|")})`, "gi");
    return escapeHtml(text).replace(re, "<mark>$1</mark>");
  }

  function truncate(s, n) {
    s = s || "";
    return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
  }

  function formatDate(iso) {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString();
  }

  function pickText(row) {
    const key = `text_${state.lang}`;
    return (row[key] && row[key].trim()) || row.text_ru || row.text_en || row.text_vi || "";
  }

  function categoryLabel(id) {
    const c = CATEGORIES.find((x) => x.id === id);
    return c ? c.label : id;
  }

  function resultCard(row) {
    const text = truncate(pickText(row), 420);
    const q = state.q;
    const cityChip = row.city ? `<span class="tag"><strong>${escapeHtml(row.city)}</strong></span>` : "";
    const catChips = (row.categories || []).slice(0, 3)
      .filter((c) => c !== "other")
      .map((c) => `<span class="tag">${escapeHtml(categoryLabel(c))}</span>`)
      .join("");
    const tagChips = (row.ai_tags || []).slice(0, 3)
      .map((c) => `<span class="tag">#${escapeHtml(c)}</span>`).join("");

    const media = row.media_url
      ? `<img class="result-media" loading="lazy" src="${escapeHtml(row.media_url)}" alt="">`
      : "";

    const linkedText = linkify(text, q);

    return `
      <article class="result-card">
        ${media}
        <div class="result-head">
          <div class="tags">${cityChip}${catChips}${tagChips}</div>
          <span class="result-date">${formatDate(row.posted_at)}</span>
        </div>
        <p class="result-text">${linkedText}</p>
        <div class="result-actions">
          <a class="brand-btn" href="${escapeHtml(row.telegram_url)}" target="_blank" rel="noreferrer">Open in Telegram &rarr;</a>
          ${row.author ? `<span class="result-author">${escapeHtml(row.author)}</span>` : ""}
        </div>
      </article>`;
  }

  // Escape then highlight query, then linkify URLs. Order matters: we highlight first
  // so we don't accidentally match inside <a> tags; then URL-ize things that still look like links.
  function linkify(text, q) {
    const highlighted = highlight(text, q);
    return highlighted.replace(
      /(https?:\/\/[^\s<]+)(?![^<]*<\/a>)/g,
      (url) => `<a class="link" href="${url}" target="_blank" rel="noreferrer">${url}</a>`
    );
  }

  function renderResults() {
    const list = $("#results");
    if (!list) return;
    list.innerHTML = state.results.map(resultCard).join("");
    const counter = $("#resultsCount");
    if (counter) counter.textContent = String(state.results.length);
    const noun = $("#resultsNoun");
    if (noun) noun.textContent = state.results.length === 1 ? "result" : "results";

    const moreBtn = $("#loadMoreBtn");
    if (moreBtn) moreBtn.style.display = state.done || !state.results.length ? "none" : "";

    if (!state.results.length) setStatus("No results yet. Try different words or widen the time range.");
    else setStatus("");
    updateFilterSummary();
  }

  // --- Filter modal -------------------------------------------------------
  function langLabel(code) {
    return { en: "EN", ru: "RU", vi: "VI" }[code] || code;
  }

  function updateFilterSummary() {
    const el = $("#filterSummaryShort");
    if (!el) return;
    const parts = [langLabel(state.lang)];
    const tr = TIME_RANGES.find((x) => x.id === state.range);
    parts.push(tr ? tr.label : state.range);
    if (state.categories.length) parts.push(`${state.categories.length} categories`);
    if (state.cities.length) parts.push(`${state.cities.length} cities`);
    el.textContent = parts.join(" · ");
  }

  function syncControlsFromState() {
    const lang = $("#fltLang");
    const time = $("#fltTime");
    if (lang) lang.value = state.lang;
    if (time) time.value = state.range;
    $$("#fltCatGrid input[type=checkbox]").forEach((inp) => {
      inp.checked = state.categories.includes(inp.value);
    });
    $$("#fltCityGrid input[type=checkbox]").forEach((inp) => {
      inp.checked = state.cities.includes(inp.value);
    });
  }

  function readControlsIntoState() {
    const lang = $("#fltLang");
    const time = $("#fltTime");
    if (lang) state.lang = lang.value || "en";
    if (time) state.range = time.value || "year";
    state.categories = $$("#fltCatGrid input[type=checkbox]:checked").map((i) => i.value);
    state.cities = $$("#fltCityGrid input[type=checkbox]:checked").map((i) => i.value);
  }

  function openFilterModal() {
    const modal = $("#filterModal");
    const openBtn = $("#filterOpenBtn");
    if (!modal) return;
    syncControlsFromState();
    modal.classList.add("open");
    modal.hidden = false;
    if (openBtn) openBtn.setAttribute("aria-expanded", "true");
  }

  function closeFilterModal() {
    const modal = $("#filterModal");
    const openBtn = $("#filterOpenBtn");
    if (!modal) return;
    modal.classList.remove("open");
    modal.hidden = true;
    if (openBtn) openBtn.setAttribute("aria-expanded", "false");
  }

  function mountFilterModal() {
    const timeSel = $("#fltTime");
    const catGrid = $("#fltCatGrid");
    const cityGrid = $("#fltCityGrid");
    if (!timeSel || !catGrid || !cityGrid) return;

    timeSel.innerHTML = TIME_RANGES.map((r) =>
      `<option value="${escapeHtml(r.id)}">${escapeHtml(r.label)}</option>`
    ).join("");

    catGrid.innerHTML = CATEGORIES.map((c) => `
      <label class="filter-check">
        <input type="checkbox" name="flt-cat" value="${escapeHtml(c.id)}" />
        <span>${escapeHtml(c.label)}</span>
      </label>
    `).join("");

    cityGrid.innerHTML = CITIES.map((city) => `
      <label class="filter-check">
        <input type="checkbox" name="flt-city" value="${escapeHtml(city)}" />
        <span>${escapeHtml(city)}</span>
      </label>
    `).join("");

    const openers = [$("#filterOpenBtn"), $("#resultsFilterEditBtn")].filter(Boolean);
    openers.forEach((btn) => btn.addEventListener("click", () => openFilterModal()));

    const filterBackdrop = $("#filterModal");
    if (filterBackdrop) {
      $$("[data-filter-close]", filterBackdrop).forEach((b) =>
        b.addEventListener("click", () => closeFilterModal())
      );
      filterBackdrop.addEventListener("click", (ev) => {
        if (ev.target === filterBackdrop) closeFilterModal();
      });
    }

    const fltApply = $("#fltApply");
    if (fltApply) {
      fltApply.addEventListener("click", () => {
        readControlsIntoState();
        pushUrl();
        updateFilterSummary();
        closeFilterModal();
        const hasQuery = !!(state.q || state.categories.length || state.cities.length);
        if (hasQuery) runSearch({ reset: true });
        else renderResults();
      });
    }

    const fltClear = $("#fltClear");
    if (fltClear) {
      fltClear.addEventListener("click", () => {
        state.categories = [];
        state.cities = [];
        state.range = "year";
        state.lang = "en";
        syncControlsFromState();
        pushUrl();
        updateFilterSummary();
        const hasQuery = !!(state.q || state.categories.length || state.cities.length);
        if (hasQuery) runSearch({ reset: true });
        else renderResults();
      });
    }

    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      const fm = $("#filterModal");
      if (fm && fm.classList.contains("open")) {
        closeFilterModal();
        ev.preventDefault();
      }
    });

    updateFilterSummary();
  }

  // --- Hero search form ---------------------------------------------------
  function mountHero() {
    const form = $("#heroSearch");
    const input = $("#searchInput");
    if (!form || !input) return;
    input.value = state.q;
    let t = 0;

    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      clearTimeout(t);
      state.q = input.value.trim();
      pushUrl();
      runSearch({ reset: true });
    });

    input.addEventListener("input", () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        state.q = input.value.trim();
        pushUrl();
        runSearch({ reset: true });
      }, 320);
    });

    $$(".chip-suggest").forEach((chip) => {
      chip.addEventListener("click", () => {
        const q = chip.getAttribute("data-suggest") || "";
        input.value = q;
        state.q = q;
        pushUrl();
        runSearch({ reset: true });
        input.focus();
      });
    });

    const moreBtn = $("#loadMoreBtn");
    if (moreBtn) moreBtn.addEventListener("click", () => runSearch({ reset: false }));
  }

  // --- Auth modal (Supabase Auth via REST) --------------------------------
  function mountAuth() {
    const modal = $("#authModal");
    if (!modal) return;
    const form = $("#authForm");
    const submit = $("#authSubmit");
    const status = $("#authStatus");
    const tabs = $$("[data-auth-tab]", modal);
    let mode = "login";

    const open = (which) => {
      mode = which === "register" ? "register" : "login";
      tabs.forEach((t) => t.setAttribute("aria-selected", t.getAttribute("data-auth-tab") === mode ? "true" : "false"));
      submit.textContent = mode === "register" ? "Create account" : "Login";
      $("#authTitle").textContent = mode === "register" ? "Create your account" : "Welcome back";
      $("#authSub").textContent = mode === "register"
        ? "Sign up to save searches and get alerts (coming soon)."
        : "Log in to save searches and get alerts (coming soon).";
      status.textContent = "";
      status.className = "form-status";
      modal.classList.add("open");
      modal.hidden = false;
      setTimeout(() => form.querySelector("input[name=email]").focus(), 50);
    };
    const close = () => { modal.classList.remove("open"); modal.hidden = true; };

    $$("[data-auth-open]").forEach((b) => b.addEventListener("click", () => open(b.getAttribute("data-auth-open"))));
    $$("[data-auth-close]", modal).forEach((b) => b.addEventListener("click", close));
    modal.addEventListener("click", (ev) => { if (ev.target === modal) close(); });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && modal.classList.contains("open")) close(); });
    tabs.forEach((t) => t.addEventListener("click", () => open(t.getAttribute("data-auth-tab"))));

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!hasSupabase) {
        status.className = "form-status error";
        status.textContent = "Auth is not configured yet.";
        return;
      }
      const data = new FormData(form);
      const email = String(data.get("email") || "").trim();
      const password = String(data.get("password") || "");
      if (!email || password.length < 6) {
        status.className = "form-status error";
        status.textContent = "Please enter a valid email and a password with 6+ characters.";
        return;
      }
      submit.disabled = true;
      status.className = "form-status";
      status.textContent = mode === "register" ? "Creating your account…" : "Signing in…";
      try {
        const endpoint = mode === "register" ? "signup" : "token?grant_type=password";
        const resp = await fetch(`${cfg.supabaseUrl}/auth/v1/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: cfg.supabaseAnonKey },
          body: JSON.stringify({ email, password }),
        });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(body.error_description || body.msg || `HTTP ${resp.status}`);
        if (body.access_token) {
          localStorage.setItem("vn_session", JSON.stringify({ email, token: body.access_token }));
        }
        status.className = "form-status success";
        status.textContent = mode === "register"
          ? "Account created. Check your inbox if confirmation is required."
          : "Signed in. Welcome!";
        setTimeout(close, 900);
        renderSession();
      } catch (err) {
        status.className = "form-status error";
        status.textContent = err.message || "Something went wrong.";
      } finally {
        submit.disabled = false;
      }
    });
  }

  function renderSession() {
    const raw = localStorage.getItem("vn_session");
    const box = $("#miniBarAuth");
    if (!box || !raw) return;
    try {
      const { email } = JSON.parse(raw);
      if (!email) return;
      box.innerHTML = `
        <span class="link-btn" aria-disabled="true" title="${escapeHtml(email)}">${escapeHtml(email.split("@")[0])}</span>
        <button class="link-btn" type="button" id="logoutBtn">Log out</button>
      `;
      $("#logoutBtn").addEventListener("click", () => {
        localStorage.removeItem("vn_session");
        location.reload();
      });
    } catch {}
  }

  // --- Contact chatbox ----------------------------------------------------
  function mountChatbox() {
    const btn = $("#chatboxBtn");
    const panel = $("#chatboxPanel");
    const form = $("#contactForm");
    const submit = $("#contactSubmit");
    const status = $("#contactStatus");
    if (!btn || !panel || !form) return;

    const open = () => {
      panel.classList.add("open");
      panel.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      setTimeout(() => form.querySelector("textarea").focus(), 40);
    };
    const close = () => {
      panel.classList.remove("open");
      panel.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    };
    btn.addEventListener("click", () => {
      (panel.classList.contains("open") ? close : open)();
    });
    document.addEventListener("click", (ev) => {
      if (!panel.classList.contains("open")) return;
      if (ev.target.closest("#chatboxPanel") || ev.target.closest("#chatboxBtn")) return;
      close();
    });
    $$("[data-chatbox-open]").forEach((el) => el.addEventListener("click", (ev) => { ev.preventDefault(); open(); }));

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const data = new FormData(form);
      const message = String(data.get("message") || "").trim();
      if (!message) {
        status.className = "form-status error";
        status.textContent = "Please write a short message.";
        return;
      }
      if (!hasSupabase) {
        status.className = "form-status error";
        status.textContent = "Contact form isn't configured yet. Please use Telegram for now.";
        return;
      }
      submit.disabled = true;
      status.className = "form-status";
      status.textContent = "Sending…";
      try {
        await sbInsert("contacts", {
          name: String(data.get("name") || "").trim() || null,
          email: String(data.get("email") || "").trim() || null,
          message,
          user_agent: navigator.userAgent,
          locale: navigator.language,
        });
        status.className = "form-status success";
        status.textContent = "Thanks — message received. We'll get back to you.";
        form.reset();
        setTimeout(close, 1400);
      } catch (err) {
        console.error(err);
        status.className = "form-status error";
        status.textContent = "Could not send. Please try Telegram instead.";
      } finally {
        submit.disabled = false;
      }
    });
  }

  // --- Boot ---------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    const join = $("#joinTgHeader");
    if (join) join.href = tgUrl();
    const chatTg = $("#chatboxTgLink");
    if (chatTg) chatTg.href = tgUrl();

    mountHero();
    mountFilterModal();
    mountAuth();
    mountChatbox();
    renderSession();

    if (state.q || state.categories.length || state.cities.length) {
      runSearch({ reset: true });
    }
    updateFilterSummary();
  });
})();
