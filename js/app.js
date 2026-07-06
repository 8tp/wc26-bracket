/* app.js — bootstrap, view switching, header + polling wiring (UI agent).
 * Consumes window.WC (data layer) and window.WCBracket / window.WCGroups.
 */
(function () {
  'use strict';

  var els = {};
  var state = { tournament: null, view: 'bracket', hasData: false };
  var poller = null;
  var spinnerTimer = null;

  function $(id) { return document.getElementById(id); }

  function cache() {
    els.phase = $('phase-label');
    els.liveBadge = $('live-badge');
    els.liveCount = $('live-count');
    els.updated = $('updated-stamp');
    els.spinner = $('refresh-spinner');
    els.bracketView = $('bracket-view');
    els.groupsView = $('groups-view');
    els.skeleton = $('loading-skeleton');
    els.error = $('error-banner');
    els.footerUpdated = $('footer-updated');
    els.footerSource = $('footer-source');
    els.tabs = document.querySelectorAll('.tab-btn');
  }

  /* --------------------------------------------------------- view switching */
  function setView(view) {
    state.view = view;
    for (var i = 0; i < els.tabs.length; i++) {
      var t = els.tabs[i];
      var on = t.getAttribute('data-view') === view;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (els.bracketView) els.bracketView.hidden = view !== 'bracket';
    if (els.groupsView) els.groupsView.hidden = view !== 'groups';
  }

  function wireTabs() {
    for (var i = 0; i < els.tabs.length; i++) {
      els.tabs[i].addEventListener('click', function (e) {
        setView(e.currentTarget.getAttribute('data-view'));
      });
    }
  }

  /* -------------------------------------------------------------- rendering */
  function render() {
    var t = state.tournament;
    if (!t) return;
    try {
      if (window.WCBracket && els.bracketView) window.WCBracket.render(els.bracketView, t);
    } catch (e) { /* keep prior bracket render on failure */ }
    try {
      if (window.WCGroups && els.groupsView) window.WCGroups.render(els.groupsView, t);
    } catch (e2) { /* keep prior groups render on failure */ }
    updateHeader(t);
  }

  function updateHeader(t) {
    if (els.phase) els.phase.textContent = t.currentPhase || 'World Cup 2026';

    var live = Number(t.liveCount) || 0;
    if (els.liveBadge) els.liveBadge.hidden = live <= 0;
    if (els.liveCount) els.liveCount.textContent = live;

    var stamp = fmtStamp(t.updatedAt);
    if (els.updated) els.updated.textContent = stamp ? 'Updated ' + stamp : '';
    if (els.footerUpdated) els.footerUpdated.textContent = stamp ? 'Updated ' + stamp : '—';
    if (els.footerSource) els.footerSource.textContent = sourceLabel(t.source);

    syncHeaderHeight(); // badge/phase text can change the header's height
  }

  function fmtStamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return d.toISOString().slice(11, 16);
    }
  }

  function sourceLabel(src) {
    if (src === 'live') return 'Live from ESPN';
    if (src === 'snapshot') return 'Cached snapshot';
    if (src === 'cache') return 'Offline cache';
    return '—';
  }

  /* ------------------------------------------------------------ chrome state */
  function showSkeleton(show) {
    if (els.skeleton) els.skeleton.hidden = !show;
    if (els.bracketView) els.bracketView.classList.toggle('is-hidden', show);
    if (els.groupsView && show) els.groupsView.classList.add('is-hidden');
    else if (els.groupsView) els.groupsView.classList.remove('is-hidden');
  }

  function flashSpinner() {
    if (!els.spinner) return;
    els.spinner.hidden = false;
    if (spinnerTimer) clearTimeout(spinnerTimer);
    spinnerTimer = setTimeout(function () { els.spinner.hidden = true; }, 700);
  }

  function showError(msg) {
    if (!els.error) return;
    els.error.hidden = false;
    els.error.innerHTML = '<span class="banner-icon" aria-hidden="true">⚠</span>' +
      '<span>' + (window.WCUI ? window.WCUI.esc(msg) : msg) + '</span>';
  }
  function clearError() {
    if (els.error) els.error.hidden = true;
  }

  /* ---------------------------------------------------------------- polling */
  function onUpdate(t) {
    if (!t) return;
    state.tournament = t;
    state.hasData = true;
    showSkeleton(false);
    if (t.source === 'live') clearError();
    else showCachedNote(t.source);
    render();
    flashSpinner();
  }

  function showCachedNote(src) {
    if (src === 'live') { clearError(); return; }
    showError('Live update unavailable — showing ' +
      (src === 'snapshot' ? 'the latest cached snapshot.' : 'offline cached data.'));
  }

  function onError(err) {
    if (els.spinner) els.spinner.hidden = true;
    if (state.hasData) {
      showError('Live update failed — showing cached data. Retrying automatically…');
    } else {
      showSkeleton(false);
      showError('Could not load tournament data. Retrying automatically…');
    }
  }

  // Measure the sticky header so the mobile round selector can stick right
  // below it (its height varies with live/status content). Sets --hdr-h.
  function syncHeaderHeight() {
    var h = document.getElementById('app-header');
    if (!h) return;
    document.documentElement.style.setProperty('--hdr-h', h.offsetHeight + 'px');
  }

  function boot() {
    cache();
    wireTabs();
    setView('bracket');
    showSkeleton(true);
    syncHeaderHeight();
    window.addEventListener('resize', syncHeaderHeight);

    if (!window.WC || typeof window.WC.startPolling !== 'function') {
      showSkeleton(false);
      showError('Data layer failed to load.');
      return;
    }
    try {
      poller = window.WC.startPolling(onUpdate, onError);
    } catch (e) {
      // Fallback to a single load if polling wiring throws.
      if (window.WC.loadTournament) {
        window.WC.loadTournament().then(onUpdate).catch(onError);
      } else {
        showSkeleton(false);
        showError('Could not start live updates.');
      }
    }
  }

  window.addEventListener('beforeunload', function () {
    if (poller && typeof poller.stop === 'function') poller.stop();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
