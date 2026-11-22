/* Guided tour of Commit Doctor: one tour that walks page by page
   (Dashboard → Repositories → Commits → Notifications → Analytics → Settings),
   pointing at the real parts of each page. Offered once on the first visit in a
   browser; replayable from "Tutorial" in the sidebar. Not loaded on the study page.

   Steps point at elements by their data-tour hook. When a part isn't on screen
   (for example before a repository is connected) the step is shown in the middle
   of the page with a short note instead. Progress lives in localStorage, so the
   tour survives the page changes it makes and can be resumed after closing. */
(function () {
  'use strict';
  const { $, esc, ic, store } = CD;
  const KEY = 'comdoc.tour';           // { i, active } while a tour is running or paused
  const OFFERED = 'comdoc.tourOffered'; // the first-visit offer was answered
  const PAGE_URL = { dashboard: 'index.html', repository: 'repository.html', commits: 'commit.html', notifications: 'notifications.html', analytics: 'analytics.html', settings: 'settings.html' };
  const n = () => (CD.ctx ? CD.ctx.overview.rules.comparison_days : 7);
  const multi = () => CD.ctx && CD.ctx.overview.repo_mode === 'multi';
  const NEEDS_REPO = 'This part appears once a repository is connected (Settings › Connect repository).';

  const STEPS = [
    { page: 'dashboard', title: 'Welcome to Commit Doctor',
      text: () => 'Commit Doctor follows a GitHub repository and turns each day\'s commits into a short summary, so the team can see what happened without digging through the commit history. This tour shows where everything is. It takes about two minutes, and you can leave at any time.' },
    { page: 'dashboard', target: 'repo', title: 'The repository you\'re viewing',
      text: () => (multi()
        ? 'Every page shows one repository at a time. You follow several, so switch between them here.'
        : 'Every page shows this repository. To follow more than one, choose "Multiple repositories" in Settings; then you can switch between them here.') },
    { page: 'dashboard', target: 'status', title: 'Where commits come from',
      text: () => 'This tells you how Commit Doctor gets new commits (instantly by webhook, or by checking GitHub every few minutes) and when it last heard from GitHub. "Check now" pulls in new commits straight away.' },
    { page: 'dashboard', target: 'daynav', title: 'Pick a day',
      text: () => 'Everything on the dashboard is about one day. Use the arrows or the calendar to look at an earlier day. Today stays live and updates as commits arrive.' },
    { page: 'dashboard', target: 'stats', title: 'The day at a glance',
      text: () => `Commits compared with the usual amount (the average of the previous ${n()} days), how much code changed, who was active, and how far the deadline is. Press any "?" for a plain explanation of a term.` },
    { page: 'dashboard', target: 'summary', title: 'The daily summary',
      text: () => 'A short note about the day, written by fixed rules rather than AI, so the same commits always give the same summary. The coloured tags show what kind of work it was. Each day is saved after midnight; "Copy" puts the text on your clipboard for a chat or stand-up.' },
    { page: 'dashboard', target: 'views', title: 'Three ways to read a day',
      text: () => 'Digest lists the key points and flags. Team shows who worked on what. Timeline shows when it happened. Use whichever is quickest for you, and the 👍 / 👎 under it to say if it helped.' },
    { page: 'dashboard', target: 'trend', title: 'Commits per day',
      text: () => 'The last 7, 14 or 30 days at a glance. Select a bar to open that day. A green dot under a day means its summary has been saved.' },
    { page: 'dashboard', target: 'notable', title: 'Notable changes',
      text: () => `Flags point out what stood out: a day well above or below the usual amount, someone with no commits for ${n()} days or more, or a deadline pace that is slipping. They're there to help the team coordinate, not to judge anyone.` },
    { page: 'dashboard', target: 'files', title: 'File changes',
      text: () => 'How many files were added, changed or removed. It\'s hidden by default; "Show file details" opens it, and this browser remembers your choice. Commit Doctor never stores file names or code.' },
    { page: 'repository', target: 'repo-tabs', title: 'Repositories',
      text: () => 'The repository in more detail: recent commits grouped by day, every saved daily summary, and each contributor\'s latest activity. The charts beside it show the last two weeks.' },
    { page: 'commits', target: 'commit-list', title: 'Commits',
      text: () => 'Every commit of the chosen day. Type in the filter to find one by message, author, ID or kind of work. Open a commit to see its full message, what kind of work it was, and the same person\'s commits around it.' },
    { page: 'notifications', target: 'notif', title: 'Notifications',
      text: () => '"Important updates" lists every flag; filter them, or mark them as read once you\'ve seen them (remembered in this browser). The daily and weekly digests sum up the days and the week.' },
    { page: 'analytics', target: 'analytics', title: 'Analytics',
      text: () => 'Trends over the last 30, 60 or 90 days (choose at the top): activity against the usual amount, the kind of work each week, pace against the deadline, code churn, and each person\'s activity. Hover a chart for details, or open "Show as table" under it.' },
    { page: 'settings', target: 'settings-repos', title: 'Connecting repositories',
      text: () => 'Connect a repository here. A public one needs no token; a private one needs a read-only GitHub token, and the steps are shown as you go. Follow one repository or several. When you follow one, the others are hidden, not deleted: "Switch back" brings them back.' },
    { page: 'settings', target: 'deadline', title: 'Deadline',
      text: () => 'Each repository can have a deadline. Commit Doctor compares the last week\'s pace with the earlier pace to say whether you\'re on pace, at risk or behind, and sends reminders as it gets close.' },
    { page: 'settings', target: 'alerts', title: 'Email alerts',
      text: () => 'People listed here get flags and deadline reminders by email for this repository. Each repository has its own list.' },
    { page: 'settings', target: 'admin', title: 'Who can change things',
      text: () => 'Reading is open to everyone. Changes (connecting repositories, deadlines, email alerts, saving summaries) need the server\'s admin token. You\'re asked for it when needed, and it\'s only kept for this browser tab.' },
    { page: 'settings', target: 'tutorial-nav', title: 'That\'s the tour',
      text: () => 'You can replay it any time from Tutorial here. Look for the "?" next to a term whenever something isn\'t clear.' },
  ];

  /* ---------- state ---------- */
  const load = () => { try { return JSON.parse(store.get(KEY) || 'null'); } catch { return null; } };
  const save = (st) => store.set(KEY, JSON.stringify(st));
  const clear = () => { try { window.localStorage.removeItem(KEY); } catch { /* storage unavailable */ } };

  /* ---------- drawing ---------- */
  let ui = null;
  let index = 0;
  let timer = null;
  let lastFocus = null;

  function build() {
    const shade = document.createElement('div');
    shade.className = 'tour-shade';
    const spot = document.createElement('div');
    spot.className = 'tour-spot';
    const pop = document.createElement('div');
    pop.className = 'tour-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-labelledby', 'tour-title');
    pop.setAttribute('aria-describedby', 'tour-text');
    document.body.append(shade, spot, pop);
    pop.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'next') go(index + 1);
      if (b.dataset.act === 'back') go(index - 1);
      if (b.dataset.act === 'close') pause();
      if (b.dataset.act === 'skip') end();
      if (b.dataset.act === 'resume') go(Number(b.dataset.at));
      if (b.dataset.act === 'restart') go(0);
    });
    // Keep keyboard focus inside the tour while it's open.
    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const items = [...pop.querySelectorAll('button:not(:disabled)')];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    return { shade, spot, pop };
  }

  function open() {
    if (!ui) ui = build();
    if (!lastFocus) lastFocus = document.activeElement;
    document.documentElement.classList.add('touring');
    clearInterval(timer);
    timer = setInterval(place, 400); // pages re-render (e.g. the dashboard every 30 s); follow the target
  }

  function close() {
    clearInterval(timer);
    if (ui) { ui.shade.remove(); ui.spot.remove(); ui.pop.remove(); ui = null; }
    document.documentElement.classList.remove('touring');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  const targetOf = (step) => (step && step.target ? document.querySelector(`[data-tour="${step.target}"]`) : null);
  const visible = (el) => el && el.getClientRects().length > 0;

  function place() {
    if (!ui) return;
    const step = STEPS[index];
    const el = targetOf(step);
    const phone = window.innerWidth <= 640;
    const pop = ui.pop;
    if (!visible(el)) {
      ui.spot.hidden = true;
      ui.shade.classList.add('dim');
      pop.classList.add('center');
      pop.style.left = ''; pop.style.top = '';
      return;
    }
    ui.shade.classList.remove('dim');
    pop.classList.remove('center');
    const r = el.getBoundingClientRect();
    const pad = 6;
    Object.assign(ui.spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    ui.spot.hidden = false;
    if (phone) { pop.style.left = ''; pop.style.top = ''; return; } // docked at the bottom by CSS
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const gap = 14;
    const clampTop = (t) => Math.min(Math.max(72, t), window.innerHeight - h - 16);
    let top;
    let left;
    if (r.bottom + gap + h <= window.innerHeight - 8) top = r.bottom + gap;
    else if (r.top - gap - h >= 72) top = r.top - gap - h;
    if (top != null) {
      left = r.width < w ? r.left + r.width / 2 - w / 2 : r.left;
    } else if (r.right + gap + w <= window.innerWidth - 8) {
      // Tall target with room beside it: sit next to it.
      left = r.right + gap; top = clampTop(r.top);
    } else if (r.left - gap - w >= 8) {
      left = r.left - gap - w; top = clampTop(r.top);
    } else {
      // Full-width and taller than the screen: bottom-right, below the target's heading.
      left = window.innerWidth - w - 24; top = window.innerHeight - h - 16;
    }
    left = Math.min(Math.max(16, left), window.innerWidth - w - 16);
    pop.style.left = `${left}px`;
    pop.style.top = `${clampTop(top)}px`;
  }

  /** Bring the target into view, leaving room for the card (below it, or docked at the bottom on phones). */
  function scrollTo(el) {
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    const topbar = 84;
    const popH = ui ? ui.pop.offsetHeight + 14 : 300;
    const phone = window.innerWidth <= 640;
    const room = window.innerHeight - topbar - (phone ? popH + 72 : 0);
    let y;
    if (phone) y = r.top + window.scrollY - topbar - Math.max(0, (room - r.height) / 2);
    else if (r.height + popH <= window.innerHeight - topbar - 16 && r.height < (window.innerHeight - topbar) * 0.45) y = r.top + window.scrollY - (window.innerHeight - r.height - popH) / 2;
    else y = r.top + window.scrollY - topbar;
    window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
  }

  function render() {
    const step = STEPS[index];
    const el = targetOf(step);
    const missing = step.target && !visible(el);
    const last = index === STEPS.length - 1;
    ui.pop.innerHTML = `<div class="tour-head"><span class="tour-count">Step ${index + 1} of ${STEPS.length}</span>
        <button type="button" class="tour-x" data-act="close" aria-label="Close the tour (you can resume it from Tutorial)">×</button></div>
      <h2 id="tour-title">${esc(step.title)}</h2>
      <p id="tour-text">${esc(step.text())}</p>
      ${missing ? `<p class="tour-note">${esc(step.target === 'files' || step.target === 'repo-tabs' || step.target === 'status' ? NEEDS_REPO : 'This part isn\'t on the page right now; it appears once there is something to show.')}</p>` : ''}
      <div class="tour-progress" aria-hidden="true"><i style="width:${((index + 1) / STEPS.length) * 100}%"></i></div>
      <div class="tour-actions">${last ? '' : '<button type="button" class="text-btn" data-act="skip">Skip tour</button>'}<span class="spacer"></span>
        <button type="button" class="btn" data-act="back"${index === 0 ? ' disabled' : ''}>Back</button>
        <button type="button" class="btn btn-primary" data-act="next">${last ? 'Finish' : index === 0 ? 'Start' : 'Next'}</button></div>`;
    scrollTo(el);
    place();
    $('[data-act="next"]', ui.pop).focus();
  }

  /** Show step i, opening its page first if needed. */
  function go(i) {
    if (i < 0) return;
    if (i >= STEPS.length) { end(); return; }
    index = i;
    save({ i, active: true });
    store.set(OFFERED, '1');
    const step = STEPS[i];
    if (step.page !== CD.page) {
      window.location.href = PAGE_URL[step.page];
      return;
    }
    open();
    render();
  }

  /** Close but remember the step, so Tutorial can resume it. */
  function pause() {
    save({ i: index, active: false });
    close();
    CD.toast('Tour paused. Resume it any time from Tutorial in the sidebar.');
  }

  function end() {
    clear();
    store.set(OFFERED, '1');
    close();
  }

  /** Tutorial button: start, or offer to resume a paused tour. */
  function startFromMenu() {
    const st = load();
    if (!st || !st.i) { go(0); return; }
    index = st.i;
    open();
    ui.spot.hidden = true;
    ui.shade.classList.add('dim');
    ui.pop.classList.add('center');
    ui.pop.innerHTML = `<div class="tour-head"><span class="tour-count">Tutorial</span><button type="button" class="tour-x" data-act="skip" aria-label="Close">×</button></div>
      <h2 id="tour-title">Pick up where you left off?</h2>
      <p id="tour-text">You stopped at step ${st.i + 1} of ${STEPS.length}: "${esc(STEPS[st.i].title)}".</p>
      <div class="tour-actions"><span class="spacer"></span><button type="button" class="btn" data-act="restart">Start over</button>
        <button type="button" class="btn btn-primary" data-act="resume" data-at="${st.i}">Resume</button></div>`;
    $('[data-act="resume"]', ui.pop).focus();
  }

  /* ---------- first visit: a small, non-blocking offer ---------- */
  function offer() {
    const card = document.createElement('div');
    card.className = 'tour-offer';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-labelledby', 'tour-offer-h');
    card.innerHTML = `<span class="tour-offer-icon">${ic('guide', 18)}</span><div><b id="tour-offer-h">New to Commit Doctor?</b>
      <p>A two-minute tour shows where everything is and how to read it.</p>
      <div class="tour-actions"><button type="button" class="btn btn-primary" data-offer="yes">Take the tour</button><button type="button" class="btn" data-offer="no">Not now</button></div>
      <p class="note">You can always find it under Tutorial in the sidebar.</p></div>`;
    document.body.append(card);
    card.addEventListener('click', (e) => {
      const b = e.target.closest('[data-offer]');
      if (!b) return;
      store.set(OFFERED, '1');
      card.remove();
      if (b.dataset.offer === 'yes') go(0);
    });
  }

  /* ---------- wiring ---------- */
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tour-start]');
    if (!b) return;
    e.preventDefault();
    const o = $('.tour-offer');
    if (o) o.remove();
    store.set(OFFERED, '1');
    startFromMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (!ui || !document.documentElement.classList.contains('touring')) return;
    if (e.key === 'Escape') { e.preventDefault(); pause(); }
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowRight' && ui.pop.querySelector('[data-act="next"]')) go(index + 1);
    if (e.key === 'ArrowLeft' && ui.pop.querySelector('[data-act="back"]:not(:disabled)')) go(index - 1);
  });
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, { passive: true });

  document.addEventListener('comdoc:ready', () => {
    const st = load();
    if (st && st.active) {
      const step = STEPS[st.i];
      if (step && step.page === CD.page) { index = st.i; open(); render(); return; }
      // The tour was running but someone navigated elsewhere: treat it as paused.
      save({ i: st.i, active: false });
      return;
    }
    if (store.get(OFFERED) !== '1' && !st) setTimeout(offer, 600);
  });
})();
