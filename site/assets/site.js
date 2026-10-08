// Sọ̀rọ̀ site: the hero chat demo, scroll reveals and a few small touches.
// Without JS (or with reduced motion) every message and section simply shows as plain HTML.
(() => {
  const root = document.documentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!still) root.classList.add("motion");
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));

  // Header: frosted backdrop once the page scrolls.
  const head = document.querySelector(".site-head");
  const onScroll = () => head.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Voice notes: bars of uneven height that fill while the note "plays".
  const HEIGHTS = [5, 9, 14, 8, 18, 12, 20, 10, 15, 7, 17, 11, 19, 9, 13, 6, 16, 12, 18, 8, 14, 10, 6, 12, 9, 15, 7, 11];
  for (const wave of document.querySelectorAll(".wave")) wave.innerHTML = HEIGHTS.map((h) => `<i style="height:${h}px"></i>`).join("");

  async function playVoice(voice, ms, alive) {
    const bars = [...voice.querySelectorAll(".wave i")];
    voice.classList.add("playing");
    for (const bar of bars) {
      if (!alive()) break;
      bar.classList.add("on");
      await wait(ms / bars.length);
    }
    voice.classList.remove("playing");
  }

  // Hero demo: one example chat per language. Messages arrive one at a time, with typing dots
  // before each reply, then the next language starts. Picking a tab stops the cycle.
  const tabs = [...document.querySelectorAll(".lang-tabs [role=tab]")];
  const demo = document.querySelector(".demo");
  const presence = document.querySelector(".wa-head small");
  let run = 0, cycling = !still, paused = false, offscreen = false;

  async function playChat(panel, id) {
    const alive = () => id === run;
    const msgs = [...panel.querySelectorAll(".msg:not(.typing)")];
    panel.querySelectorAll(".typing").forEach((n) => n.remove());
    panel.querySelectorAll(".wave i.on").forEach((b) => b.classList.remove("on"));
    presence.textContent = "online";
    if (still) return msgs.forEach((m) => (m.hidden = false)), true;
    msgs.forEach((m) => { m.hidden = true; m.classList.remove("pop"); });
    await wait(400);
    for (const m of msgs) {
      if (!alive()) return false;
      const voice = m.querySelector(".voice");
      if (m.classList.contains("in")) {
        const typing = Object.assign(document.createElement("div"), { className: "msg in typing", innerHTML: "<i></i><i></i><i></i>" });
        presence.textContent = voice ? "recording audio…" : "typing…";
        panel.append(typing);
        await wait(voice ? 1300 : 900 + Math.min(m.textContent.length * 6, 700));
        typing.remove();
        presence.textContent = "online";
        if (!alive()) return false;
      } else {
        await wait(600);
      }
      m.hidden = false;
      m.classList.add("pop");
      if (voice) await playVoice(voice, 1500, alive);
      await wait(400);
    }
    return alive();
  }

  async function show(i, focus) {
    const id = ++run;
    tabs.forEach((tab, j) => {
      tab.setAttribute("aria-selected", String(i === j));
      tab.tabIndex = i === j ? 0 : -1;
      document.getElementById(tab.getAttribute("aria-controls")).hidden = i !== j;
    });
    if (focus) tabs[i].focus();
    const finished = await playChat(document.getElementById(tabs[i].getAttribute("aria-controls")), id);
    if (!finished || !cycling) return;
    await wait(3500);
    while ((paused || offscreen) && id === run) await wait(400);
    if (id === run && cycling) show((i + 1) % tabs.length);
  }

  if (tabs.length) {
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => { cycling = false; show(i); });
      tab.addEventListener("keydown", (e) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        const current = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
        if (step) { cycling = false; show((current + step + tabs.length) % tabs.length, true); }
      });
    });
    for (const [on, off] of [["pointerenter", "pointerleave"], ["focusin", "focusout"]]) {
      demo.addEventListener(on, () => (paused = true));
      demo.addEventListener(off, () => (paused = false));
    }
    new IntersectionObserver(([e]) => (offscreen = !e.isIntersecting)).observe(demo);
    show(0);
  }

  if (still || !("IntersectionObserver" in window)) return;

  // Scroll reveals: each group fades up with a small stagger between siblings.
  const REVEAL = "section h2, .why-list > li, .pipeline > li, #how .card, .says span, .bento > .tile, .soon-list li, .promises > .card, .start-panel, details";
  const items = [...document.querySelectorAll(REVEAL)];
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      io.unobserve(e.target);
      // Once in, hand the element back to its own hover transitions.
      setTimeout(() => e.target.classList.remove("reveal", "in"), 2000);
    }
  }, { rootMargin: "0px 0px -8% 0px" });
  for (const el of items) {
    const siblings = [...el.parentElement.children].filter((c) => c.matches(REVEAL));
    el.style.setProperty("--i", siblings.indexOf(el));
    el.classList.add("reveal");
    io.observe(el);
  }

  // Summaries tile: flip between today, this week and this month while it's on screen.
  const pills = [...document.querySelectorAll(".pills span")];
  const total = document.querySelector(".period-total");
  let period = 1, periodTimer = 0;
  new IntersectionObserver(([e]) => {
    clearInterval(periodTimer);
    if (!e.isIntersecting) return;
    periodTimer = setInterval(() => {
      period = (period + 1) % pills.length;
      pills.forEach((p, j) => p.classList.toggle("on", j === period));
      total.textContent = pills[period].dataset.v;
    }, 2200);
  }).observe(document.querySelector(".periods"));

  // Privacy: the example phone number scrambles into the kind of code we store instead.
  const hash = document.querySelector(".hash");
  if (hash) {
    const to = hash.textContent;
    hash.textContent = hash.dataset.from;
    new IntersectionObserver(([e], obs) => {
      if (!e.isIntersecting) return;
      obs.disconnect();
      setTimeout(() => {
        const hex = "0123456789abcdef";
        let frame = 0;
        const timer = setInterval(() => {
          frame++;
          hash.textContent = [...to].map((ch, k) => (ch === " " || k < (frame / 22) * to.length ? ch : hex[(Math.random() * 16) | 0])).join("");
          if (frame >= 22) clearInterval(timer);
        }, 50);
      }, 900);
    }, { threshold: 1 }).observe(hash);
  }
})();
