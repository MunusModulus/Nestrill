'use strict';
/* Nestrill UXLab Clean 5a: consolidated motion engine */
(() => {
  if (location.port !== '8767') return;

  const root = document.documentElement;
  const key = 'nestrill-motion-clean-v1';
  const modes = new Set(['scaletop', 'horizontal', 'cover']);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = matchMedia('(max-width: 700px)');

  const defaults = {
    mode: 'scaletop',
    speed: 1.5,
    off: false
  };

  function normalized(data) {
    const value = Number(data?.speed);
    return {
      mode: modes.has(data?.mode) ? data.mode : defaults.mode,
      speed: Number.isFinite(value)
        ? Math.max(1, Math.min(3, Math.round(value * 4) / 4))
        : defaults.speed,
      off: data?.off === true
    };
  }

  let config = { ...defaults };

  try {
    const saved = localStorage.getItem(key);
    if (saved) config = normalized(JSON.parse(saved));
  } catch (error) {
    console.warn('[CleanLab] Invalid saved motion settings.', error);
  }

  const css = document.createElement('style');
  css.id = 'uxclean-motion-style';
  css.textContent = `
    html.uxclean-running {
      view-transition-name: none;
    }
    html.uxclean-running #main > .pane-inner > .feed-toolbar {
      view-transition-name: uxclean-heading;
    }
    html.uxclean-running #main > .pane-inner > #article-list:not(.hidden),
    html.uxclean-running #main > .pane-inner > #source-panel:not(.hidden) {
      view-transition-name: uxclean-content;
    }

    html.uxclean-running::view-transition-group(uxclean-content),
    html.uxclean-running::view-transition-group(uxclean-heading) {
      animation-duration: var(--uxclean-enter, 373ms);
    }

    /* A. Top / Bottom */
    html.uxclean-top.uxclean-running::view-transition-old(uxclean-content) {
      animation: uxclean-down var(--uxclean-enter) ease-in both;
    }
    html.uxclean-top.uxclean-running::view-transition-new(uxclean-content) {
      animation: uxclean-from-top var(--uxclean-enter)
        cubic-bezier(.22,.65,.35,1) both;
      z-index: 2;
    }
    html.uxclean-top.uxclean-running::view-transition-old(uxclean-heading) {
      animation: uxclean-fade-out var(--uxclean-head-out) ease-in both;
    }
    html.uxclean-top.uxclean-running::view-transition-new(uxclean-heading) {
      animation: uxclean-heading-in var(--uxclean-head-in)
        var(--uxclean-head-delay) ease-out both;
    }

    /* B. Horizontal Push; both directions always move left */
    html.uxclean-horizontal.uxclean-running::view-transition-old(uxclean-content),
    html.uxclean-horizontal.uxclean-running::view-transition-old(uxclean-heading) {
      animation: uxclean-left var(--uxclean-enter)
        cubic-bezier(.45,0,.25,1) both;
      z-index: 1;
    }
    html.uxclean-horizontal.uxclean-running::view-transition-new(uxclean-content),
    html.uxclean-horizontal.uxclean-running::view-transition-new(uxclean-heading) {
      animation: uxclean-from-right var(--uxclean-enter)
        cubic-bezier(.45,0,.25,1) both;
      z-index: 2;
    }

    /* C. Cover / Reveal; fast leftward exit, slow settling entry */
    html.uxclean-cover.uxclean-running::view-transition-old(uxclean-content),
    html.uxclean-cover.uxclean-running::view-transition-old(uxclean-heading) {
      animation: uxclean-reveal-out var(--uxclean-cover-out)
        cubic-bezier(.38,.04,.98,.54) both;
      z-index: 2;
    }
    html.uxclean-cover.uxclean-running::view-transition-new(uxclean-content),
    html.uxclean-cover.uxclean-running::view-transition-new(uxclean-heading) {
      animation: uxclean-reveal-in var(--uxclean-enter)
        cubic-bezier(.22,.65,.32,1) both;
      z-index: 1;
    }

    @keyframes uxclean-down {
      from { opacity:1; transform:translate3d(0,0,0); }
      to { opacity:1; transform:translate3d(0,100%,0); }
    }
    @keyframes uxclean-from-top {
      from { opacity:1; transform:translate3d(0,-100%,0); }
      to { opacity:1; transform:translate3d(0,0,0); }
    }
    @keyframes uxclean-left {
      from { opacity:1; transform:translate3d(0,0,0); }
      to { opacity:1; transform:translate3d(-100%,0,0); }
    }
    @keyframes uxclean-from-right {
      from { opacity:1; transform:translate3d(100%,0,0); }
      to { opacity:1; transform:translate3d(0,0,0); }
    }
    @keyframes uxclean-reveal-out {
      from { opacity:1; transform:translate3d(0,0,0); }
      85% { opacity:1; }
      to { opacity:0; transform:translate3d(-105%,0,0); }
    }
    @keyframes uxclean-reveal-in {
      from { opacity:1; transform:translate3d(2.5%,0,0) scale(1.06); }
      to { opacity:1; transform:translate3d(0,0,0) scale(1); }
    }
    @keyframes uxclean-fade-out {
      from { opacity:1; }
      to { opacity:0; }
    }
    @keyframes uxclean-heading-in {
      from { opacity:0; transform:translateY(-22px); }
      to { opacity:1; transform:translateY(0); }
    }

    @media (prefers-reduced-motion: reduce) {
      html.uxclean-running::view-transition-old(*),
      html.uxclean-running::view-transition-new(*) {
        animation-duration: 1ms !important;
        animation-delay: 0ms !important;
      }
    }
  `;
  document.head.append(css);

  function ms(base) {
    return Math.round(base / config.speed) + 'ms';
  }

  function apply() {
    for (const mode of modes) {
      root.classList.toggle('uxclean-' +
        (mode === 'scaletop' ? 'top' : mode),
        config.mode === mode);
    }

    root.style.setProperty('--uxclean-enter', ms(560));
    root.style.setProperty('--uxclean-head-out', ms(140));
    root.style.setProperty('--uxclean-head-in', ms(240));
    root.style.setProperty('--uxclean-head-delay', ms(70));
    root.style.setProperty('--uxclean-cover-out', ms(560 * .48));
  }

  apply();

  let active = null;
  let serial = 0;

  function cleanup() {
    root.classList.remove('uxclean-running');
  }

  function cancel() {
    ++serial;
    if (active) {
      try { active.skipTransition(); } catch (_) {}
      active = null;
    }
    cleanup();
  }

  function shouldAnimate() {
    return !config.off &&
      !reduced.matches &&
      !mobile.matches &&
      !document.hidden &&
      typeof document.startViewTransition === 'function';
  }

  // Preserve the navigation key semantics used in Phase 2c.
  function navigationKey() {
    if (state.aiKind) return 'ai|' + state.aiKind;
    if (state.sourceKind) {
      return [
        'source', state.sourceKind,
        state.sourceAccountId, state.sourceChannelId
      ].join('|');
    }
    return [
      'rss', state.group, state.category,
      state.feed, state.filter
    ].join('|');
  }

  for (const name of [
    'selectGroup', 'selectSource', 'selectYoutubeChannel', 'selectAiKind'
  ]) {
    const original = window[name];

    if (typeof original !== 'function') {
      throw new Error('[CleanLab] Navigation hook missing: ' + name);
    }

    window[name] = function (...args) {
      if (!shouldAnimate()) {
        cancel();
        return original.apply(this, args);
      }

      const before = navigationKey();
      cancel();
      const ticket = serial;
      root.classList.add('uxclean-running');

      const context = this;
      let transition;

      try {
        transition = document.startViewTransition(() => {
          if (ticket !== serial) return;
          return original.apply(context, args);
        });
      } catch (error) {
        console.warn('[CleanLab] View Transition fallback.', error);
        cleanup();
        return original.apply(context, args);
      }

      active = transition;

      transition.ready.then(() => {
        if (ticket !== serial) return;
        if (before === navigationKey()) {
          transition.skipTransition();
        }
      }).catch(() => {});

      transition.finished.finally(() => {
        if (ticket !== serial) return;
        active = null;
        cleanup();
      }).catch(() => {});

      transition.updateCallbackDone.catch(error => {
        console.error('[CleanLab] Navigation update failed.', error);
      });

      // The AI sidebar click awaits a Promise; preserve its existing .catch handler.
      return name === 'selectAiKind' ? transition.updateCallbackDone : undefined;
    };
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancel();
  });

  reduced.addEventListener('change', () => {
    if (reduced.matches) cancel();
  });

  mobile.addEventListener('change', () => {
    if (mobile.matches) cancel();
  });

  // Native Nestrill settings tab (not a MutationObserver injection).
  window.__uxCleanRenderSettings = function (panel) {
    const heading = document.createElement('h3');
    heading.textContent = '画面切り替え';
    panel.append(heading);

    const form = document.createElement('div');
    form.className = 'settings-grid';

    function field(labelText, control) {
      const item = document.createElement('div');
      item.className = 'form-field';
      const label = document.createElement('label');
      label.textContent = labelText;
      label.htmlFor = control.id;
      item.append(label, control);
      return item;
    }

    const select = document.createElement('select');
    select.id = 'uxclean-setting-mode';
    for (const [id, label] of [
      ['scaletop', 'Top / Bottom（上下）'],
      ['horizontal', 'Horizontal Push（横方向）'],
      ['cover', 'Cover / Reveal（重なり）']
    ]) {
      select.add(new Option(label, id));
    }
    select.value = config.mode;

    const speed = document.createElement('input');
    speed.id = 'uxclean-setting-speed';
    speed.type = 'range';
    speed.min = '1';
    speed.max = '3';
    speed.step = '.25';
    speed.value = String(config.speed);

    const speedOutput = document.createElement('output');
    speedOutput.style.marginLeft = '12px';

    const speedRow = document.createElement('div');
    speedRow.className = 'range-line';
    speedRow.append(speed, speedOutput);

    const speedItem = document.createElement('div');
    speedItem.className = 'form-field';

    const speedLabel = document.createElement('label');
    speedLabel.htmlFor = speed.id;
    speedLabel.textContent = 'アニメーション速度';

    speedItem.append(speedLabel, speedRow);

    form.append(field('演出方式', select), speedItem);
    panel.append(form);

    const offLabel = document.createElement('label');
    offLabel.className = 'checkbox-label';

    const off = document.createElement('input');
    off.type = 'checkbox';
    off.checked = config.off;

    const offText = document.createElement('span');
    offText.textContent = '画面切り替えアニメーションを無効にする';
    offLabel.append(off, offText);

    const note = document.createElement('p');
    note.className = 'help';
    note.textContent =
      '標準速度は1.50×。設定はこのブラウザに保存されます。';

    panel.append(offLabel, note);

    function sync() {
      speedOutput.textContent =
        Number(speed.value).toFixed(2) + '×';
      select.disabled = off.checked;
      speed.disabled = off.checked;
    }

    speed.addEventListener('input', sync);
    off.addEventListener('change', sync);
    sync();

    const buttons = document.createElement('div');
    buttons.className = 'form-actions';

    buttons.append(
      action('キャンセル', closeDialog, false),
      action('設定を保存', () => {
        config = normalized({
          mode: select.value,
          speed: speed.value,
          off: off.checked
        });

        cancel();
        apply();

        try {
          localStorage.setItem(key, JSON.stringify(config));
        } catch (error) {
          console.warn('[CleanLab] Settings not persisted.', error);
        }

        closeDialog();
      })
    );

    panel.append(buttons);
  };

  window.__uxCleanMotion = Object.freeze({
    version: '5a',
    get config() { return { ...config }; },
    get active() { return !!active; },
    get reducedMotion() { return reduced.matches; }
  });

  console.info('[CleanLab] Consolidated motion engine ready.', config);
})();