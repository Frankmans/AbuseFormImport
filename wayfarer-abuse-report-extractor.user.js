// ==UserScript==
// @name         Wayfarer Map Mods - Abuse Reports
// @namespace    https://github.com/Frankmans/AbuseFormImport
// @version      2.1.0
// @description  Scans emails already imported by Wayfarer Abuse Email Importer for Niantic Support "Reporting Abuse" tickets, extracts every reported Wayspot's name + coordinates (a ticket can report several, across the original submission and later replies), stores them locally, plots them on the Wayfarer map and the review page's duplicate-check map, and exports as CSV. Can also auto-fill the Help Center abuse form from the Marked Wayspots list, and send a review's photo to Sightengine's AI-image check.
// @author       Frankmans
// @grant        none
// @match        https://wayfarer.scopely.com/*
// @match        https://scopelyexplore.helpshift.com/hc/*
// @match        https://sightengine.com/detect-ai-generated-images*
// @require      https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/opr-email-lib.js
// @require      https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wst-storage.js
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-report-extractor.user.js
// @downloadURL  https://raw.githubusercontent.com/Frankmans/AbuseFormImport/refs/heads/main/wayfarer-abuse-report-extractor.user.js
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Abuse form auto-fill (v1.70.0) -- the Marked Wayspots list (the abuse
  // report draft) can open Niantic's "Reporting Abuse in Wayfarer" Help
  // Center page and fill the form's location field for you, the same way
  // Wayfarer Map Mods' Report History fills the Pokestop/Gym report form
  // (src/helpshift/web-reports in that script): the Wayfarer tab opens the
  // Help Center tab with a session id in the URL hash, the Help Center tab
  // asks its opener for the data with postMessage, and fills the form when
  // the answer arrives. Both halves live in this one file: the part
  // below runs on the Help Center page (this script now also @matches it)
  // and returns before anything else in the file is touched; the
  // Wayfarer-side half (waeOpenAbuseFormAutofill() and friends) sits next
  // to waeCopyToClipboard(), further down.
  //
  // Differences from Map Mods' version, on purpose:
  //  - Fields are found by their LABEL TEXT ("Provide details of the
  //    location(s)", the exact label the form's own emails carry, see
  //    opr-email-lib.js parseAbuseReportThread()), not by Helpshift's
  //    generated slot ids. Those ids differ per form and Map Mods
  //    hardcodes the Pokestop form's; the abuse form's weren't available
  //    here, and a label survives Helpshift regenerating the ids.
  //  - The Help Center URL is the article that WAE_ABUSE_FORM_URL already
  //    points at, not a contact-us page: the form is reached by its
  //    "Report an abuse" button at the bottom of that article, so the
  //    Help Center side clicks it when it sees it (up to
  //    WAE_AF_TRIGGER_MAX_CLICKS times) and waits for the form to show.
  //  - The form has steps (article -> name/email -> the report fields):
  //    the Help Center side keeps polling, fills each field when its step
  //    shows up, and never needs the steps in a fixed order. Name and
  //    email come from the settings cog's "Abuse form auto-fill" section.
  //  - Only fields that are still empty are filled, and nothing is ever
  //    submitted -- the issue type, the report details and the Submit
  //    button stay yours.
  // ---------------------------------------------------------------------
  const WAE_HS_ORIGIN = 'https://scopelyexplore.helpshift.com';
  const WAE_WAYFARER_ORIGIN = 'https://wayfarer.scopely.com';
  const WAE_AF_PROTOCOL = 1;
  const WAE_AF_MSG_REQUEST = 'wae-abuse-form:request-data';
  const WAE_AF_MSG_DATA = 'wae-abuse-form:report-data';
  const WAE_AF_MSG_SUBMITTED = 'wae-abuse-form:submitted';
  // v1.81.0 (setting "After submitting", off by default): the Help Center
  // tab watches for the click on Submit and, once the form is really gone
  // (a rejected click -- a required field missing -- leaves it standing),
  // tells the Wayfarer tab, closes itself WAE_AF_CLOSE_DELAY_MS later, and
  // the Wayfarer tab asks whether to clear the draft list.
  const WAE_AF_CLOSE_DELAY_MS = 1500;
  const WAE_AF_SUBMIT_POLL_MS = 300;
  const WAE_AF_SUBMIT_VERIFY_MS = 20000;  // how long after a Submit click the outcome is watched
  const WAE_AF_SUBMIT_GONE_POLLS = 2;     // the form must stay gone this many polls in a row
  const WAE_AF_SUBMIT_LABELS = ['Submit', 'Submit request', 'Submit report', 'Send'];
  // What the page says once the report is in: the first phrase is the Help
  // Center's own confirmation ("You will receive a response via email at
  // ..."). Deliberately specific -- a generic "thank you" also sits in the
  // page's "We're evolving to Scopely Explore" banner.
  const WAE_AF_CONFIRMATION_RE = /you will receive a response via email|has been (?:submitted|created|received)|(?:we(?:'|\u2019)ve|we have) received your/i;
  const WAE_AF_HASH_SESSION = 'waeAbuseSession';
  const WAE_AF_HASH_ORIGIN = 'waeAbuseOrigin';
  // Kept in sessionStorage as well as the URL hash: if the Help Center
  // does a real page load between the article and the form, the hash is
  // gone but this tab's sessionStorage survives.
  const WAE_AF_SESSION_KEY = 'wae-abuse-form-session';
  const WAE_AF_SESSION_TTL_MS = 15 * 60 * 1000;
  const WAE_AF_LOCATION_LABEL = 'Provide details of the location(s)';
  // The report step's fields. Their labels can't be read from outside the
  // components, so each is also matched by its placeholder: the location
  // field's placeholder starts with "Name of the wayspot 1" (matched on
  // that start, the rest being an example).
  const WAE_AF_LOCATION_LABELS = [WAE_AF_LOCATION_LABEL, 'Name of the wayspot 1'];
  const WAE_AF_REPORT_DETAILS_LABELS = ['Abuse report details', 'Details related with your abuse report'];
  const WAE_AF_ABUSER_LABELS = ['Provide details of the abuser(s)', '"CodeNameAlias" of the abuser (if known)'];
  const WAE_AF_ISSUE_LABEL = 'What issue are you reporting?';
  // Name / email fields of the form's first step. Matched on the WHOLE
  // label only (never "contains" -- "name" would also hit a Wayspot name).
  // (The form's inputs carry the placeholders "Enter your name" and
  // "name@example.com"; their labels can't be read from outside the
  // component, so the placeholders are matched as well.)
  const WAE_AF_NAME_LABELS = ['Name', 'Your Name', 'Full Name', 'Your Full Name', 'Enter your name'];
  const WAE_AF_EMAIL_LABELS = ['Email', 'Your Email', 'E-mail', 'Email Address', 'Your Email Address', 'name@example.com'];
  // Labels of the form's other fields: a container whose text mentions
  // one of these is never accepted as the label of the location field.
  const WAE_AF_OTHER_LABELS = ['Abuse report details', 'What issue are you reporting?', 'Provide details of the abuser(s)'];
  const WAE_AF_POLL_MS = 200;   // form-filling loop
  const WAE_AF_POLL_MAX = 1500; // 5 min -- covers a person clicking through a multi-step form
  const WAE_AF_TRIGGER_MAX_CLICKS = 3;
  const WAE_AF_TRIGGER_RETRY_MS = 1500;
  // First-page navigator (finds and clicks "Report an abuse"): polls fast,
  // and keeps its limits in milliseconds rather than poll counts.
  const WAE_AF_NAV_POLL_MS = 100;
  const WAE_AF_NAV_MAX_MS = 5 * 60 * 1000;
  const WAE_AF_NAV_SCROLL_MS = 2000;       // while the button is missing, scroll down this often
  const WAE_AF_NAV_NOT_FOUND_MS = 10000;   // no button after this long -> say so
  const WAE_AF_INLINE_LINK_AFTER_MS = 6000; // the article's inline link is only used as a last resort, after this long
  const WAE_AF_SUBMIT_VIEWPORT_FRACTION = 0.9; // Submit ends up this far down the window, from the top
  const WAE_AF_DATA_TIMEOUT_MS = 10000;   // no answer from the Wayfarer tab by then -> say so
  const WAE_AF_NOT_FOUND_POLLS = 50;      // form loop: 10s without the name/email fields -> say so
  const WAE_AF_FIELD_SELECTOR = 'textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="file"])';

  function waeAfNorm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  // Every element matching `selector`, in the document and inside every
  // open shadow root -- Helpshift's form is made of web components, same
  // reason Map Mods' querySelectorDeep() walks shadow roots.
  function waeAfDeepAll(selector) {
    const found = [];
    const queue = [document];
    const seen = new Set();
    while (queue.length) {
      const root = queue.shift();
      if (!root || seen.has(root)) continue;
      seen.add(root);
      root.querySelectorAll?.(selector).forEach((n) => found.push(n));
      root.querySelectorAll?.('*').forEach((el) => { if (el.shadowRoot) queue.push(el.shadowRoot); });
    }
    return found;
  }

  // Every piece of text that could be this control's label, however the
  // component happens to attach it: an aria-label/placeholder, a <label>,
  // or -- for an input slotted into a component, which is how Map Mods'
  // input[slot="..."] lookups imply this form is built -- the text next
  // to the <slot> it's assigned to in that component's shadow tree.
  function waeAfLabelCandidates(el) {
    const out = [];
    const add = (v) => {
      const t = String(v || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 400) out.push(t);
    };
    const isShadowRoot = (n) => typeof ShadowRoot !== 'undefined' && n instanceof ShadowRoot;
    add(el.getAttribute('aria-label'));
    add(el.getAttribute('placeholder'));
    add(el.getAttribute('autocomplete'));
    if ((el.getAttribute('type') || '').toLowerCase() === 'email') add('Email');
    const root = el.getRootNode();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy && root.getElementById) {
      for (const id of labelledBy.split(/\s+/)) add(root.getElementById(id)?.textContent);
    }
    if (el.id && root.querySelector) {
      try { add(root.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent); } catch (e) { /* odd id -- skip */ }
    }
    add(el.closest('label')?.textContent);
    const slotEl = el.assignedSlot;
    if (slotEl) {
      // Nearest ancestor inside the component's shadow tree that has any
      // text of its own (slotted light-DOM nodes aren't part of that
      // text) -- nearest only, so a container that wraps several fields
      // never ends up labelling all of them.
      let n = slotEl.parentNode;
      for (let i = 0; i < 6 && n && !isShadowRoot(n); i++, n = n.parentNode) {
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) { add(t); break; }
      }
      const host = slotEl.getRootNode()?.host;
      add(host?.getAttribute?.('label'));
      add(host?.getAttribute?.('aria-label'));
    }
    if (isShadowRoot(root)) {
      add(root.host.getAttribute('label'));
      add(root.host.getAttribute('aria-label'));
    }
    add(el.previousElementSibling?.textContent);
    return out;
  }

  // Best field for one of `labels`: an exact label match beats one that
  // merely contains it (unless exactOnly), and a "contains" match is
  // refused when the same text also names one of the form's other fields.
  function waeAfFindField(labels, exactOnly) {
    const wants = (Array.isArray(labels) ? labels : [labels]).map(waeAfNorm);
    const others = WAE_AF_OTHER_LABELS.map(waeAfNorm);
    let best = null;
    let bestScore = 0;
    for (const el of waeAfDeepAll(WAE_AF_FIELD_SELECTOR)) {
      for (const cand of waeAfLabelCandidates(el)) {
        const c = waeAfNorm(cand);
        let score = 0;
        if (wants.includes(c)) score = 2;
        else if (!exactOnly && wants.some((w) => c.includes(w)) && !others.some((o) => c.includes(o))) score = 1;
        if (score > bestScore) { best = el; bestScore = score; }
      }
    }
    return best;
  }

  // The "Report an abuse" button at the bottom of the article. Found by
  // its text on ANY element (a link, a button, or a custom element the
  // text is nested in). The article's own text also has an inline link
  // with the same words ("... click on "Report an abuse" and complete the
  // form") that does not open the form, so candidates are ranked: not
  // inside body text (a paragraph, list item, heading) first, then real
  // buttons, then the biggest on screen, then the one later on the page.
  function waeAfFindTrigger() {
    const want = waeAfNorm('Report an abuse');
    const matches = waeAfDeepAll('*').filter((el) => {
      if (el === document.body || el === document.documentElement || el.id === 'wae-af-status') return false;
      const t = el.textContent || '';
      return t.length < 80 && waeAfNorm(t).includes(want);
    });
    const innermost = matches.filter((el) => !matches.some((o) => o !== el && el.contains(o)));
    const ranked = innermost.map((el, index) => {
      const target = el.closest('a, button, [role="button"], [role="link"]') || el;
      const rect = target.getBoundingClientRect?.();
      return {
        target,
        index,
        inText: !!(el.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6') || target.closest('p, li, blockquote')),
        isButton: target.matches('button, [role="button"]'),
        area: rect ? rect.width * rect.height : 0,
      };
    });
    ranked.sort((x, y) => (x.inText - y.inText) || (y.isButton - x.isButton) || (y.area - x.area) || (y.index - x.index));
    return ranked[0] ? { target: ranked[0].target, inText: ranked[0].inText } : null;
  }

  function waeAfFormVisible() {
    return !!(waeAfFindField(WAE_AF_LOCATION_LABELS)
      || waeAfFindField(WAE_AF_NAME_LABELS, true)
      || waeAfFindField(WAE_AF_EMAIL_LABELS, true));
  }

  // Three different ways to "click", one per attempt, since a plain
  // .click() is not enough for every component: (1) .click(); (2) the
  // whole pointer/mouse event sequence; (3) follow the link's href
  // ourselves (carrying the session along in the hash).
  function waeAfActivate(target, attempt, session) {
    try { target.scrollIntoView?.({ block: 'center' }); } catch (e) { /* ignore */ }
    console.info(`[Wayfarer Map Mods - Abuse Reports] Clicking "Report an abuse" (try ${attempt}):`, target);
    if (attempt === 1) { target.click(); return; }
    if (attempt === 2) {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, button: 0 }));
      }
      return;
    }
    const link = target.closest('a[href]') || target.querySelector?.('a[href]');
    if (link && link.href) {
      const url = new URL(link.href, location.href);
      url.hash = new URLSearchParams({ [WAE_AF_HASH_SESSION]: session.id, [WAE_AF_HASH_ORIGIN]: session.origin }).toString();
      location.assign(url.toString());
    } else {
      target.click();
    }
  }

  function waeAfLogTriggerCandidates() {
    const rows = waeAfDeepAll('*')
      .filter((el) => { const t = (el.textContent || '').trim(); return t.length > 0 && t.length < 80 && /abuse/i.test(t); })
      .map((el) => ({ tag: el.tagName.toLowerCase(), text: el.textContent.trim(), html: el.outerHTML.slice(0, 200) }));
    console.warn('[Wayfarer Map Mods - Abuse Reports] Could not find the "Report an abuse" button. Elements mentioning "abuse":');
    if (console.table) console.table(rows); else console.warn(rows);
  }

  // Runs on its own as soon as the Help Center tab opens -- it does NOT
  // wait for the data from the Wayfarer tab (v1.71.0 clicked only after
  // that arrived, so a missing answer meant nothing was ever clicked).
  // Clicks the article's button up to WAE_AF_TRIGGER_MAX_CLICKS times,
  // spaced out, until some form field appears.
  function waeAfStartNavigator(session) {
    const startedAt = Date.now();
    let clicks = 0;
    let lastClickAt = 0;
    let lastScrollAt = 0;
    let warned = false;
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - startedAt > WAE_AF_NAV_MAX_MS || waeAfFormVisible()) { clearInterval(timer); return; }
      let trigger = waeAfFindTrigger();
      // The article's inline link renders before the real button does.
      // Clicking it wastes a click AND starts the retry wait, so it is
      // ignored unless nothing better has shown up for a while.
      if (trigger && trigger.inText && now - startedAt < WAE_AF_INLINE_LINK_AFTER_MS) trigger = null;
      // The button sits at the very end of the article; scroll there in case the page only renders it once it is near.
      if (!trigger && now - lastScrollAt >= WAE_AF_NAV_SCROLL_MS) {
        lastScrollAt = now;
        try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (e) { /* ignore */ }
      }
      if (trigger && clicks < WAE_AF_TRIGGER_MAX_CLICKS && now - lastClickAt >= WAE_AF_TRIGGER_RETRY_MS) {
        clicks += 1;
        lastClickAt = now;
        waeAfActivate(trigger.target, clicks, session);
      } else if (!trigger && !warned && clicks === 0 && now - startedAt >= WAE_AF_NAV_NOT_FOUND_MS) {
        warned = true;
        waeAfLogTriggerCandidates();
        waeAfShowStatus('Abuse auto-fill: can\u2019t find the \u201cReport an abuse\u201d button. Click it yourself; the form will still be filled in.', 'error');
      }
    }, WAE_AF_NAV_POLL_MS);
  }

  // Native value setter + input/change events, so the component sees a
  // real edit (Map Mods' dispatchInput() does the same). Never overwrites
  // text that is already in the field. A single-line <input> can't hold
  // line breaks, so they become "; " there.
  function waeAfSetValue(el, value) {
    if (!el || !value) return false;
    if (String(el.value || '').trim()) return false;
    const text = el.tagName === 'INPUT' ? value.replace(/\s*\n\s*/g, '; ') : value;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    try { el.focus?.(); } catch (e) { /* ignore */ }
    if (setter) setter.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    // blur too: the form validates on blur, and a "This is a required
    // field" message from before the fill would otherwise stay up.
    try { el.blur?.(); } catch (e) { /* ignore */ }
    return true;
  }

  // Fallback for the name / email fields when none of the known labels or
  // placeholders matched: a text input whose own placeholder / aria-label /
  // autocomplete / type says it is a name or an email address. Never a
  // "Wayspot name"-style field.
  function waeAfFindContactField(kind) {
    return waeAfDeepAll(WAE_AF_FIELD_SELECTOR).find((el) => {
      if (String(el.value || '').trim()) return false;
      const attr = (n) => String(el.getAttribute(n) || '').toLowerCase();
      const hay = `${attr('placeholder')} ${attr('aria-label')} ${attr('autocomplete')}`;
      if (kind === 'email') return attr('type') === 'email' || /e-?mail|@/.test(hay);
      return attr('type') !== 'email' && /\bname\b/.test(hay) && !/wayspot|stop|gym|nomination|location|e-?mail/.test(hay);
    }) || null;
  }

  // Innermost short element with exactly this text (a button label, say),
  // returned as its nearest clickable ancestor.
  function waeAfFindClickableByText(text) {
    const want = waeAfNorm(text);
    const matches = waeAfDeepAll('*').filter((el) => {
      if (el === document.body || el === document.documentElement || el.id === 'wae-af-status') return false;
      const t = el.textContent || '';
      return t.length < 40 && waeAfNorm(t) === want;
    });
    const innermost = matches.filter((el) => !matches.some((o) => o !== el && el.contains(o)));
    const el = innermost[0];
    return el ? (el.closest('button, a, [role="button"], [role="link"]') || el) : null;
  }

  function waeAfShowStatus(text, kind) {
    const mount = () => {
      let el = document.getElementById('wae-af-status');
      if (!el) {
        el = document.createElement('div');
        el.id = 'wae-af-status';
        el.title = 'Click to dismiss';
        el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:340px;padding:8px 12px;'
          + 'border-radius:8px;font:12px/1.4 Roboto,Arial,sans-serif;color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);';
        el.addEventListener('click', () => el.remove());
        document.documentElement.appendChild(el);
      }
      el.style.background = kind === 'error' ? '#b91c1c' : kind === 'ok' ? '#15803d' : '#1d4ed8';
      el.textContent = text;
      clearTimeout(el._waeTimer);
      if (kind === 'ok') el._waeTimer = setTimeout(() => el.remove(), 8000);
    };
    if (document.documentElement) mount();
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
  }

  // { id, origin } from this page's URL hash (or, after a full page load
  // inside the Help Center, from sessionStorage), or null for an
  // ordinary visit that wasn't started from Wayfarer -- in which case
  // this script does nothing at all on the Help Center.
  function waeAfReadSession() {
    const params = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
    let id = params.get(WAE_AF_HASH_SESSION) || '';
    let origin = params.get(WAE_AF_HASH_ORIGIN) || '';
    try {
      if (id && origin) {
        sessionStorage.setItem(WAE_AF_SESSION_KEY, JSON.stringify({ id, origin, at: Date.now() }));
      } else {
        const saved = JSON.parse(sessionStorage.getItem(WAE_AF_SESSION_KEY) || 'null');
        if (saved && Date.now() - saved.at < WAE_AF_SESSION_TTL_MS) ({ id, origin } = saved);
      }
    } catch (e) { /* storage unavailable -- the hash alone still works */ }
    if (!id || origin !== WAE_WAYFARER_ORIGIN) return null;
    return { id, origin };
  }

  function waeAfClearSession() {
    try { sessionStorage.removeItem(WAE_AF_SESSION_KEY); } catch (e) { /* ignore */ }
  }

  function waeAfLogCandidates(what = 'the location field') {
    const rows = waeAfDeepAll(WAE_AF_FIELD_SELECTOR).map((el) => ({
      tag: el.tagName.toLowerCase(),
      slot: el.getAttribute('slot') || '',
      type: el.getAttribute('type') || '',
      labelCandidates: waeAfLabelCandidates(el).join(' | '),
    }));
    console.warn(`[Wayfarer Map Mods - Abuse Reports] Could not find ${what} by its label. Fields on this page:`);
    if (console.table) console.table(rows); else console.warn(rows);
  }

  const waeAfSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function waeAfPointerSequence(el) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, button: 0 }));
    }
  }

  // The "What issue are you reporting?" dropdown (a custom component, a
  // list of options with check boxes). Map Mods fills its Pokestop form's
  // dropdowns by setting the component's state directly; this form's
  // dropdown looks like a multi-select, whose state shape isn't known
  // here, so this drives it the way a person does instead: open it, click
  // the option, close it. The option is clicked ONCE (a second click on a
  // check box would un-tick it), and only retried when the option row
  // itself reports "not selected".
  function waeAfFindIssueCombo() {
    const combos = waeAfDeepAll('[role="combobox"]');
    const want = waeAfNorm(WAE_AF_ISSUE_LABEL);
    return combos.find((el) => waeAfNorm(el.getAttribute('aria-label')).includes(want))
      || waeAfDeepAll('input[placeholder="Search"]')[0]
      || (combos.length === 1 ? combos[0] : null);
  }

  async function waeAfSelectIssueByClicks(title) {
    const want = waeAfNorm(title);
    const combo = waeAfFindIssueCombo();
    if (!combo) return 'nocombo';
    const findOption = () => {
      const hits = waeAfDeepAll('*').filter((el) => {
        if (el === combo || combo.contains(el) || el.id === 'wae-af-status') return false;
        const t = el.textContent || '';
        return t.length < 120 && waeAfNorm(t) === want;
      });
      return hits.find((el) => !hits.some((o) => o !== el && el.contains(o))) || null;
    };
    const rowOf = (el) => el.closest('[role="option"], li, label, button') || el;
    let option = null;
    for (const mode of ['click', 'sequence']) {
      if (mode === 'click') combo.click(); else waeAfPointerSequence(combo);
      for (let i = 0; i < 15 && !option; i++) { await waeAfSleep(100); option = findOption(); }
      if (option) break;
    }
    if (!option) {
      console.warn('[Wayfarer Map Mods - Abuse Reports] Issue type option not found:', title, '-- options on the page:',
        waeAfDeepAll('[role="option"], li').map((el) => (el.textContent || '').trim()).filter(Boolean));
      return 'nooption';
    }
    const signal = (row) => {
      const cb = row.querySelector?.('input[type="checkbox"]');
      const aria = row.getAttribute?.('aria-selected');
      return { known: aria != null || !!cb, on: aria === 'true' || !!cb?.checked };
    };
    rowOf(option).click();
    await waeAfSleep(300);
    const again = findOption();
    let verified = false;
    if (again) {
      const state = signal(rowOf(again));
      if (state.known && !state.on) { waeAfPointerSequence(rowOf(again)); await waeAfSleep(300); }
      const after = signal(rowOf(findOption() || again));
      verified = after.known && after.on;
    }
    // close the list again (a multi-select stays open and would sit on top of the fields below)
    combo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    await waeAfSleep(200);
    if (combo.getAttribute('aria-expanded') === 'true') combo.click();
    // Did the component show the choice? Only a visible signal counts: the
    // option row reporting itself selected, or the widget's own text /
    // input now holding the title once the list is closed.
    if (!verified && !findOption()) {
      const root = combo.getRootNode();
      const vals = [...(root.querySelectorAll?.('input') || [])].map((i) => i.value).join(' ');
      verified = waeAfNorm(`${combo.textContent} ${vals}`).includes(want);
    }
    return verified ? 'ok' : 'tried';
  }

  // First choice, and what Map Mods does for the Pokestop form's dropdowns
  // (setStaticDropdownByTitleAsync in that script): the dropdown component
  // keeps its options as JSON in a <script> inside it; the option whose
  // title matches is put into the component's selectedOption and the
  // component's own "on-select-dd-field" event is fired. Returns true when
  // the component took it, false when it didn't, null when no dropdown
  // here has such an option.
  async function waeAfSelectIssueDirect(title) {
    const want = waeAfNorm(title);
    for (const script of waeAfDeepAll('script[type="application/json"]')) {
      let options;
      try { options = JSON.parse(script.textContent || ''); } catch (e) { continue; }
      if (!Array.isArray(options)) continue;
      let option = options.find((o) => o && waeAfNorm(o.title) === want);
      if (!option) {
        const partial = options.filter((o) => o && typeof o.title === 'string' && waeAfNorm(o.title).includes(want));
        if (partial.length === 1) [option] = partial;
      }
      const host = script.parentElement || script.getRootNode()?.host;
      if (!option || !host) continue;
      host.selectedOption = option;
      if ('isOpened' in host) host.isOpened = false;
      host.dispatchEvent(new CustomEvent('on-select-dd-field', { detail: { selectedOption: option } }));
      if (host.updateComplete?.then) await host.updateComplete;
      return host.selectedOption === option;
    }
    return null;
  }

  // After the last field is filled: scroll so the form's Submit button
  // sits at WAE_AF_SUBMIT_VIEWPORT_FRACTION of the window height, counted
  // from the top (90% = near the bottom edge, with the button fully in
  // view and the form above it still readable). Only scrolls when the
  // button is below that line or above the window; a button already
  // higher up is left where it is, and without a Submit button the page
  // isn't scrolled at all. Never presses it -- that stays yours. Waits a
  // moment first so a dropdown that was just closed has finished moving
  // the layout around.
  function waeAfFindSubmitButton() {
    for (const label of ['Submit', 'Submit request', 'Submit report', 'Send']) {
      const button = waeAfFindClickableByText(label);
      if (button) return button;
    }
    const typed = waeAfDeepAll('button[type="submit"], input[type="submit"]')[0];
    if (typed) return typed;
    return waeAfDeepAll('button, [role="button"], a').find((el) => {
      const t = (el.textContent || '').trim();
      return t.length > 0 && t.length < 40 && /submit/i.test(t);
    }) || null;
  }

  async function waeAfScrollToSubmit() {
    await waeAfSleep(300);
    const button = waeAfFindSubmitButton();
    if (!button) { console.info('[Wayfarer Map Mods - Abuse Reports] No Submit button found to scroll to.'); return; }
    try {
      const rect = button.getBoundingClientRect();
      const line = window.innerHeight * WAE_AF_SUBMIT_VIEWPORT_FRACTION;
      const centre = rect.top + rect.height / 2;
      if (centre > line || rect.bottom < 0) window.scrollBy({ top: centre - line, behavior: 'smooth' });
    } catch (e) { /* ignore */ }
  }

  // 'ok' (selected, and confirmed) | 'tried' (clicked through the list but
  // could not confirm the choice showed up) | 'nooption' | 'nocombo'.
  async function waeAfSelectIssue(title) {
    const direct = await waeAfSelectIssueDirect(title);
    console.info('[Wayfarer Map Mods - Abuse Reports] Issue type, direct method:', direct === null ? 'no dropdown with that option found' : direct);
    if (direct === true) return 'ok';
    const viaClicks = await waeAfSelectIssueByClicks(title);
    console.info('[Wayfarer Map Mods - Abuse Reports] Issue type, click method:', viaClicks);
    return viaClicks;
  }


  // Works through the form as it appears, for up to WAE_AF_POLL_MAX polls:
  // clicks the article's "Report an abuse" button until a form field shows
  // up (a few times, spaced out -- the first click can land before the
  // page's own handlers are attached), then fills name and email on the
  // step that has them and the location field on the step that has that
  // one -- the person can click Next in between, and each field is filled
  // at most once. Finishes when the location field has been dealt with.
  async function waeAfFill(payload) {
    const text = typeof payload?.locationDetails === 'string' ? payload.locationDetails : '';
    if (!text) { waeAfShowStatus('Abuse auto-fill: the Marked Wayspots list was empty.', 'error'); return; }
    const want = { name: String(payload.name || '').trim(), email: String(payload.email || '').trim() };
    const done = { name: !want.name, email: !want.email };
    const filledList = [];
    let sawForm = false;
    let shown = '';
    const missing = [!want.name && 'name', !want.email && 'email'].filter(Boolean);
    const note = missing.length ? ` (no ${missing.join(' or ')} saved in the settings cog, so that is left to you)` : '';
    let clickedNext = false;
    const progress = () => {
      const msg = filledList.length
        ? `Abuse auto-fill: filled in ${filledList.join(' and ')}; waiting for the location field (click Next/Continue if the form has another step)\u2026`
        : `Abuse auto-fill: waiting for the form\u2026${note}`;
      if (msg !== shown) { shown = msg; waeAfShowStatus(msg, 'info'); }
    };
    progress();

    for (let attempt = 0; attempt < WAE_AF_POLL_MAX; attempt++) {
      if (!done.name) {
        const f = waeAfFindField(WAE_AF_NAME_LABELS, true) || waeAfFindContactField('name');
        if (f) { sawForm = true; done.name = true; if (waeAfSetValue(f, want.name)) filledList.push('your name'); }
      }
      if (!done.email) {
        const f = waeAfFindField(WAE_AF_EMAIL_LABELS, true) || waeAfFindContactField('email');
        if (f) { sawForm = true; done.email = true; if (waeAfSetValue(f, want.email)) filledList.push('your email'); }
      }
      const loc = waeAfFindField(WAE_AF_LOCATION_LABELS);
      if (loc) {
        // The report step: location list, then the optional extras from the
        // settings cog (details / abuser text, issue type). Empty settings
        // are left for the person to fill in.
        const done2 = filledList.length ? [filledList.join(' and ')] : []; // name / email from the previous step
        const todo = [];
        const locFilled = waeAfSetValue(loc, text);
        const n = Number(payload.count) || 0;
        if (locFilled) done2.push(`the ${n} Wayspot${n === 1 ? '' : 's'} (location field)`);
        const details = String(payload.reportDetails || '').trim();
        const abuser = String(payload.abuser || '').trim();
        if (details) {
          const f = waeAfFindField(WAE_AF_REPORT_DETAILS_LABELS, true);
          if (f && waeAfSetValue(f, details)) done2.push('the report details'); else if (!f) todo.push('the report details');
        } else todo.push('the report details');
        if (abuser) {
          const f = waeAfFindField(WAE_AF_ABUSER_LABELS, true);
          if (f && waeAfSetValue(f, abuser)) done2.push('the abuser details'); else if (!f) todo.push('the abuser details');
        }
        const issue = String(payload.issueType || '').trim();
        if (issue) {
          waeAfShowStatus('Abuse auto-fill: choosing the issue type\u2026', 'info');
          const r = await waeAfSelectIssue(issue);
          if (r === 'ok') done2.push(`the issue type (${issue})`);
          else if (r === 'tried') todo.push('the issue type (selected it, but could not confirm it — please check)');
          else todo.push('the issue type');
        } else todo.push('the issue type');
        waeAfClearSession();
        let head = done2.length ? `Abuse auto-fill: filled in ${done2.join(', ')}.` : 'Abuse auto-fill: nothing needed filling in.';
        if (!locFilled) head += ' The location field already had text, so it was left as it was.';
        const tail = todo.length ? ` Still yours: ${todo.join(', ')}.` : '';
        const watching = payload.watchSubmit ? ' This tab closes by itself once the report is submitted.' : '';
        waeAfShowStatus(`${head}${tail} Check everything and submit.${watching}`, todo.length ? 'info' : 'ok');
        await waeAfScrollToSubmit();
        return;
      }
      // Name and email were both entered by us and the location field is
      // not on this step: press the step's Next button once.
      if (!clickedNext && want.name && want.email && done.name && done.email && filledList.length) {
        const next = waeAfFindClickableByText('Next');
        if (next) {
          clickedNext = true;
          await waeAfSleep(250); // let the form register the typed values first
          console.info('[Wayfarer Map Mods - Abuse Reports] Clicking "Next":', next);
          next.click();
        }
      }
      if (attempt === WAE_AF_NOT_FOUND_POLLS && ((!done.name && want.name) || (!done.email && want.email))) {
        waeAfLogCandidates('the name/email fields');
        waeAfShowStatus('Abuse auto-fill: can\u2019t find the name/email fields (see the console). Fill them in yourself; the location list will still be filled in.', 'error');
      }
      progress();
      await waeAfSleep(WAE_AF_POLL_MS);
    }
    waeAfLogCandidates();
    waeAfShowStatus(sawForm
      ? 'Abuse auto-fill: could not find the location field. Use "Copy All" in the Marked Wayspots list and paste it in yourself.'
      : 'Abuse auto-fill: could not find the form (or the "Report an abuse" button). Use "Copy All" in the Marked Wayspots list instead.', 'error');
  }

  // ---- submit watcher ------------------------------------------------
  // A click counts as the person pressing Submit when it lands on a
  // submit-type control or a button/link labelled like one (the click's
  // composedPath() is used, so a click on the text inside a shadow-DOM
  // button is seen too).
  function waeAfIsSubmitClick(ev) {
    const labels = WAE_AF_SUBMIT_LABELS.map(waeAfNorm);
    for (const el of (ev.composedPath ? ev.composedPath() : [])) {
      if (!el || el.nodeType !== 1 || !el.matches) continue;
      if (el.matches('button[type="submit"], input[type="submit"]')) return true;
      if (el.matches('button, [role="button"], a') && (el.textContent || '').length < 40 && labels.includes(waeAfNorm(el.textContent))) return true;
    }
    return false;
  }

  // All the page's text, shadow roots included (innerText stops at them).
  function waeAfPageText() {
    let text = document.body ? document.body.textContent || '' : '';
    for (const el of waeAfDeepAll('*')) if (el.shadowRoot) text += ` ${el.shadowRoot.textContent || ''}`;
    return text;
  }

  function waeAfOnSubmitted(session, reason) {
    console.info('[Wayfarer Map Mods - Abuse Reports] Abuse report submitted (' + reason + '); closing this tab.');
    waeAfClearSession();
    try {
      window.opener?.postMessage({ type: WAE_AF_MSG_SUBMITTED, protocolVersion: WAE_AF_PROTOCOL, sessionId: session.id }, session.origin);
    } catch (e) { /* the Wayfarer tab is gone -- closing still goes ahead */ }
    waeAfShowStatus('Abuse auto-fill: report submitted. Closing this tab\u2026', 'ok');
    setTimeout(() => {
      try { window.close(); } catch (e) { /* ignore */ }
      // a browser may refuse to close a tab it doesn't consider script-opened
      setTimeout(() => {
        if (!window.closed) waeAfShowStatus('Abuse auto-fill: report submitted. You can close this tab now.', 'ok');
      }, 500);
    }, WAE_AF_CLOSE_DELAY_MS);
  }

  // Two independent ways to notice a submitted report, either one enough:
  //  1. the page starts showing the Help Center's confirmation text after
  //     the report form had been on screen -- needs no knowledge of what the
  //     Submit button is called (v1.81.0 only had way 2, and a button
  //     label it didn't know meant it never noticed anything);
  //  2. a click on Submit after which the form stays gone.
  function waeAfWatchSubmit(session) {
    let done = false;
    let verifying = false;
    let sawForm = !!waeAfFindField(WAE_AF_LOCATION_LABELS);
    const confirmationBefore = WAE_AF_CONFIRMATION_RE.test(waeAfPageText());
    console.info('[Wayfarer Map Mods - Abuse Reports] Watching for the abuse form being submitted (the tab will close afterwards).');
    const finish = (reason) => {
      if (done) return;
      done = true;
      clearInterval(standing);
      waeAfOnSubmitted(session, reason);
    };
    // way 1
    const standing = setInterval(() => {
      if (done) return;
      if (waeAfFindField(WAE_AF_LOCATION_LABELS)) { sawForm = true; return; }
      if (sawForm && !confirmationBefore && WAE_AF_CONFIRMATION_RE.test(waeAfPageText())) finish('confirmation text');
    }, 500);
    // way 2 -- capture phase: runs before the page's own handler, so the
    // form is still on the page when this looks.
    document.addEventListener('click', (ev) => {
      if (done || verifying || !waeAfIsSubmitClick(ev)) return;
      // only the report step has the location field; a "Submit"-looking
      // click anywhere else (the name/email step's button) is not it
      if (!waeAfFindField(WAE_AF_LOCATION_LABELS)) return;
      console.info('[Wayfarer Map Mods - Abuse Reports] Submit clicked; checking that the form goes through.');
      verifying = true;
      const startedAt = Date.now();
      let gone = 0;
      const timer = setInterval(() => {
        if (done) { clearInterval(timer); return; }
        gone = waeAfFindField(WAE_AF_LOCATION_LABELS) ? 0 : gone + 1;
        if (gone >= WAE_AF_SUBMIT_GONE_POLLS) { clearInterval(timer); finish('the form closed'); return; }
        if (!confirmationBefore && WAE_AF_CONFIRMATION_RE.test(waeAfPageText())) { clearInterval(timer); finish('confirmation text'); return; }
        if (Date.now() - startedAt > WAE_AF_SUBMIT_VERIFY_MS) {
          // still standing: the click was rejected (a required field, say) -- wait for the next one
          console.info('[Wayfarer Map Mods - Abuse Reports] The form is still there after Submit; waiting for the next click.');
          clearInterval(timer);
          verifying = false;
        }
      }, WAE_AF_SUBMIT_POLL_MS);
    }, true);
  }

  function waeAfStartHelpshiftCompanion() {
    const session = waeAfReadSession();
    if (!session) return;
    waeAfShowStatus('Abuse auto-fill: connecting to the Wayfarer tab\u2026', 'info');
    if (window.opener == null) {
      waeAfShowStatus('Abuse auto-fill: lost the connection to the Wayfarer tab. Use "Copy All" there instead.', 'error');
      return;
    }
    let gotData = false;
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (event.source !== window.opener || event.origin !== session.origin) return;
      if (!data || data.type !== WAE_AF_MSG_DATA || data.protocolVersion !== WAE_AF_PROTOCOL || data.sessionId !== session.id) return;
      if (gotData) return;
      gotData = true;
      clearInterval(retryTimer);
      if (data.payload && data.payload.watchSubmit) waeAfWatchSubmit(session);
      waeAfFill(data.payload).catch((e) => {
        console.warn('[Wayfarer Map Mods - Abuse Reports] Abuse form auto-fill failed:', e);
        waeAfShowStatus('Abuse auto-fill failed -- see the console. Use "Copy All" in the Marked Wayspots list instead.', 'error');
      });
    });
    const request = () => {
      try {
        window.opener.postMessage({ type: WAE_AF_MSG_REQUEST, protocolVersion: WAE_AF_PROTOCOL, sessionId: session.id }, session.origin);
      } catch (e) { /* opener went away -- the retry below gives up on its own */ }
    };
    // Asked again a few times: the Wayfarer tab's listener is up long
    // before a person can click the button, but one lost message
    // shouldn't mean a dead tab.
    let retries = 0;
    const retryTimer = setInterval(() => {
      retries += 1;
      if (gotData || retries >= 5) { clearInterval(retryTimer); return; }
      request();
    }, 2000);
    request();
    waeAfStartNavigator(session);
    setTimeout(() => {
      if (gotData) return;
      console.warn('[Wayfarer Map Mods - Abuse Reports] No answer from the Wayfarer tab.');
      waeAfShowStatus('Abuse auto-fill: the Wayfarer tab did not answer. Reload the Wayfarer tab (it needs this script version) and try the button again.', 'error');
    }, WAE_AF_DATA_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------------
  // Sightengine AI-image check (v1.89.0). The review-page row has a button
  // that opens Sightengine's \"Detect AI-generated images\" page with the
  // review photo's address in the URL hash. That page only takes dropped /
  // uploaded files (no address or query parameter), so this half -- which
  // runs on that one page, see the @match lines -- downloads the photo and
  // hands it to the page's own upload input as if you had picked the file.
  // Nothing else happens on an ordinary visit to Sightengine (no hash, no
  // action), and only Google-hosted photo addresses (what Wayfarer serves
  // review photos from) are accepted.
  // ---------------------------------------------------------------------
  const WAE_SE_ORIGIN = 'https://sightengine.com';
  const WAE_SE_URL = 'https://sightengine.com/detect-ai-generated-images';
  const WAE_SE_HASH_IMAGE = 'wae-photo';
  // v1.92.0: the verdict goes back to the Wayfarer tab that opened the check
  const WAE_SE_HASH_SESSION = 'wae-se-session';
  const WAE_SE_MSG_RESULT = 'wae-sightengine:result';
  const WAE_SE_AI_THRESHOLD = 0.9;          // "over 90%" AI-generated starts the auto-fill
  const WAE_SE_RESULT_TIMEOUT_MS = 60000;   // how long the page is watched for a verdict

  function waeSeIsAllowedPhotoUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && /(^|\.)googleusercontent\.com$/i.test(u.hostname);
    } catch (e) {
      return false;
    }
  }

  function waeSeWaitFor(get, ms) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const found = get();
        if (found) resolve(found);
        else if (Date.now() - started >= ms) resolve(null);
        else setTimeout(tick, 150);
      };
      tick();
    });
  }

  // v1.92.0: Sightengine's AI score (0..1) out of a parsed response -- the
  // check API calls it `type.ai_generated`; any `ai_generated` number in
  // 0..1 found within a few levels is taken.
  function waeSeFindAiScore(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    if (typeof obj.ai_generated === 'number' && obj.ai_generated >= 0 && obj.ai_generated <= 1) return obj.ai_generated;
    for (const value of Object.values(obj)) {
      const found = waeSeFindAiScore(value, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  // Wraps the page's fetch / XMLHttpRequest so that a response carrying an
  // AI score is noticed. Runs in the page itself (@inject-into page).
  function waeSeHookNetwork(onJson) {
    const inspect = (text) => {
      if (typeof text !== 'string' || !/^\s*[{[]/.test(text)) return;
      try { onJson(JSON.parse(text)); } catch (e) { /* not JSON */ }
    };
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (...args) {
        const promise = origFetch.apply(this, args);
        promise.then((res) => {
          try { res.clone().text().then(inspect).catch(() => {}); } catch (e) { /* ignore */ }
        }).catch(() => {});
        return promise;
      };
    }
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') inspect(this.responseText);
          else if (this.responseType === 'json' && this.response) onJson(this.response);
        } catch (e) { /* ignore */ }
      });
      return origSend.apply(this, args);
    };
  }

  // Resolves with { score, source } as soon as the verdict shows up, or
  // null after WAE_SE_RESULT_TIMEOUT_MS. Two ways of seeing it: a network
  // response with the score (exact), else a percentage in text that was
  // not on the page before the photo was handed over (new lines only, so
  // the page's own marketing numbers never count, and lines that say
  // "not"/"human"/"real"/"accuracy" are skipped). Call arm() right before the hand-over.
  function waeSeStartResultWatch() {
    let armed = false;
    let settled = false;
    let resolveWatch;
    let baseline = new Set();
    let poll = null;
    const promise = new Promise((resolve) => { resolveWatch = resolve; });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolveWatch(value);
    };
    const timer = setTimeout(() => finish(null), WAE_SE_RESULT_TIMEOUT_MS + 8000);
    const pageLines = () => (document.body ? document.body.innerText || '' : '')
      .split('\n').map((line) => line.trim()).filter(Boolean);
    waeSeHookNetwork((obj) => {
      if (!armed) return;
      const score = waeSeFindAiScore(obj);
      if (score !== null) {
        console.info('[Wayfarer Map Mods - Abuse Reports] Sightengine verdict from a response:', score);
        finish({ score, source: 'response' });
      }
    });
    const PERCENT_RES = [
      /(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:chance\s+|likelihood\s+|probability\s+)?(?:of\s+being\s+)?(?:AI|artificial)/i,
      /(?:AI[- ]generated|artificial)[^\d%\n]{0,40}(\d{1,3}(?:[.,]\d+)?)\s*%/i,
    ];
    return {
      promise,
      arm() {
        armed = true;
        baseline = new Set(pageLines());
        poll = setInterval(() => {
          const fresh = pageLines().filter((line) => !baseline.has(line) && !/\b(?:not|non|no|human|real|authentic|natural)\b|accura/i.test(line));
          for (const line of fresh) {
            for (const re of PERCENT_RES) {
              const m = line.match(re);
              if (!m) continue;
              const pct = parseFloat(m[1].replace(',', '.'));
              if (pct >= 0 && pct <= 100) {
                console.info('[Wayfarer Map Mods - Abuse Reports] Sightengine verdict from the page text:', line);
                finish({ score: pct / 100, source: 'page' });
                return;
              }
            }
          }
        }, 500);
      },
    };
  }

  // Tell the user, and the Wayfarer tab that opened this one (when it kept
  // the opener, see the review row's Sightengine button), what the verdict
  // was. Wayfarer decides what happens next.
  function waeSeReportResult(sessionId, found) {
    const score = found ? found.score : null;
    if (score === null) {
      waeAfShowStatus('Sightengine check: could not read the verdict from the page. Check it by eye.', 'error');
    } else {
      const pct = Math.round(score * 1000) / 10;
      waeAfShowStatus(`Sightengine check: ${pct}% AI-generated.`, 'info');
    }
    if (!sessionId || !window.opener) return;
    try {
      window.opener.postMessage({ type: WAE_SE_MSG_RESULT, protocolVersion: WAE_AF_PROTOCOL, sessionId, score }, WAE_WAYFARER_ORIGIN);
    } catch (e) { /* the Wayfarer tab is gone */ }
  }

  async function waeSeStartCompanion() {
    const params = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
    const photoUrl = params.get(WAE_SE_HASH_IMAGE) || '';
    const seSession = params.get(WAE_SE_HASH_SESSION) || '';
    if (!photoUrl) return; // an ordinary visit -- do nothing
    const watch = waeSeStartResultWatch();
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* keep the hash */ }
    if (!waeSeIsAllowedPhotoUrl(photoUrl)) {
      waeAfShowStatus('Sightengine check: that is not a Wayfarer photo address, so nothing was loaded.', 'error');
      return;
    }
    waeAfShowStatus('Sightengine check: loading the review photo\u2026', 'info');
    let file;
    try {
      const res = await fetch(photoUrl, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const type = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
      file = new File([blob], `wayfarer-review-photo.${type.split('/')[1].replace('jpeg', 'jpg')}`, { type });
    } catch (e) {
      console.warn('[Wayfarer Map Mods - Abuse Reports] Could not load the review photo for Sightengine:', e, photoUrl);
      waeAfShowStatus('Sightengine check: could not load the photo here. Save it from the review page and drop it on this page yourself.', 'error');
      return;
    }
    // The page's own upload input (hidden or not) is the most reliable way
    // in; a synthetic drop on the document is the fallback.
    await new Promise((r) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r, { once: true }) : r()));
    const input = await waeSeWaitFor(() => document.querySelector('input[type="file"]'), 8000);
    try {
      watch.arm();
      const dt = new DataTransfer();
      dt.items.add(file);
      if (input) {
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        for (const type of ['dragenter', 'dragover', 'drop']) {
          document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        }
      }
      waeAfShowStatus('Sightengine check: photo sent to the checker. Waiting for the verdict\u2026 (if nothing shows up, drop the photo on the page yourself)', 'ok');
      watch.promise.then((found) => waeSeReportResult(seSession, found));
    } catch (e) {
      console.warn('[Wayfarer Map Mods - Abuse Reports] Could not hand the photo to Sightengine:', e);
      waeAfShowStatus('Sightengine check: could not hand the photo to the page. Save it from the review page and drop it on this page yourself.', 'error');
    }
  }

  if (location.origin === WAE_SE_ORIGIN) {
    waeSeStartCompanion();
    return;
  }

  // The Help Center page runs only the half above and stops here -- none
  // of the Wayfarer / Map Mods code below applies to it.
  if (location.origin === WAE_HS_ORIGIN) {
    waeAfStartHelpshiftCompanion();
    return;
  }

  // @grant none (see this script's header) means window already IS
  // unsafeWindow -- no sandbox -- per Tampermonkey's own docs, so this is
  // a no-op indirection here, not a functional necessity the way it is in
  // the importer script (which runs sandboxed under @grant
  // GM_xmlhttpRequest). Kept anyway and used everywhere WFMM.ui is
  // touched, not just the Plugin Manager registration at the bottom of
  // this file, so both scripts share the exact same access pattern
  // regardless of which one you're reading.
  const wfmmWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const EXTRACT_DB_NAME = 'wf-abuse-report-extract-db';
  const EXTRACT_DB_VERSION = 2;
  const EXTRACT_STORE_NAME = 'extractedReports';
  // v1.21.0: split out of extractedReports. issueType/locationDetails/
  // reportDetails are genuinely per-TICKET, not per-location -- storing
  // them on every location row meant a 12-location ticket duplicated the
  // same ~2.4KB of raw text 12 times. Measured at a real 15,000-row/
  // 1,250-ticket scale: ~92% of stored bytes were pure duplication (~32MB
  // of ~35MB). Each location row now just carries a `ticketKey` pointing
  // at its one shared record here.
  const TICKET_DETAILS_STORE_NAME = 'ticketDetails';

  // ---------------------------------------------------------------------
  // Storage -- a small, self-contained IndexedDB store. Not reusing
  // WSTStorage for this: that library's schema (see the importer script)
  // is shaped around raw {headers, body} email records, not structured
  // extraction rows, and its source wasn't shared here to extend safely.
  // ---------------------------------------------------------------------

  function openExtractDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(EXTRACT_DB_NAME, EXTRACT_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(EXTRACT_STORE_NAME)) {
          db.createObjectStore(EXTRACT_STORE_NAME, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(TICKET_DETAILS_STORE_NAME)) {
          db.createObjectStore(TICKET_DETAILS_STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function putRecordsToStore(storeName, records) {
    if (!records.length) return { inserted: 0, updated: 0 };
    const db = await openExtractDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      let inserted = 0, updated = 0;
      for (const rec of records) {
        const getReq = store.get(rec.id);
        getReq.onsuccess = () => {
          if (getReq.result) updated++; else inserted++;
          store.put(rec);
        };
        // If the existence check itself fails, still attempt the write --
        // worst case this row's inserted/updated count is off by one, not
        // worth losing the row over.
        getReq.onerror = () => store.put(rec);
      }
      tx.oncomplete = () => resolve({ inserted, updated });
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAllFromStore(storeName) {
    const db = await openExtractDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteRecordsFromStore(storeName, ids) {
    if (!ids.length) return;
    const db = await openExtractDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const id of ids) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearStore(storeName) {
    const db = await openExtractDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function putExtractedRecords(records) { return putRecordsToStore(EXTRACT_STORE_NAME, records); }
  function putTicketDetails(records) { return putRecordsToStore(TICKET_DETAILS_STORE_NAME, records); }
  function deleteExtractedRecords(ids) { return deleteRecordsFromStore(EXTRACT_STORE_NAME, ids); }
  function clearExtractedRecords() { return clearStore(EXTRACT_STORE_NAME); }
  function clearTicketDetails() { return clearStore(TICKET_DETAILS_STORE_NAME); }

  // Transparently joins the two stores back into the same record shape
  // every existing caller (search, table render, CSV export, nearby-
  // duplicate detection) already expects -- issueType/locationDetails/
  // reportDetails just get hydrated from the shared per-ticket record
  // instead of being stored on the row itself. Nothing downstream of this
  // function needed to change.
  async function getAllExtractedRecords() {
    const [rows, details] = await Promise.all([
      getAllFromStore(EXTRACT_STORE_NAME),
      getAllFromStore(TICKET_DETAILS_STORE_NAME),
    ]);
    const detailsById = new Map(details.map((d) => [d.id, d]));
    return rows.map((r) => {
      const d = detailsById.get(r.ticketKey) || {};
      return {
        ...r,
        // Rows stored before v1.62.1 can still carry a "#" in their ticket
        // id. Cleaned here, on read, so the table, sorting, search, CSV
        // export and nearby-ticket labels all see the bare number without
        // touching what's stored. Only values containing "#" are changed.
        conversationId: typeof r.conversationId === 'string' && r.conversationId.includes('#')
          ? (r.conversationId.replace(/\D/g, '') || null)
          : r.conversationId,
        issueType: d.issueType ?? null,
        locationDetails: d.locationDetails ?? null,
        reportDetails: d.reportDetails ?? null,
      };
    });
  }

  // ---------------------------------------------------------------------
  // Map attachment -- v1.26.0 switched this over to WFMM.map, the
  // suite's own shared map-lookup service (confirmed against the real
  // source, src/core/map/service.js) -- the same one Report History and
  // every other official WFMM plugin uses. Earlier versions here were
  // wrong that "Base has no public API for this" -- that was true of an
  // older Base version this was originally ported against (Report
  // Wayspots v3.15.0's own hand-rolled Angular __ngContext__ reflection,
  // copied here since nothing better was known to exist at the time), but
  // the now-consolidated suite's WFMM.map has had one for a while: get(),
  // isReady(), refresh({reason, force}) (a Promise<map|null>, cached and
  // shared across every plugin that calls it -- cheap to call liberally),
  // onReady(cb)/onCleared(cb) events, all backed by dedicated per-route
  // adapters (COMPONENT_ADAPTERS["mapview"]/["submit-new"] in
  // src/core/map/adapters/index.js) rather than one hand-rolled selector
  // trying to cover both. Concretely fixes the "abuse crosses don't show
  // on the submit map" report: this plugin's OWN reflection hack only
  // ever really got exercised against the mapview page in practice, while
  // WFMM.map's dedicated submit-new adapter is the exact thing Report
  // History relies on to work correctly there -- using the same service
  // instead of a parallel from-scratch reimplementation of "find the
  // Wayfarer map" means this plugin now gets that same, actually-
  // maintained submit-map support for free, and stays covered if
  // Wayfarer's own markup changes again later (WFMM's own adapters would
  // need updating either way, for every plugin that depends on them, not
  // just this one).
  //
  // waeMapReadyUnsub/waeMapClearedUnsub/waeRouteEnterUnsub/
  // waeRouteChangeUnsub (subscribed once in startPlugin(), unsubscribed
  // in stopPlugin()) replace the old polling-based "stale watch"
  // (waeStartStaleWatch()/waeStopStaleWatch(), setInterval every 2s)
  // entirely -- WFMM.map.refresh() already checks staleness internally,
  // and WFMM.routes.onEnterMapRoute()/onChangeMapRoute() firing exactly
  // when the user actually navigates onto or between mapview/submit-new
  // is a strictly better trigger than polling ever was, not just a
  // like-for-like swap.
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // Cross-ticket proximity flagging -- "was this same spot reported more
  // than once, in a different ticket". Multiple locations within ONE
  // ticket's own thread are expected (that's the whole multi-location
  // feature) and never flagged against each other here; this is
  // specifically about two different conversationIds landing on
  // (near-)identical coordinates, which is the pattern worth a human
  // actually noticing -- repeat/recurring spam locations, or the same
  // Wayspot reported independently by someone else.
  // ---------------------------------------------------------------------

  const WAE_NEARBY_THRESHOLD_METERS = 20;

  function waeHaversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ~0.001 degrees is ~111m at the equator -- comfortably bigger than
  // WAE_NEARBY_THRESHOLD_METERS, so two points within the threshold of
  // each other always land in the same cell or an immediately adjacent
  // one. Only checking the 3x3 neighborhood instead of every other record
  // is what turns this from O(n^2) into close to O(n) for realistically
  // spread-out real-world locations -- see the v1.13.0 changelog note for
  // why this mattered (600+ accumulated rows made the naive full-pairwise
  // version measurably slow, and it was re-running on every panel open).
  const WAE_GRID_DEG = 0.001;
  function waeGridKey(lat, lon) {
    return `${Math.floor(lat / WAE_GRID_DEG)}:${Math.floor(lon / WAE_GRID_DEG)}`;
  }

  // Returns a Map from record.id -> array of { record, distanceMeters },
  // one entry per OTHER record (from a different ticket) found within
  // WAE_NEARBY_THRESHOLD_METERS.
  function waeFindNearbyDuplicates(records) {
    const withCoords = records.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));

    const buckets = new Map();
    for (const r of withCoords) {
      const key = waeGridKey(r.latitude, r.longitude);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    }

    const result = new Map();
    const addMatch = (id, entry) => {
      if (!result.has(id)) result.set(id, []);
      result.get(id).push(entry);
    };
    const seenPairs = new Set();

    for (const r of withCoords) {
      const cellLat = Math.floor(r.latitude / WAE_GRID_DEG);
      const cellLon = Math.floor(r.longitude / WAE_GRID_DEG);
      for (let dLat = -1; dLat <= 1; dLat++) {
        for (let dLon = -1; dLon <= 1; dLon++) {
          const neighbors = buckets.get(`${cellLat + dLat}:${cellLon + dLon}`);
          if (!neighbors) continue;
          for (const other of neighbors) {
            if (other === r) continue;
            // Each unordered pair can turn up from both records' own
            // neighborhood scans -- skip the second time.
            const pairKey = r.id < other.id ? `${r.id}|${other.id}` : `${other.id}|${r.id}`;
            if (seenPairs.has(pairKey)) continue;
            seenPairs.add(pairKey);

            const rTicket = r.conversationId || r.sourceEmailId;
            const oTicket = other.conversationId || other.sourceEmailId;
            if (rTicket === oTicket) continue;

            const distanceMeters = waeHaversineMeters(r.latitude, r.longitude, other.latitude, other.longitude);
            if (distanceMeters <= WAE_NEARBY_THRESHOLD_METERS) {
              addMatch(r.id, { record: other, distanceMeters });
              addMatch(other.id, { record: r, distanceMeters });
            }
          }
        }
      }
    }
    return result;
  }

  function waeSortedNearbyMatches(nearby) {
    return (nearby || []).slice().sort((x, y) => x.distanceMeters - y.distanceMeters);
  }

  function waeFormatNearbyForCsv(nearby) {
    if (!nearby || !nearby.length) return null;
    return waeSortedNearbyMatches(nearby)
      .map((n) => `${n.record.conversationId || n.record.sourceEmailId} (${Math.round(n.distanceMeters)}m)`)
      .join('; ');
  }

  // Same grid (WAE_GRID_DEG/waeGridKey, just above) waeFindNearbyDuplicates()
  // already indexes waeAllRecords with -- reused here rather than a second
  // grid built from scratch, since the cell math (threshold, cell size) is
  // identical either way. A DIFFERENT index from that function's own,
  // though, not its result: waeFindNearbyDuplicates() deliberately excludes
  // a record's own ticket (it's answering "does this ticket duplicate a
  // DIFFERENT one?"), while waeFindMatchingTicketNumbers() below answers
  // "what ticket(s), if any, already cover this exact Wayspot?" -- self-
  // matches are exactly what it wants, so the two can't share one result.
  //
  // BUGFIX (not upstream): this index used to not exist at all --
  // waeFindMatchingTicketNumbers() did a plain, unindexed linear scan
  // (with a Haversine check) over every single record in waeAllRecords,
  // run again from scratch on every single Wayspot click (see
  // waeStartSidePanelDetailsWatcher(), the only caller). Fine at a few
  // hundred extracted tickets; increasingly not once that count climbs
  // into the thousands, since this plugin's whole purpose is accumulating
  // exactly that over time. Rebuilt only when waeAllRecords itself is
  // reassigned (waeTicketIndexFor !== waeAllRecords) -- comparing the
  // array by reference rather than diffing its contents, same
  // cache-invalidation idiom already used for waeFilteredSortedCacheFor/
  // waeStatsCacheFor elsewhere in this file, safe because every place
  // that actually changes what's extracted (see those two variables' own
  // comments) always assigns waeAllRecords a fresh array rather than
  // mutating the existing one in place.
  let waeTicketIndexFor = null;
  let waeTicketIndexBuckets = null;
  function waeGetTicketIndexBuckets() {
    if (waeTicketIndexFor === waeAllRecords) return waeTicketIndexBuckets;
    const buckets = new Map();
    for (const r of waeAllRecords) {
      if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
      const key = waeGridKey(r.latitude, r.longitude);
      let bucket = buckets.get(key);
      if (!bucket) { bucket = []; buckets.set(key, bucket); }
      bucket.push(r);
    }
    waeTicketIndexBuckets = buckets;
    waeTicketIndexFor = waeAllRecords;
    return buckets;
  }

  // ---------------------------------------------------------------------
  // Nearby-flag popover -- clicking a ⚠️ lists the specific ticket(s) it's
  // near, each as its own clickable item that jumps straight to THAT
  // match's location (via waeGoToLocation, same as clicking a table row
  // directly) rather than just naming it in a hover tooltip with nowhere
  // to go.
  // ---------------------------------------------------------------------

  let waeNearbyPopoverEl = null;

  function waeCloseNearbyPopover() {
    if (!waeNearbyPopoverEl) return;
    waeNearbyPopoverEl.remove();
    waeNearbyPopoverEl = null;
    document.removeEventListener('click', waeNearbyPopoverOutsideClick, true);
    document.removeEventListener('keydown', waeNearbyPopoverEscHandler);
  }

  function waeNearbyPopoverEscHandler(ev) {
    if (ev.key === 'Escape') waeCloseNearbyPopover();
  }

  function waeNearbyPopoverOutsideClick(ev) {
    if (waeNearbyPopoverEl && !waeNearbyPopoverEl.contains(ev.target)) waeCloseNearbyPopover();
  }

  function waeOpenNearbyPopover(anchorEl, nearby) {
    waeCloseNearbyPopover();

    const titleEl = waeUiApi.createElement('div', {
      className: 'wae-nearby-popover-title',
      text: `Within ${WAE_NEARBY_THRESHOLD_METERS}m, other ticket(s) -- click to go there:`,
    });
    const itemEls = waeSortedNearbyMatches(nearby).map((n) => waeUiApi.createElement('button', {
      className: 'wae-nearby-item',
      text: `${n.record.wayspotName || '(unnamed)'} \u2014 ${Math.round(n.distanceMeters)}m \u2014 ticket ${n.record.conversationId || n.record.sourceEmailId}`,
      attrs: { type: 'button' },
      dataset: { id: n.record.id },
    }));

    // The popover itself is still a manually-positioned floating element,
    // not something built or managed by WFMM.ui -- the suite's UI service
    // has no equivalent of an anchored popover (only full dialogs via
    // openModal()), so this stays outside it, same as before. Only its
    // CONTENTS (title + items above) are now built with ui.createElement
    // instead of an innerHTML string.
    const pop = waeUiApi.createElement('div', {
      id: 'wae-nearby-popover',
      children: [titleEl, ...itemEls],
    });
    document.body.appendChild(pop);

    const anchorRect = anchorEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - pop.offsetWidth - 8));
    const top = Math.min(anchorRect.bottom + 4, window.innerHeight - pop.offsetHeight - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';

    pop.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.wae-nearby-item');
      if (!btn) return;
      const target = waeRecordsById.get(btn.dataset.id);
      waeCloseNearbyPopover();
      if (target) waeGoToLocation(target);
    });

    waeNearbyPopoverEl = pop;
    // Deferred so the click that opened the popover doesn't immediately
    // bubble into the outside-click listener and close it again.
    setTimeout(() => {
      document.addEventListener('click', waeNearbyPopoverOutsideClick, true);
      document.addEventListener('keydown', waeNearbyPopoverEscHandler);
    }, 0);
  }

  // ---------------------------------------------------------------------
  // Map plotting -- extracted locations as a custom google.maps.OverlayView
  // subclass (WaePulseOverlay, see waeEnsurePulseOverlayCtor() further
  // down), NOT native google.maps.Marker objects, as of v1.38.0.
  //
  // v1.12.0's own note here (kept for the record, since the reasoning in
  // it turned out to be the wrong half of the story) argued the opposite:
  // that a custom OverlayView forces a JS-driven DOM reposition on every
  // drag frame while native Markers are repositioned by the Maps SDK
  // itself with "no per-frame JS callback involved." That's not actually
  // true -- Marker's own positioning is internally driven by the exact
  // same projection/frame-update mechanism an OverlayView's draw()
  // subscribes to; there's no callback-free "native" path, just one
  // hidden from userland instead of one written in this file. What
  // v1.12.0 was actually seeing (or anticipating) was never confirmed
  // against a real reposition-cost measurement either way.
  //
  // What v1.38.0 DID confirm, reported as "loads fine on Chrome, slow on
  // Firefox" once a dataset grew into the hundreds: a Marker's .icon is
  // fundamentally an <img>, decoded through the browser's image
  // pipeline -- and that pipeline is measurably heavier in Firefox than
  // Chrome for many small, repeated data: URIs specifically, independent
  // of anything about per-frame positioning. WFMM's own directly
  // analogous "Report History" pulse layer (pulse-layer.js) never used
  // Marker at all, for exactly this reason: it's always been a plain
  // CSS-styled <div> positioned by a custom OverlayView, with the shape
  // as real DOM content rather than an icon image. WaePulseOverlay is
  // that same pattern, adapted for this plugin's own needs (clickable,
  // with a cluster-count label) -- see its own comment for the rest.
  //
  // Own icon/color so this doesn't read as the same layer as Report
  // Wayspots' own reported-wayspot history markers -- this shows
  // *extracted* reports, not Report Wayspots' own submission history, and
  // doesn't require that script to be installed at all. Clickable --
  // with dozens of nearby entries otherwise looking identical, a click
  // naming which ticket a marker belongs to earns its keep here.
  // ---------------------------------------------------------------------

  // BUGFIX (not upstream): only kept now for its OLD saved value, read
  // once at registration time (see startPlugin()) as the starting
  // default for WAE_LAYER_ID the first time this version ever runs for a
  // given user -- WFMM.layers itself is the actual source of truth for
  // on/off going forward (see isMapPulsesEnabled()'s own comment for the
  // full explanation), not this key. Never written to again after this
  // version; left in place rather than deleted since there's no harm in
  // an unused old key sitting in localStorage.
  const WAE_MAP_VISIBLE_KEY = 'wae_map_pulses_visible';
  const WAE_LAYER_ID = 'wae-abuse-crosses';
  // Whether clicking a table row (waeGoToLocation()) closes this panel as
  // part of jumping the map to that location. Defaults to on (matches
  // every version before this setting existed) -- since the panel is a
  // full-screen backdrop, leaving it open would mean the map you just
  // navigated to stays hidden behind it, which is why that was the only
  // behavior originally. Some people would rather keep the panel open
  // (e.g. clicking through several rows in a row to compare locations)
  // and re-open it themselves when they're done looking, hence this
  // being a real setting rather than the one hardcoded behavior.
  //
  // BUGFIX (not upstream, better-integration pass): used to be its own
  // raw localStorage flag (wae_autoclose_on_navigate) -- moved into
  // WFMM.settings (see startPlugin(), which registers WAE_SETTINGS_DEFAULTS
  // under this plugin's own id and migrates whatever was in the old keys
  // the first time this runs) alongside Marker Style's appearance
  // settings just below, for the same reason: WFMM's own Settings >
  // Backups export/import only sees what's registered there.
  function waeAutoCloseOnNavigateEnabled() {
    return wfmmWindow.WFMM.settings.get(PLUGIN_ID, 'autoCloseOnNavigate', true) !== false;
  }
  const WAE_PULSES = { map: null, surface: null, markersById: new Map(), infoWindow: null };

  // Review page (/new/review) crosses -- deliberately a WHOLE SEPARATE
  // state object/overlay class/toggle from WAE_PULSES above, not a third
  // surface folded into it. Two reasons: (1) WFMM.map/WFMM.routes'
  // onEnterMapRoute/onChangeMapRoute -- everything WAE_PULSES' lifecycle
  // runs on -- never fire for the review route at all (see ROUTES in the
  // Map Mods source: the "review" entry is hasMap:false, "WFMM does not
  // currently interact with the review duplicates map"), so this can't
  // piggyback on that tracking and needs its own map-discovery entirely;
  // (2) the requirement this exists to satisfy is that the Settings
  // side-panel entry and this plugin's own tool panel stay exclusive to
  // the mapview/submit pages and never appear on review -- easiest to
  // guarantee by never letting review-page code touch WAE_LAYER_ID,
  // WFMM.layers, or attachSettingsActions() at all, in either direction.
  // See the "Review page support" section (right after waeStopMapTracking())
  // for the map-discovery/toggle/refresh logic itself.
  const WAE_REVIEW_PULSES = { map: null, host: null, markersById: new Map(), draftsById: new Map(), infoWindow: null };
  let waeAllRecords = [];
  let waeRecordsById = new Map();
  // BUGFIX (not upstream, feature request): waeAllRecords used to only
  // ever get populated inside refreshPanel(), which is itself a no-op
  // unless the tool panel is open -- meaning on a fresh page load, with
  // "Abuse Report Crosses" already on from a previous session, the map
  // attached with zero records to draw and nothing ever re-populated
  // waeAllRecords afterward except opening the panel (which didn't
  // itself trigger a redraw either -- only the *next* pan/zoom's 'idle'
  // event did, once data happened to already be loaded by then). Net
  // effect, reported in the field: markers missing on first load, only
  // appearing after opening the panel AND THEN zooming -- and toggling
  // the layer off/on didn't help either, since that path hit the exact
  // same empty waeAllRecords. waeEnsureRecordsLoaded() below is the fix:
  // a single shared, cached load callers can await before any redraw,
  // so the data is actually there by the time anything first tries to
  // draw from it, whether or not the panel has ever been opened. See
  // its own comment just below.
  let waeRecordsLoadPromise = null;

  // Loads waeAllRecords/waeRecordsById from storage if nothing has
  // loaded them yet THIS session, and caches the in-flight promise so
  // concurrent callers (bootstrap, a layer toggle-on, the review map
  // attaching, the panel opening) all await the same one IndexedDB read
  // rather than racing separate ones. Deliberately a one-time-per-session
  // cache, not a "read fresh every time" -- callers that need genuinely
  // up-to-date data after a real change (refreshPanel(), and the scan/
  // import/clear handlers it's called from) still call
  // getAllExtractedRecords() directly and assign waeAllRecords themselves,
  // exactly as before; this function only exists to guarantee SOMETHING
  // has loaded at least once before the very first draw attempt.
  function waeEnsureRecordsLoaded() {
    if (!waeRecordsLoadPromise) {
      waeRecordsLoadPromise = waeMigrateReportedHistory().catch(() => {}).then(() => getAllExtractedRecords())
        .then((records) => {
          waeAllRecords = records;
          waeRecordsById = new Map(records.map((r) => [r.id, r]));
          return records;
        })
        .catch((e) => {
          waeRecordsLoadPromise = null; // don't cache a failure -- let the next caller retry the read
          throw e;
        });
    }
    return waeRecordsLoadPromise;
  }
  let waeNearbyMap = new Map();
  let waeSearchQuery = '';
  let waeCurrentPage = 1;
  // null waeSortKey = the original default (newest-scanned first).
  // 'conversation'/'status'/'lastResponse' match the sortable column keys
  // in buildTableSection() below -- table()'s own onSort(key) callback
  // hands back exactly one of those. Persisted to localStorage (see
  // waeLoadSortState()/waeSaveSortState() below) so the chosen sort
  // survives a full page reload, not just closing/reopening the panel --
  // module-level state alone already covered that part, same as before.
  const WAE_SORT_STORAGE_KEY = 'wae_sort_state';
  const WAE_SORTABLE_KEYS = ['starred', 'conversation', 'status', 'lastResponse'];
  function waeLoadSortState() {
    try {
      const saved = JSON.parse(localStorage.getItem(WAE_SORT_STORAGE_KEY) || 'null');
      if (saved && WAE_SORTABLE_KEYS.includes(saved.key) && (saved.direction === 'asc' || saved.direction === 'desc')) {
        return saved;
      }
    } catch (e) { /* fall through to default below */ }
    return { key: null, direction: 'desc' };
  }
  function waeSaveSortState() {
    localStorage.setItem(WAE_SORT_STORAGE_KEY, JSON.stringify({ key: waeSortKey, direction: waeSortDirection }));
  }
  const waeInitialSortState = waeLoadSortState();
  let waeSortKey = waeInitialSortState.key;
  let waeSortDirection = waeInitialSortState.direction;

  // Feature request: table column widths are user-adjustable (drag the
  // border between two header cells in buildTableSection() below) rather
  // than fixed forever -- these percentages (summing to 100, matching
  // this file's own long-standing tuned widths) are now just the
  // STARTING point a first render falls back to. Keyed by the same
  // column `key` buildTableSection() already gives each column (not by
  // position), so a saved width still lands on the right column even if
  // a future column gets inserted/reordered there. Persisted via
  // WFMM.settings (see waeLoadTableColumnWidths()/
  // waeSaveTableColumnWidths()) rather than raw localStorage the way sort
  // state above still is -- same reasoning as this file's own appearance
  // settings: a real, user-tuned layout preference is worth carrying
  // through WFMM's own Settings > Backups export/import, not just this
  // browser profile.
  // Feature request: Lat/Lng merged into one Coordinates column, and the
  // Comment/Nearby icon columns dropped entirely -- see buildTableSection()'s
  // `columns` array for what replaced them (a hover tooltip on the name,
  // and the nearby-ticket warning icon appended to the name cell). Six
  // columns now instead of nine; percentages rebalanced accordingly, with
  // the space that freed up going mostly to Wayspot Name.
  const WAE_TABLE_COLUMN_DEFAULTS = {
    starred: 6, conversation: 12, name: 32, coordinates: 15,
    status: 14, lastResponse: 13, edit: 8,
  };
  // Floor on any one column's share -- keeps a fat-fingered drag from
  // shrinking a column to nothing (and, since a drag only ever trades
  // width between the two columns it's between -- see
  // waeMakeTableColumnsResizable()'s own comment -- from ever needing to
  // touch a THIRD column just to keep this floor everywhere at once).
  const WAE_TABLE_MIN_COLUMN_PERCENT = 4;
  function waeLoadTableColumnWidths() {
    const saved = wfmmWindow.WFMM.settings.get(PLUGIN_ID, 'tableColumnWidths', null);
    const widths = { ...WAE_TABLE_COLUMN_DEFAULTS };
    if (saved && typeof saved === 'object') {
      for (const key of Object.keys(widths)) {
        if (Number.isFinite(saved[key]) && saved[key] >= WAE_TABLE_MIN_COLUMN_PERCENT) widths[key] = saved[key];
      }
    }
    // Widths saved before the pencil column existed sum to 100 without
    // it, so merging in its default overshoots -- rescale so the row
    // always totals exactly 100%, as waeMakeTableColumnsResizable()
    // assumes.
    const total = Object.values(widths).reduce((a, b) => a + b, 0);
    if (total > 0 && Math.abs(total - 100) > 0.01) {
      for (const key of Object.keys(widths)) widths[key] = (widths[key] * 100) / total;
    }
    return widths;
  }
  function waeSaveTableColumnWidths(widths) {
    wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'tableColumnWidths', widths);
  }

  // ---------------------------------------------------------------------
  // Marker appearance -- v1.23.0. Registered with WFMM.markerAppearance
  // (confirmed against the real source, src/core/marker-appearance.js) so
  // this plugin's marker style is a genuine, discoverable entry in the
  // suite's own marker-styling engine, not just an internal constant. Kept
  // in the exact same shape WFMM.markerAppearance itself normalizes
  // "generic" styles to -- {markerSize, borderColor, borderWidth,
  // borderOpacity, fillColor, fillOpacity} -- so a resolve() lookup
  // against our style key returns something any WFMM-aware code already
  // knows how to interpret.
  //
  // IMPORTANT HONESTY NOTE, since this was asked for as "add ours to
  // that [Wayspots/Pok\u00e9stops/Gyms/Power Spots] system": the actual
  // settings SCREEN with that grid (wayspot-overlay's own marker-settings-
  // modal.js) is hardcoded to those four built-in kinds -- STYLE_KINDS in
  // src/plugins/wayspot-overlay/settings.js is a frozen array, with no
  // registration point for a third-party plugin to add a new row/column.
  // There's no real API path to literally insert into that specific grid.
  // What IS real and plugin-facing is the underlying engine that grid is
  // built on (WFMM.markerAppearance.registerStyle()/.resolve()) -- so
  // this plugin registers its own style bucket there (a legitimate use of
  // real public API, confirmed against source) and gets its OWN "Marker
  // Style" section in this panel to edit it, using the same
  // colorInput/numberInput/rangeInput controls the suite's own settings
  // screens use. Same underlying engine, same look, own section -- not a
  // literal new row in that one hardcoded grid.
  // v1.67.0: on the review maps every cross (abuse reports AND the abuse
  // draft's Marked Wayspots) is drawn this many px larger than the
  // map-view one. Derived from the same Cross size setting, not a setting
  // of its own, so the review maps always follow it. The extra size is
  // there because those crosses sit among (and, before this version,
  // beneath) the much bigger Wayspot markers.
  const WAE_REVIEW_MARKER_SIZE_BONUS = 3;
  const WAE_APPEARANCE_STYLE_KEY = 'wae:abuse-report';
  const WAE_APPEARANCE_DEFAULTS = Object.freeze({
    // BUGFIX (not upstream, feature request): standard defaults as of
    // v1.41.0 -- markerSize/clusterMarkerSize both 12px (previously 9/10
    // respectively -- see clusterMarkerSize's own comment for why they
    // used to differ at all), borderWidth 1px (previously 2), fillOpacity
    // 0.5 (previously 1, fully opaque). fillOpacity/borderWidth only
    // ever render on the cluster circle -- a single-report X marker has
    // no fill region or ring to apply them to (see waeGetMarkerSvgMarkup()'s
    // own comment) -- so in practice this reads as "cluster circles are
    // now half-opacity with a thinner ring," with both marker types
    // sized the same. Only takes effect for anyone who hasn't customized
    // these already -- WFMM.settings.registerPlugin() (see startPlugin())
    // only ever fills in values that aren't already saved, so an
    // existing customized value here is left exactly as that person set
    // it.
    markerSize: 12,
    clusterMarkerSize: 12,
    fillColor: '#dc2626',
    fillOpacity: 0.5,
    borderColor: '#ffffff',
    borderWidth: 1,
    borderOpacity: 1,
    clickable: true,
    // Feature request: color for the separate Marked Wayspots dots (see
    // waeRenderMarkedWayspotMarkers()) -- blue by default, deliberately
    // distinct from fillColor's own red-ish default above so the two
    // marker types (abuse-report crosses/clusters vs. this plugin's own
    // scratch-list dots) stay visually distinguishable even before
    // anyone customizes either one.
    // Feature request: color for a favorited submitter's username in the
    // side panel (see waeStartSidePanelDetailsWatcher()'s own comment on
    // where that's read/styled) -- amber by default, distinct from both
    // fillColor's red and markColor's blue above so all three stay
    // visually distinguishable from each other without anyone having to
    // customize anything first.
    favoriteUserColor: '#f59e0b',
    markColor: '#2563eb',
    // Feature request: separate color for CSV-imported rows' markers.
    // null (the default) means "same as fillColor" -- it FOLLOWS the
    // email-marker color, so out of the box the two are identical even
    // after someone has customized fillColor. Picking a color in Marker
    // Style stores it here and the two become independent; "Same as
    // email" (or Reset to default) puts it back to null. Size, cluster
    // size, opacity and ring settings are deliberately NOT duplicated:
    // imported markers always use the email markers' own.
    importColor: null,
  });
  // Combined with autoCloseOnNavigate (see waeAutoCloseOnNavigateEnabled()
  // above) under one WFMM.settings.registerPlugin() call in startPlugin()
  // -- everything this plugin persists as a genuine user preference (as
  // opposed to sync/bookkeeping state) lives under these two keys now.
  const WAE_SETTINGS_DEFAULTS = Object.freeze({
    appearance: WAE_APPEARANCE_DEFAULTS,
    autoCloseOnNavigate: true,
    // Feature request: whether the Marked Wayspots list's "Copy All"
    // appends each entry's note -- see waeCopyIncludesNotes().
    copyIncludeNotes: true,
    // v1.64.0: whether the note field + "+ add to abuse report draft"
    // button also appear inside the review map's info windows -- see
    // waeReviewIwSyncNow(). Checkbox: Marker Style settings.
    reviewMapAbuseControls: true,
    // v1.71.0: name/email the abuse form auto-fill puts in the form's
    // contact fields -- see waeGetReporterContact().
    reporterName: '',
    reporterEmail: '',
    // v1.72.0: the report step's issue type (the option's title as the
    // form shows it), default text for the report-details / abuser fields.
    reporterIssueType: 'Fake Nominations or criteria issues',
    reporterReportDetails: '',
    reporterAbuser: '',
    // v1.81.0: close the Help Center tab after the form is submitted and
    // offer to clear the draft list. Off unless switched on.
    afterSubmitCleanup: false,
  });
  // Set once at startPlugin() (WFMM.markerAppearance.registerStyle()'s
  // return value) and called at stopPlugin() -- registerStyle() throws
  // "already registered" if called twice for the same key without an
  // unregister in between, which matters here since startPlugin() can run
  // again if the plugin is toggled off and back on in Plugin Manager.
  let waeUnregisterAppearance = null;

  function waeClampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }
  function waeNormalizeHexColor(value, fallback) {
    const s = String(value || '').trim();
    return /^#[0-9a-f]{3}$/i.test(s) || /^#[0-9a-f]{6}$/i.test(s) ? s : fallback;
  }
  function waeNormalizeAppearance(raw) {
    const a = raw || {};
    return {
      markerSize: waeClampNumber(a.markerSize, 4, 24, WAE_APPEARANCE_DEFAULTS.markerSize),
      clusterMarkerSize: waeClampNumber(a.clusterMarkerSize, 4, 24, WAE_APPEARANCE_DEFAULTS.clusterMarkerSize),
      fillColor: waeNormalizeHexColor(a.fillColor, WAE_APPEARANCE_DEFAULTS.fillColor),
      fillOpacity: waeClampNumber(a.fillOpacity, 0, 1, WAE_APPEARANCE_DEFAULTS.fillOpacity),
      borderColor: waeNormalizeHexColor(a.borderColor, WAE_APPEARANCE_DEFAULTS.borderColor),
      borderWidth: waeClampNumber(a.borderWidth, 0, 8, WAE_APPEARANCE_DEFAULTS.borderWidth),
      borderOpacity: waeClampNumber(a.borderOpacity, 0, 1, WAE_APPEARANCE_DEFAULTS.borderOpacity),
      // Not a marker-appearance field WFMM.markerAppearance itself knows
      // about (that registry is purely about how a marker looks, not
      // whether it responds to clicks) -- kept alongside it here anyway
      // since it's still a per-marker Google Maps option this same
      // Marker Style section is the natural place to expose, and it's
      // simplest to save/normalize/reset together with the rest rather
      // than as a separate WFMM.settings key.
      clickable: typeof a.clickable === 'boolean' ? a.clickable : WAE_APPEARANCE_DEFAULTS.clickable,
      markColor: waeNormalizeHexColor(a.markColor, WAE_APPEARANCE_DEFAULTS.markColor),
      importColor: a.importColor ? waeNormalizeHexColor(a.importColor, null) : null,
      favoriteUserColor: waeNormalizeHexColor(a.favoriteUserColor, WAE_APPEARANCE_DEFAULTS.favoriteUserColor),
    };
  }
  // BUGFIX (not upstream, better-integration pass): used to be its own
  // raw localStorage key (wae_marker_appearance) -- moved into
  // WFMM.settings, same registry (and same reasoning: WFMM's own
  // Settings > Backups export/import) as waeAutoCloseOnNavigateEnabled()
  // just above. See WAE_SETTINGS_DEFAULTS and startPlugin(), which
  // registers it and migrates whatever was in the old keys the first
  // time this runs.
  function waeLoadAppearance() {
    return waeNormalizeAppearance(wfmmWindow.WFMM.settings.get(PLUGIN_ID, 'appearance', WAE_APPEARANCE_DEFAULTS));
  }
  function waeSaveAppearance(appearance) {
    wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'appearance', appearance);
    // Cached SVG icons (WAE_MARKER_ICON/WAE_CLUSTER_ICON, see below) are
    // built from these values -- stale otherwise until the next full page
    // load.
    WAE_MARKER_ICON = {};
    WAE_CLUSTER_ICON = {};
    // Only live-redraw if pulses are actually already visible -- editing
    // colors shouldn't be what makes the map attach/show pulses if the
    // user never turned "Show on Map" on.
    if (WAE_PULSES.map && isMapPulsesEnabled()) waeSafeRefreshPulses();
    if (WAE_REVIEW_PULSES.map && waeReviewPulsesEnabled()) waeSafeRefreshReviewPulses(); // v1.67.0: review crosses derive from Cross size
  }

  const WAE_PAGE_SIZE = 200;

  // WFMM.ui, set while the panel is open (buildPanelContent()) and used by
  // every DOM-building helper below (log(), the nearby popover, the
  // table). Not just wfmmWindow.WFMM.ui directly everywhere, so those
  // helpers don't need to know or care whether they're being called from
  // inside openModal's buildContent() callback (which is handed its own
  // `ui` reference) or from further down the call stack (a scan/clear
  // handler, a table row click) where only this module-level reference is
  // in scope.
  let waeUiApi = null;
  // Live refs into the currently-open panel's DOM -- null whenever the
  // panel is closed, since WFMM.ui.openModal() tears the dialog down on
  // close instead of just hiding it (unlike the old hand-rolled backdrop,
  // which stayed in the DOM with display:none). Every render/refresh
  // function below checks this first and no-ops if the panel isn't open.
  let waeUI = null;
  let waePanelController = null;

  // Search matches across everything a person might actually search by --
  // not just the visible name/conversation columns, but the raw
  // locationDetails/reportDetails text too, since a query like a street
  // name or an issue keyword is more likely to hit those than the
  // best-guess Wayspot name.
  //
  // BUGFIX (not upstream, feature request): a query starting with "#"
  // used to fail to match anything, even for a ticket number that
  // otherwise matches fine on its own -- conversationId itself is never
  // stored with a leading "#", so "#12345".includes(...) against a
  // haystack containing plain "12345" is a real substring mismatch, not
  // a false positive being avoided. This matters in practice because the
  // Live Wayspot annotation feature (see the README) shows ticket
  // references on the map itself as "#12345, #67890" -- the exact format
  // someone reading that off the map and pasting into this search box
  // would naturally type. Stripped here (leading "#"s only -- there's no
  // legitimate reason a real query would start with one otherwise) so
  // "#12345" and "12345" search identically.
  function waeMatchesQuery(r, q) {
    if (!q) return true;
    if (!r._waeHaystack) {
      r._waeHaystack = [
        r.wayspotName, r.conversationId, r.comment, r.issueType,
        r.locationDetails, r.reportDetails, r.sourceFilename, r.sourceEmailId,
        waeStatusLabel(r.ticketStatus),
      ].filter(Boolean).join('\n').toLowerCase();
    }
    return r._waeHaystack.includes(q.replace(/^#+/, ''));
  }
  // Built lazily and cached -- same icon object reused for every marker
  // instead of rebuilt per-call. Invalidated (set back to null) by
  // waeSaveAppearance() whenever the user changes a marker-style setting.
  // BUGFIX (not upstream): these two used to build a Marker "icon"
  // descriptor ({url: 'data:image/svg+xml,...', scaledSize, anchor}) --
  // see STYLE's own .wae-pulse-marker comment for why that's the actual
  // source of the Chrome-vs-Firefox gap this was rewritten to fix. Now
  // return the raw <svg>...</svg> markup itself (still cached exactly
  // the same way, still invalidated by waeSaveAppearance() the same way)
  // for WaePulseOverlay to drop straight into a div's innerHTML instead.
  // Keyed by variant ('email' | 'imported') -- same shape/size, only the
  // color differs. waeIsImportedRecord()/waeIsImportedCluster() decide
  // which variant a marker gets.
  let WAE_MARKER_ICON = {};
  function waeIsImportedRecord(r) { return !!r && r.source === 'csv'; }
  // A cluster only takes the imported color when EVERY record in it is
  // imported; a mix with email-sourced reports keeps the email color.
  function waeIsImportedCluster(cluster) {
    return !!cluster && cluster.records.length > 0 && cluster.records.every(waeIsImportedRecord);
  }
  function waeGetMarkerSvgMarkup(imported, forReview) {
    const variant = `${forReview ? 'review-' : ''}${imported ? 'imported' : 'email'}`;
    if (WAE_MARKER_ICON[variant]) return WAE_MARKER_ICON[variant];
    const a = waeLoadAppearance();
    const markerSize = a.markerSize + (forReview ? WAE_REVIEW_MARKER_SIZE_BONUS : 0); // v1.67.0
    // Kept as a distinct X glyph (not the same filled-circle look as a
    // regular Wayspot/Pok\u00e9stop/Gym marker) so an abuse-report location
    // still reads as "a problem here", not just another POI dot -- only
    // its color/size are what's user-configurable via fillColor/
    // markerSize. borderColor/borderWidth/borderOpacity/fillOpacity don't
    // apply to this shape (an X has no fill region or ring) -- they only
    // affect the cluster icon below, which IS a filled circle with a
    // ring, matching WFMM's own "generic" marker shape exactly.
    const size = markerSize * 2;
    const half = size / 2;
    const arm = size * 0.35;
    const stroke = Math.max(2, Math.round(markerSize * 0.45));
    const color = imported ? (a.importColor || a.fillColor) : a.fillColor;
    WAE_MARKER_ICON[variant] = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
      + `<line x1="${half - arm}" y1="${half - arm}" x2="${half + arm}" y2="${half + arm}" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>`
      + `<line x1="${half + arm}" y1="${half - arm}" x2="${half - arm}" y2="${half + arm}" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>`
      + '</svg>';
    return WAE_MARKER_ICON[variant];
  }

  // Same color as the single-report marker, just as a filled circle
  // (matching WFMM's own "generic" POI marker shape) with room for a
  // count label -- reads as "many of the same thing" rather than a
  // different kind of marker. Every field here (fillColor/fillOpacity/
  // borderColor/borderWidth/borderOpacity/clusterMarkerSize) is user-
  // configurable through the Marker Style section.
  //
  // Two cached variants, not one -- see WAE_CLUSTER_EXPAND_ZOOM/
  // WAE_CLUSTER_EXPAND_FACTOR just below for why: at the lowest zoom
  // level these still show at, a cluster typically represents FAR more
  // ground (and often far more reports) per pixel than it does once
  // you're zoomed in, so the same fixed size reads as under-emphasized
  // right when it matters most. Rendering it visibly bigger specifically
  // at that floor zoom -- rather than one size for every zoom -- makes a
  // wide-area glance actually draw the eye to where reports are
  // concentrated, without changing anything about how it looks once
  // you've zoomed in past that floor.
  const WAE_CLUSTER_EXPAND_FACTOR = 1.5;
  let WAE_CLUSTER_ICON = {};
  function waeGetClusterSvgMarkup(expanded, imported) {
    const cacheKey = `${expanded ? 'expanded' : 'normal'}:${imported ? 'imported' : 'email'}`;
    if (WAE_CLUSTER_ICON[cacheKey]) return WAE_CLUSTER_ICON[cacheKey];
    const a = waeLoadAppearance();
    const r = a.clusterMarkerSize * (expanded ? WAE_CLUSTER_EXPAND_FACTOR : 1);
    const size = (r + a.borderWidth) * 2;
    const c = size / 2;
    const color = imported ? (a.importColor || a.fillColor) : a.fillColor;
    WAE_CLUSTER_ICON[cacheKey] = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
      + `<circle cx="${c}" cy="${c}" r="${r}" fill="${color}" fill-opacity="${a.fillOpacity}" stroke="${a.borderColor}" stroke-width="${a.borderWidth}" stroke-opacity="${a.borderOpacity}"/>`
      + '</svg>';
    return WAE_CLUSTER_ICON[cacheKey];
  }

  // ---------------------------------------------------------------------
  // BUGFIX (not upstream): every single-report and cluster marker used
  // to be a real google.maps.Marker, with the SVG above wrapped as a
  // data: URI and handed in as its .icon -- reported as noticeably
  // slower to load on Firefox than Chrome once a dataset grew into the
  // hundreds, and confirmed (against WFMM's own actual source) to be
  // the same class of problem the suite's own directly-analogous
  // "Report History" pulse layer (pulse-layer.js, PulseOverlay) already
  // avoids on purpose: a Marker's icon renders through the browser's
  // IMAGE decode pipeline (it's fundamentally an <img>), and that
  // pipeline is measurably heavier in Firefox than Chrome for many
  // small, repeated data: URIs specifically -- worse the more markers
  // there are, which is exactly when it'd matter most. WFMM's own pulse
  // layer sidesteps this entirely by never using Marker's icon at all:
  // each point is a plain <div>, styled with real CSS/DOM content,
  // positioned by a custom google.maps.OverlayView subclass instead.
  //
  // WaePulseOverlay below is that same pattern, adapted for this
  // plugin's needs -- clickable, with a cluster-count label, backing a
  // real InfoWindow / recenter-and-zoom on click, none of which
  // pulse-layer.js's own deliberately non-interactive pulses need. The
  // SVG markup from waeGetMarkerSvgMarkup()/waeGetClusterSvgMarkup()
  // above is inserted as real innerHTML now, not a data: URI -- that's
  // the actual fix: DOM/SVG rendering doesn't go through image decoding
  // at all, in either browser.
  //
  // BUGFIX (not upstream): the VISIBLE div lives in the overlayLayer
  // pane (matching pulse-layer.js's own choice), not overlayMouseTarget
  // -- v1.38.0 originally used overlayMouseTarget, which put every
  // cross/cluster visually ABOVE real markers (MapPanes' documented
  // stacking order is mapPane < overlayLayer < markerLayer <
  // overlayMouseTarget < floatPane -- native Wayspot/Pok\u00e9stop/Gym/
  // Power Spot markers, and WFMM's own submission-pin/draft markers,
  // live in markerLayer, below overlayMouseTarget), capable of covering
  // them -- the opposite of the layering a "where are there abuse
  // reports" overlay should have relative to the markers actually being
  // reported on. overlayLayer sits below markerLayer, so real markers
  // now stay visually on top.
  //
  // BUGFIX (not upstream), v1.50.2: that move to overlayLayer was
  // believed to keep the div clickable in its own uncovered area (CSS
  // pointer-events on a specific element overrides an ancestor pane's
  // own default, so the reasoning went) -- reported back as simply not
  // clickable ANYWHERE, not just narrowed to uncovered area, and
  // Google's own Custom Overlays documentation confirms why: overlayLayer
  // "may not receive DOM events" at all, a hard platform restriction
  // with nothing CSS can override, unlike overlayMouseTarget, which
  // explicitly "contains elements that receive DOM events." No single
  // pane is both "receives clicks" and "paints below markerLayer," so
  // this now uses two elements per marker instead of one: the ORIGINAL
  // visible div stays in overlayLayer, purely cosmetic now (never
  // interactive, whatever appearance.clickable says); a second,
  // invisible "hit" div -- same SVG content, same draw() position, only
  // ever created while appearance.clickable is on -- lives in
  // overlayMouseTarget and is what the click listener actually attaches
  // to. Invisible (opacity:0 in CSS, not visibility/display, so it
  // still receives events) rather than removed-but-present, so it never
  // changes what's on screen; visually indistinguishable from a single
  // div that was simply clickable, while still painting below real
  // markers the way the visible div does.
  //
  // Everything OUTSIDE this class -- the diffing loop in
  // waeRefreshPulses(), waeClearPulses(), the WAE_PULSES.markersById Map
  // itself -- is UNCHANGED: OverlayView instances support the exact same
  // .setMap(map)/.setMap(null) calls a Marker does, so none of that
  // surrounding code needed to know its "markers" aren't Markers anymore.
  // ---------------------------------------------------------------------
  let WaePulseOverlayCtor = null;
  function waeEnsurePulseOverlayCtor() {
    if (WaePulseOverlayCtor) return true;
    if (typeof google === 'undefined' || !google.maps?.OverlayView) return false;
    WaePulseOverlayCtor = class extends google.maps.OverlayView {
      constructor() {
        super();
        this.div = null;
        this.hitDiv = null;
        this.latLng = null;
        this.cluster = null;
        this._html = '';
        this._title = '';
        this._clickable = true;
      }
      // Attached to hitDiv's own click listener (see applyToDiv()) --
      // hitDiv only ever exists while this._clickable is on, so there's
      // no need to re-check appearance.clickable in here.
      _handleClick(ev) {
        ev.stopPropagation();
        const c = this.cluster;
        if (!c) return;
        if (c.records.length > 1) {
          const map = WAE_PULSES.map;
          // BUGFIX (not upstream, feature request): a cluster whose
          // records all share the same (or near-identical) coordinates
          // can never actually split apart no matter how far in you
          // zoom -- waeComputeClusters()'s pixel-distance grouping still
          // measures 0px between them at any zoom, so the "zoom in to
          // split it" behavior below used to just re-run at an already-
          // maxed-out zoom, doing nothing visible and leaving every
          // record underneath it unreachable. Once already at
          // WAE_CLUSTER_MAX_ZOOM (so a further zoom genuinely can't
          // reveal anything a previous click hasn't already tried),
          // list the records directly instead of zooming again.
          if (Math.floor(map.getZoom() ?? 0) >= WAE_CLUSTER_MAX_ZOOM) {
            waeShowPulseClusterInfoWindow(c, this.latLng);
            return;
          }
          map.setCenter(this.latLng);
          // Jumps straight to WAE_CLUSTER_MAX_ZOOM (not just "a few
          // levels in") -- a relative +3 from wherever the map happened
          // to already be could still land inside another cluster's
          // pixel radius at low starting zooms, leaving the click
          // looking like it did nothing. WAE_CLUSTER_MAX_ZOOM is deep
          // enough that this plugin's own clustering
          // (WAE_CLUSTER_PIXEL_RADIUS, in screen pixels) reliably splits
          // every real-world cluster back into individual markers.
          // Only ever zooms IN to reach it -- if already deeper than
          // that, the branch above already caught it.
          map.setZoom(Math.max(map.getZoom() || 8, WAE_CLUSTER_MAX_ZOOM));
        } else {
          waeShowPulseInfoWindow(c.records[0], this.latLng);
        }
      }
      onAdd() {
        const div = document.createElement('div');
        div.className = 'wae-pulse-marker';
        this.div = div;
        this.getPanes().overlayLayer.appendChild(div);
        this.applyToDiv();
        this.draw();
      }
      draw() {
        if (!this.div || !this.latLng) return;
        const point = this.getProjection()?.fromLatLngToDivPixel(this.latLng);
        if (!point) return;
        this.div.style.left = `${point.x}px`;
        this.div.style.top = `${point.y}px`;
        if (this.hitDiv) {
          this.hitDiv.style.left = `${point.x}px`;
          this.hitDiv.style.top = `${point.y}px`;
        }
      }
      onRemove() {
        this.div?.remove();
        this.div = null;
        this.hitDiv?.remove();
        this.hitDiv = null;
      }
      getPosition() {
        return this.latLng;
      }
      applyToDiv() {
        if (!this.div) return;
        this.div.innerHTML = this._html;
        this.div.title = this._title;
        // hitDiv is created lazily, only once actually needed, and torn
        // down again the moment it isn't -- no point keeping an extra
        // per-marker DOM node (and its own listener) around for markers
        // that will never be clickable, e.g. with the "Clickable
        // markers" setting off.
        if (this._clickable && !this.hitDiv) {
          const hitDiv = document.createElement('div');
          hitDiv.className = 'wae-pulse-marker wae-pulse-hit wae-pulse-clickable';
          hitDiv.addEventListener('click', (ev) => this._handleClick(ev));
          this.hitDiv = hitDiv;
          this.getPanes()?.overlayMouseTarget.appendChild(hitDiv);
          this.draw(); // hitDiv just got created -- give it a position immediately, don't wait for the next draw() pass
        } else if (!this._clickable && this.hitDiv) {
          this.hitDiv.remove();
          this.hitDiv = null;
        }
        if (this.hitDiv) {
          this.hitDiv.innerHTML = this._html;
          this.hitDiv.title = this._title;
        }
      }
      // Called every refresh pass, for both a brand-new overlay and one
      // being reused for the same cluster key -- same "always reapply
      // rather than diff what changed" approach waeRefreshPulses()'s own
      // per-cluster loop already took with a Marker's
      // setPosition()/setIcon()/setLabel()/etc, kept as-is here since
      // none of this goes through image decoding anymore -- there's
      // nothing left in it that was ever the expensive part.
      setCluster(cluster, isExpanded, appearance) {
        this.cluster = cluster;
        this.latLng = new google.maps.LatLng(cluster.lat, cluster.lng);
        const isClusterMarker = cluster.records.length > 1;
        const imported = waeIsImportedCluster(cluster);
        const shapeSvg = isClusterMarker ? waeGetClusterSvgMarkup(isExpanded, imported) : waeGetMarkerSvgMarkup(imported);
        this._html = isClusterMarker ? `${shapeSvg}<span class="wae-pulse-count">${cluster.records.length}</span>` : shapeSvg;
        this._title = isClusterMarker ? `${cluster.records.length} reports` : (cluster.records[0].wayspotName || '(unnamed report)');
        this._clickable = !!appearance.clickable;
        this.applyToDiv();
        this.draw();
      }
    };
    return true;
  }


  // Same shape/draw/click logic as WaePulseOverlayCtor above, just wired
  // to WAE_REVIEW_PULSES instead of WAE_PULSES -- kept as a genuinely
  // separate class (not a parameterized shared one) because the two
  // surfaces' lifecycles never overlap in practice (you're either on the
  // review page or you're not) and duplicating this one small class is
  // simpler than threading a "which state object" parameter through
  // every method for a class this size.
  let WaeReviewPulseOverlayCtor = null;
  function waeEnsureReviewPulseOverlayCtor() {
    if (WaeReviewPulseOverlayCtor) return true;
    if (typeof google === 'undefined' || !google.maps?.OverlayView) return false;
    WaeReviewPulseOverlayCtor = class extends google.maps.OverlayView {
      constructor() {
        super();
        this.div = null;
        this.latLng = null;
        this.cluster = null;
        this._html = '';
        this._title = '';
        this._clickable = true;
      }
      onAdd() {
        const div = document.createElement('div');
        div.className = 'wae-pulse-marker wae-pulse-review';
        div.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const c = this.cluster;
          if (!c) return;
          if (c.records.length > 1) {
            WAE_REVIEW_PULSES.map.setCenter(this.latLng);
            // Same fix, same reasoning as WaePulseOverlayCtor's own click
            // handler above -- see its comment.
            WAE_REVIEW_PULSES.map.setZoom(Math.max(WAE_REVIEW_PULSES.map.getZoom() || 8, 20));
          } else {
            waeShowReviewPulseInfoWindow(c.records[0], this.latLng);
          }
        });
        this.div = div;
        this.applyToDiv();
        // v1.67.0: markerLayer, the pane Google's own markers render in,
        // with a top-most z-index (.wae-pulse-review) -- NOT overlayLayer
        // like the map-view crosses: that pane sits beneath the markers,
        // which left these hidden behind the Wayspots they mark. Safe to
        // put on top because they are never clickable here (see
        // setCluster(): _clickable is always false), so nothing underneath
        // loses a click, and info windows (floatPane) still open above.
        this.getPanes().markerLayer.appendChild(div);
        this.draw();
      }
      draw() {
        if (!this.div || !this.latLng) return;
        const point = this.getProjection()?.fromLatLngToDivPixel(this.latLng);
        if (!point) return;
        this.div.style.left = `${point.x}px`;
        this.div.style.top = `${point.y}px`;
      }
      onRemove() {
        this.div?.remove();
        this.div = null;
      }
      getPosition() {
        return this.latLng;
      }
      applyToDiv() {
        if (!this.div) return;
        this.div.innerHTML = this._html;
        this.div.title = this._title;
        this.div.classList.toggle('wae-pulse-clickable', this._clickable);
        this.div.classList.toggle('wae-pulse-draft', !!this._isDraft);
      }
      setCluster(cluster, isExpanded, appearance) {
        this.cluster = cluster;
        this.latLng = new google.maps.LatLng(cluster.lat, cluster.lng);
        const isClusterMarker = cluster.records.length > 1;
        const imported = waeIsImportedCluster(cluster);
        const shapeSvg = isClusterMarker ? waeGetClusterSvgMarkup(isExpanded, imported) : waeGetMarkerSvgMarkup(imported, true); // true: review maps draw 3px larger (v1.67.0)
        this._html = isClusterMarker ? `${shapeSvg}<span class="wae-pulse-count">${cluster.records.length}</span>` : shapeSvg;
        this._title = isClusterMarker ? `${cluster.records.length} reports` : (cluster.records[0].wayspotName || '(unnamed report)');
        // BUGFIX (not upstream, feature request): always false here,
        // deliberately NOT appearance.clickable -- review-page markers
        // are meant to stay click-through no matter what the shared
        // "Clickable markers" setting says, since a click on the review
        // page is much more likely meant for the actual review UI
        // underneath (selecting a duplicate candidate, etc.) than for
        // this plugin's own popup/cluster-zoom. The mapview/submit
        // crosses (WaePulseOverlayCtor's own setCluster(), earlier in
        // this file) still follow that setting normally -- this is the
        // one place the two surfaces are meant to diverge on it.
        this._clickable = false;
        this.applyToDiv();
        this.draw();
      }
      // v1.65.1: a Marked Wayspot (abuse draft entry) drawn by this very
      // class -- same div/CSS class, same pane (overlayLayer), same
      // positioning and click-through behavior as the report crosses
      // above, so it renders exactly like them; the only differences are
      // the shape's source (waeGetMarkedWayspotSvgMarkup(), the same X
      // in the Marked Wayspot color) and that there is no cluster behind
      // it, which also makes this class's click handler a no-op for it.
      setDraftItem(item, color) {
        this.cluster = null;
        this._isDraft = true; // stacked just above the report crosses, see .wae-pulse-draft
        this.latLng = new google.maps.LatLng(item.lat, item.lng);
        this._html = waeGetMarkedWayspotSvgMarkup(color, true); // true: review maps draw 3px larger (v1.67.0)
        this._title = item.name || '(unnamed)';
        this._clickable = false;
        this.applyToDiv();
        this.draw();
      }
    };
    return true;
  }

  // Ceiling of Google's own zoom scale for this map type -- also the
  // target _handleClick() above zooms a cluster in to. Named here (used
  // by both _handleClick() and waeShowPulseClusterInfoWindow()) instead
  // of the bare "20" it used to be, now that there's a second thing that
  // needs to agree on exactly which zoom counts as "as far in as this
  // can go."
  const WAE_CLUSTER_MAX_ZOOM = 20;

  const WAE_CLUSTER_PIXEL_RADIUS = 45;

  // Groups records into clusters based on screen-pixel distance at the
  // CURRENT zoom -- not a fixed lat/lng radius, since the same physical
  // distance covers wildly different pixel distances depending on how
  // zoomed in the map is. Same grid-bucketing technique as
  // waeFindNearbyDuplicates (O(n) amortized, not O(n^2)), just in pixel
  // space: project each record to world coordinates, scale by 2^zoom to
  // get actual screen pixels, bucket into cells sized to the cluster
  // radius, then greedily merge each point with unassigned neighbors in
  // its own and adjacent cells that fall within the radius. Not a
  // perfectly optimal clustering, but visually solid and cheap enough to
  // rerun on every recompute -- see waeSetCurrentMap()'s own comment for
  // how often that actually happens now (debounced, off idle rather than
  // every zoom_changed).
  //
  // waeWorldPointCache (keyed by record.id) -- BUGFIX (not upstream): the
  // projection.fromLatLngToPoint() call is the same for a given record
  // every single time, regardless of zoom -- only the `* scale` step
  // actually depends on it -- but this used to redo that projection
  // (plus constructing a fresh google.maps.LatLng to feed it) for EVERY
  // record on EVERY call, i.e. real, avoidable per-record work that
  // scales with dataset size and was being repeated on every recompute
  // for no reason. Cached per record id now, invalidated only when the
  // map instance itself changes (a different map could, in principle,
  // have a different projection, even though in practice Google's
  // standard Mercator projection is the same for every normal map) --
  // NOT when waeAllRecords changes, since a record's own lat/lng is
  // immutable once extracted and the cache is keyed by id, so a scan
  // that adds new records just adds new cache entries rather than
  // invalidating everything already computed.
  let waeWorldPointCache = new Map();
  let waeWorldPointCacheMap = null;

  function waeComputeClusters(map, records) {
    const projection = map.getProjection();
    const zoom = map.getZoom();
    if (!projection || typeof zoom !== 'number') {
      return records.map((r) => ({ recordIds: [r.id], records: [r], lat: r.latitude, lng: r.longitude }));
    }

    if (waeWorldPointCacheMap !== map) {
      waeWorldPointCache = new Map();
      waeWorldPointCacheMap = map;
    }

    const scale = Math.pow(2, zoom);
    // BUGFIX (not upstream): projection.fromLatLngToPoint() -- or the
    // `* scale` step right after it -- can transiently hand back a
    // non-finite x/y for a split second right as a zoom gesture settles
    // (observed as "crosses vanish on a zoom change and don't come back
    // until the Layers checkbox is toggled off/on"). A single bad point
    // here used to propagate into a cluster's averaged lat/lng below,
    // which google.maps.Marker#setPosition() throws on (it requires
    // finite coordinates) -- and since this whole computation runs
    // inside the debounced 'idle' handler with no try/catch anywhere in
    // the chain (see waeRefreshPulses()), that throw aborted the refresh
    // AFTER old markers had already been cleared but BEFORE new ones
    // were added, and nothing else re-triggers a refresh until the next
    // zoom/pan -- so a transient bad value on the LAST settle of a zoom
    // gesture left the layer empty indefinitely. Dropping just the
    // offending record here (instead of letting a bad point corrupt
    // whatever cluster it lands in) keeps one flaky projection from
    // taking out the whole redraw; it's very likely to project cleanly
    // again on the very next recompute.
    const points = records.map((r) => {
      let world = waeWorldPointCache.get(r.id);
      if (!world) {
        world = projection.fromLatLngToPoint(new google.maps.LatLng(r.latitude, r.longitude));
        waeWorldPointCache.set(r.id, world);
      }
      return { record: r, x: world.x * scale, y: world.y * scale };
    }).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

    const cellSize = WAE_CLUSTER_PIXEL_RADIUS;
    const buckets = new Map();
    for (const p of points) {
      const key = `${Math.floor(p.x / cellSize)}:${Math.floor(p.y / cellSize)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(p);
    }

    const assigned = new Set();
    const clusters = [];
    for (const p of points) {
      if (assigned.has(p.record.id)) continue;
      const cellX = Math.floor(p.x / cellSize);
      const cellY = Math.floor(p.y / cellSize);
      const group = [p];
      assigned.add(p.record.id);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighbors = buckets.get(`${cellX + dx}:${cellY + dy}`);
          if (!neighbors) continue;
          for (const q of neighbors) {
            if (assigned.has(q.record.id)) continue;
            if (Math.hypot(p.x - q.x, p.y - q.y) <= WAE_CLUSTER_PIXEL_RADIUS) {
              group.push(q);
              assigned.add(q.record.id);
            }
          }
        }
      }
      clusters.push({
        recordIds: group.map((g) => g.record.id).sort(),
        records: group.map((g) => g.record),
        lat: group.reduce((s, g) => s + g.record.latitude, 0) / group.length,
        lng: group.reduce((s, g) => s + g.record.longitude, 0) / group.length,
      });
    }
    return clusters;
  }

  function waeClusterKey(cluster) {
    return cluster.recordIds.join(',');
  }

  // Feature request: a "date of last interaction" appended after a ticket
  // number, in both InfoWindow flavors below and the side-panel's own
  // ticket-number line (waeStartSidePanelDetailsWatcher()) -- one shared
  // helper so all three surfaces format the exact same timestamp the
  // exact same way, reusing waeFormatLastResponse() (the main table's own
  // "Last Response" column formatter, defined further down this file)
  // rather than re-deriving short/full date strings a second way. Returns
  // null for a ticket with no parseable date, same "blank rather than
  // guess" convention waeFormatLastResponse() itself already follows.
  function waeFormatTicketDateSuffix(lastResponseAt) {
    const lr = waeFormatLastResponse(lastResponseAt);
    if (!lr) return null;
    return { text: ` \u2014 ${escapeHtml(lr.short)}`, title: escapeHtml(lr.full) };
  }

  function waeShowPulseInfoWindow(record, latLng) {
    if (typeof google === 'undefined' || !google.maps?.InfoWindow || !WAE_PULSES.map) return;
    if (!WAE_PULSES.infoWindow) WAE_PULSES.infoWindow = new google.maps.InfoWindow();
    const name = escapeHtml(record.wayspotName || '(unnamed report)');
    const parts = [`<div style="font-size:12px;max-width:260px;"><strong>${name}</strong>`];
    parts.push(`<div>${latLng.lat().toFixed(6)}, ${latLng.lng().toFixed(6)}</div>`);
    if (record.comment) parts.push(`<div style="margin-top:4px;color:#6b7280;word-break:break-all;">${escapeHtml(record.comment)}</div>`);
    if (record.conversationId) {
      const dateSuffix = waeFormatTicketDateSuffix(record.lastResponseAt);
      const titleAttr = dateSuffix ? ` title="${dateSuffix.title}"` : '';
      parts.push(`<div style="margin-top:4px;color:#9ca3af;"${titleAttr}>Ticket ${escapeHtml(record.conversationId)}${dateSuffix ? dateSuffix.text : ''}</div>`);
    }
    parts.push('</div>');
    WAE_PULSES.infoWindow.setContent(parts.join(''));
    WAE_PULSES.infoWindow.setPosition(latLng);
    WAE_PULSES.infoWindow.open(WAE_PULSES.map);
  }

  // Feature request (not upstream): shown instead of waeShowPulseInfoWindow()
  // when _handleClick() (WaePulseOverlayCtor, above) finds a cluster it
  // can't zoom-and-split any further -- see that call site's own comment.
  // A plain list of tickets, one per record, is deliberately as far as
  // this goes: these records still can't be individually clicked on the
  // map itself (there's no way to give two same-pixel crosses separate
  // hit targets), so this exists purely to make the tickets themselves
  // visible/copyable, not to reproduce the single-record popup's full
  // detail (comment text, etc.) for every record at once.
  // 'ticket' falls back to sourceEmailId, same as every other "what do
  // we call this record" spot in the file (waeFindNearbyDuplicates()'s
  // own list, the main table's export column, etc.) -- some records
  // never got a real conversationId (see this file's own conversationId/
  // sourceEmailId history) and still need *something* shown here.
  function waeShowPulseClusterInfoWindow(cluster, latLng) {
    if (typeof google === 'undefined' || !google.maps?.InfoWindow || !WAE_PULSES.map) return;
    if (!WAE_PULSES.infoWindow) WAE_PULSES.infoWindow = new google.maps.InfoWindow();
    const parts = [`<div style="font-size:12px;max-width:280px;"><strong>${cluster.records.length} reports at this location</strong>`];
    parts.push(`<div>${latLng.lat().toFixed(6)}, ${latLng.lng().toFixed(6)}</div>`);
    parts.push('<ul style="margin:6px 0 0;padding-left:16px;">');
    for (const record of cluster.records) {
      const ticket = record.conversationId || record.sourceEmailId || '(no ticket)';
      const name = escapeHtml(record.wayspotName || '(unnamed report)');
      const dateSuffix = waeFormatTicketDateSuffix(record.lastResponseAt);
      const titleAttr = dateSuffix ? ` title="${dateSuffix.title}"` : '';
      parts.push(`<li style="margin-bottom:2px;"${titleAttr}>${escapeHtml(String(ticket))} \u2014 ${name}${dateSuffix ? dateSuffix.text : ''}</li>`);
    }
    parts.push('</ul></div>');
    WAE_PULSES.infoWindow.setContent(parts.join(''));
    WAE_PULSES.infoWindow.setPosition(latLng);
    WAE_PULSES.infoWindow.open(WAE_PULSES.map);
  }

  function waeClearPulses() {
    for (const overlay of WAE_PULSES.markersById.values()) {
      try { overlay.setMap(null); } catch (e) { /* ignore */ }
    }
    WAE_PULSES.markersById.clear();
    if (WAE_PULSES.infoWindow) WAE_PULSES.infoWindow.close();
  }

  // Review-page counterparts of the two functions just above -- same
  // body, WAE_REVIEW_PULSES instead of WAE_PULSES. See WAE_REVIEW_PULSES'
  // own comment for why this stays a parallel copy rather than a shared,
  // parameterized function.
  function waeShowReviewPulseInfoWindow(record, latLng) {
    if (typeof google === 'undefined' || !google.maps?.InfoWindow || !WAE_REVIEW_PULSES.map) return;
    if (!WAE_REVIEW_PULSES.infoWindow) WAE_REVIEW_PULSES.infoWindow = new google.maps.InfoWindow();
    const name = escapeHtml(record.wayspotName || '(unnamed report)');
    const parts = [`<div style="font-size:12px;max-width:260px;"><strong>${name}</strong>`];
    parts.push(`<div>${latLng.lat().toFixed(6)}, ${latLng.lng().toFixed(6)}</div>`);
    if (record.comment) parts.push(`<div style="margin-top:4px;color:#6b7280;word-break:break-all;">${escapeHtml(record.comment)}</div>`);
    if (record.conversationId) {
      const dateSuffix = waeFormatTicketDateSuffix(record.lastResponseAt);
      const titleAttr = dateSuffix ? ` title="${dateSuffix.title}"` : '';
      parts.push(`<div style="margin-top:4px;color:#9ca3af;"${titleAttr}>Ticket ${escapeHtml(record.conversationId)}${dateSuffix ? dateSuffix.text : ''}</div>`);
    }
    parts.push('</div>');
    WAE_REVIEW_PULSES.infoWindow.setContent(parts.join(''));
    WAE_REVIEW_PULSES.infoWindow.setPosition(latLng);
    WAE_REVIEW_PULSES.infoWindow.open(WAE_REVIEW_PULSES.map);
  }

  function waeClearReviewPulses() {
    for (const overlay of WAE_REVIEW_PULSES.markersById.values()) {
      try { overlay.setMap(null); } catch (e) { /* ignore */ }
    }
    WAE_REVIEW_PULSES.markersById.clear();
    if (WAE_REVIEW_PULSES.infoWindow) WAE_REVIEW_PULSES.infoWindow.close();
    waeClearReviewDraftMarkers(); // v1.65.1: toggle Off, map detached, route left -- the draft markers go with them
  }

  function waeClearReviewDraftMarkers() {
    for (const overlay of WAE_REVIEW_PULSES.draftsById.values()) {
      try { overlay.setMap(null); } catch (e) { /* ignore */ }
    }
    WAE_REVIEW_PULSES.draftsById.clear();
  }

  // v1.65.1: the Marked Wayspots (abuse draft) on the review map, drawn
  // with the report markers' own overlay class (see setDraftItem() in
  // WaeReviewPulseOverlayCtor) so they render the same way, and on the
  // same switch: the "Abuse report markers" toggle under the map. Never
  // throws -- it runs right after the report markers are drawn (see
  // waeRefreshReviewPulses()) and on every draft list change (see
  // waeRenderMarkedWayspotMarkers()), and a problem here must not be able
  // to get in the way of either.
  function waeRenderReviewDraftMarkers() {
    try {
      const map = WAE_REVIEW_PULSES.map;
      const drafts = WAE_REVIEW_PULSES.draftsById;
      if (!map || !waeReviewPulsesEnabled() || !waeEnsureReviewPulseOverlayCtor()) {
        waeClearReviewDraftMarkers();
        return;
      }
      const color = waeLoadAppearance().markColor;
      const seen = new Set();
      for (const item of waeLoadMarkedWayspots()) {
        if (!Number.isFinite(item.lat) || !Number.isFinite(item.lng)) continue;
        seen.add(item.id);
        try {
          let overlay = drafts.get(item.id);
          if (!overlay) {
            overlay = new WaeReviewPulseOverlayCtor();
            drafts.set(item.id, overlay);
          }
          overlay.setDraftItem(item, color);
          overlay.setMap(map);
        } catch (e) {
          console.warn('[Wayfarer Map Mods - Abuse Reports] Skipped rendering one review draft marker:', e);
        }
      }
      for (const [id, overlay] of drafts) {
        if (!seen.has(id)) {
          try { overlay.setMap(null); } catch (e) { /* ignore */ }
          drafts.delete(id);
        }
      }
    } catch (e) {
      console.warn('[Wayfarer Map Mods - Abuse Reports] Review draft marker refresh failed:', e);
    }
  }

  // BUGFIX (not upstream, feature request): this used to hide crosses
  // below zoom level 8 on the general mapview (still zoom-gated, per a
  // now-removed comment, to avoid a fully zoomed-out view trying to show
  // every marker/cluster at once) -- reported as "no markers show from
  // zoom 1 through 8, they should render at every zoom level up to and
  // including the highest one." Crosses/clusters now always show
  // regardless of zoom, on every surface -- matching how the
  // submit-Wayspot page already behaved (see v1.26.0/v1.33.0's own
  // history with that page for why zoom-gating there specifically was
  // already recognized as wrong). Clustering (see waeComputeClusters())
  // still keeps a fully zoomed-out view from turning into hundreds of
  // individual markers -- nearby reports still collapse into one circle
  // with a count, this just stopped hiding that circle outright below a
  // fixed zoom.
  //
  // WAE_MIN_SHOW_ZOOM itself stays -- waeGetClusterSvgMarkup()'s "expand
  // at the lowest zoom level" behavior (see WAE_CLUSTER_EXPAND_FACTOR)
  // still needs a reference floor to compare the current zoom against,
  // it just no longer doubles as a visibility cutoff.
  const WAE_MIN_SHOW_ZOOM = 8;
  function waeShouldShowPulses() {
    return true;
  }

  // Rebuilds the marker set from whatever's currently in waeAllRecords --
  // NOT from IndexedDB (see v1.13.0 changelog note: that used to be the
  // actual cause of a different slowdown, fixed by reading from this
  // already-fetched cache instead). Clusters nearby records together at
  // the current zoom (see v1.19.0 changelog note) rather than rendering
  // one marker per record unconditionally -- that was the remaining
  // performance ceiling once a real dataset grew into the hundreds, since
  // each individually-rendered Marker has real linear overhead
  // (positioning, event listeners) regardless of how cheap any one of
  // them is. Diffs cluster markers by a key derived from their sorted
  // member record ids, so re-running at the SAME zoom with the SAME data
  // (e.g. after a scan that didn't change anything) doesn't recreate
  // markers needlessly -- only a genuine zoom change or data change does.
  // BUGFIX (not upstream): even after the zoom-debounce and cached-
  // projection fixes (v1.29.0), zoom could still be slow with a large
  // dataset -- every recompute was still clustering/diffing markers for
  // EVERY record with coordinates, worldwide, regardless of how small a
  // slice of the map was actually visible. Zoomed into one city out of a
  // dataset covering a whole country, that's still full-dataset work for
  // a screen that can only ever show a city's worth of it. Padding
  // (WAE_VIEWPORT_PAD_FACTOR, 75% of the viewport's own span in each
  // direction) means panning a little doesn't immediately show a blank
  // gap at the edge while markers there catch up on the next idle --
  // there's already a one-recompute-per-settle delay from the debounce,
  // so a modest buffer around the visible area smooths that over.
  // Longitude wraparound at the antimeridian isn't handled (a plain
  // west<=lng<=east range check, which breaks if the view happens to
  // straddle it) -- a real gap, but one shared with the existing nearby-
  // duplicate grid-bucketing's own simplifications, and not worth the
  // extra complexity for how rarely an abuse report near the date line
  // would come up in practice.
  const WAE_VIEWPORT_PAD_FACTOR = 0.75;
  function waeGetPaddedBounds(map) {
    const bounds = map.getBounds?.();
    if (!bounds) return null; // no bounds yet (e.g. map not fully idle) -- caller should render everything rather than wrongly show nothing
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const latPad = (ne.lat() - sw.lat()) * WAE_VIEWPORT_PAD_FACTOR;
    const lngPad = (ne.lng() - sw.lng()) * WAE_VIEWPORT_PAD_FACTOR;
    return { north: ne.lat() + latPad, south: sw.lat() - latPad, east: ne.lng() + lngPad, west: sw.lng() - lngPad };
  }
  function waeWithinPaddedBounds(record, padded) {
    if (!padded) return true;
    return record.latitude >= padded.south && record.latitude <= padded.north
      && record.longitude >= padded.west && record.longitude <= padded.east;
  }

  function waeRefreshPulses() {
    const map = WAE_PULSES.map;
    // No local staleness check needed anymore -- WFMM.map.onCleared()
    // (see waeStartMapTracking()) already nulls WAE_PULSES.map out the
    // moment the suite's own map service considers it gone, so a non-null
    // value here can be trusted without re-checking it ourselves.
    if (!map) return;
    if (typeof google === 'undefined' || !google.maps?.OverlayView) return;
    if (!waeEnsurePulseOverlayCtor()) return;

    // BUGFIX (not upstream): this function never checked whether the
    // "Abuse Report Crosses" layer was actually enabled -- only whether
    // a map existed and waeShouldShowPulses() allowed it.
    // waeApplyLayerEnabled(false) calls waeClearPulses() exactly once
    // when the checkbox is switched off, but the debounced 'idle'
    // listener set up in waeSetCurrentMap() stays attached to the map
    // for its whole lifetime regardless -- so the very next zoom (or
    // pan) fired this function again, which happily rebuilt every
    // marker with no idea the layer had been turned off, undoing the
    // toggle. Bailing out (and clearing anything that snuck back before
    // this check existed) whenever the layer is off makes every
    // automatic refresh respect the current on/off state, not just the
    // one that fires at the moment of the toggle itself.
    if (!isMapPulsesEnabled()) {
      waeClearPulses();
      return;
    }

    if (!waeShouldShowPulses(map, WAE_PULSES.surface)) {
      waeClearPulses();
      return;
    }

    const paddedBounds = waeGetPaddedBounds(map);
    const wanted = waeAllRecords.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && waeWithinPaddedBounds(r, paddedBounds));
    const clusters = waeComputeClusters(map, wanted);
    const wantedKeys = new Set(clusters.map(waeClusterKey));
    const appearance = waeLoadAppearance();
    // Floor()'d since Google Maps allows fractional zoom (smooth
    // scroll-zoom) -- without this, a cluster mid-transition at e.g.
    // 8.6 would flip in and out of "expanded" on every fractional tick
    // rather than settling once it's genuinely left the lowest whole
    // zoom level.
    const isLowestZoom = Math.floor(map.getZoom() ?? WAE_MIN_SHOW_ZOOM) <= WAE_MIN_SHOW_ZOOM;

    for (const [key, overlay] of WAE_PULSES.markersById.entries()) {
      if (!wantedKeys.has(key)) {
        try { overlay.setMap(null); } catch (e) { /* ignore */ }
        WAE_PULSES.markersById.delete(key);
      }
    }

    // BUGFIX (not upstream): this loop used to run with no error handling
    // at all -- if any single cluster's position/icon/etc call threw
    // (e.g. a still-non-finite lat/lng that slipped past the filter in
    // waeComputeClusters(), or any other one-off marker API hiccup), the
    // exception aborted the WHOLE refresh right here, after the removal
    // loop above had already cleared out markers no longer wanted --
    // leaving the layer visibly empty (or half-updated) with nothing
    // left to re-trigger a retry until the next zoom/pan (or the Layers
    // checkbox, toggled off then back on, which calls this function
    // directly outside the debounce). Isolating each cluster in its own
    // try/catch means one bad cluster gets skipped -- and picked back up
    // on the very next recompute, once whatever made it transiently bad
    // has passed -- instead of taking every other cluster's marker down
    // with it.
    for (const cluster of clusters) {
      if (!Number.isFinite(cluster.lat) || !Number.isFinite(cluster.lng)) continue;
      try {
        const key = waeClusterKey(cluster);
        let overlay = WAE_PULSES.markersById.get(key);
        if (!overlay) {
          overlay = new WaePulseOverlayCtor();
          WAE_PULSES.markersById.set(key, overlay);
        }
        overlay.setCluster(cluster, isLowestZoom, appearance);
        overlay.setMap(map);
      } catch (e) {
        console.warn('[Wayfarer Map Mods - Abuse Reports] Skipped rendering one cluster:', e);
      }
    }
  }

  // Review-page counterpart of waeRefreshPulses() above -- same
  // filter/cluster/diff logic (waeGetPaddedBounds()/waeWithinPaddedBounds()/
  // waeComputeClusters()/waeClusterKey() are all already generic, just
  // take a map + records and hand back plain data, so they're reused
  // as-is here), just reading/writing WAE_REVIEW_PULSES and gated on the
  // review toggle (waeReviewPulsesEnabled(), see the "Review page
  // support" section) instead of isMapPulsesEnabled()/WFMM.layers --
  // this surface's on/off state is deliberately its own thing, never
  // wired through WFMM.layers, so it can never touch the Settings
  // side-panel list the way WAE_LAYER_ID does.
  function waeRefreshReviewPulses() {
    const map = WAE_REVIEW_PULSES.map;
    if (!map) return;
    if (!waeReviewPulsesEnabled()) {
      waeClearReviewPulses();
      return;
    }
    if (!waeEnsureReviewPulseOverlayCtor()) return;

    const paddedBounds = waeGetPaddedBounds(map);
    const wanted = waeAllRecords.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && waeWithinPaddedBounds(r, paddedBounds));
    const clusters = waeComputeClusters(map, wanted);
    const wantedKeys = new Set(clusters.map(waeClusterKey));
    const appearance = waeLoadAppearance();
    const isLowestZoom = Math.floor(map.getZoom() ?? WAE_MIN_SHOW_ZOOM) <= WAE_MIN_SHOW_ZOOM;

    for (const [key, overlay] of WAE_REVIEW_PULSES.markersById.entries()) {
      if (!wantedKeys.has(key)) {
        try { overlay.setMap(null); } catch (e) { /* ignore */ }
        WAE_REVIEW_PULSES.markersById.delete(key);
      }
    }

    for (const cluster of clusters) {
      if (!Number.isFinite(cluster.lat) || !Number.isFinite(cluster.lng)) continue;
      try {
        const key = waeClusterKey(cluster);
        let overlay = WAE_REVIEW_PULSES.markersById.get(key);
        if (!overlay) {
          overlay = new WaeReviewPulseOverlayCtor();
          WAE_REVIEW_PULSES.markersById.set(key, overlay);
        }
        overlay.setCluster(cluster, isLowestZoom, appearance);
        overlay.setMap(map);
      } catch (e) {
        console.warn('[Wayfarer Map Mods - Abuse Reports] Skipped rendering one review cluster:', e);
      }
    }
    waeRenderReviewDraftMarkers(); // v1.65.1: last, so the report markers above never depend on it
  }

  // Same 'projection_changed' wait as waeSafeRefreshPulses() above, for
  // the exact same reason -- see that function's own comment. The
  // review-page map is attached later, and typically already idle by
  // the time waeSetReviewMap() runs (it's found via DOM search, not an
  // onReady-style event), so this race is if anything more likely here,
  // not less.
  function waeSafeRefreshReviewPulses() {
    const map = WAE_REVIEW_PULSES.map;
    if (map && typeof google !== 'undefined' && google.maps?.event && !map.getProjection()) {
      google.maps.event.addListenerOnce(map, 'projection_changed', () => {
        if (WAE_REVIEW_PULSES.map === map) waeSafeRefreshReviewPulses();
      });
      return;
    }
    try {
      waeRefreshReviewPulses();
    } catch (e) {
      console.warn('[Wayfarer Map Mods - Abuse Reports] Review pulse refresh failed, retrying shortly:', e);
      setTimeout(() => {
        try { waeRefreshReviewPulses(); } catch (e2) { /* give up quietly -- next idle/search will try again */ }
      }, WAE_ZOOM_DEBOUNCE_MS);
    }
  }

  // Shared by waeAttachToMapIfNeeded() (on-demand) and the WFMM.map.onReady()
  // subscription below (passive/event-driven) -- both need to react the
  // same way to "the map WFMM.map handed us is a different object than
  // what we had", so it's one place rather than two copies that could
  // drift out of sync with each other.
  // BUGFIX (not upstream): zoom_changed was recomputing clusters (a full
  // re-projection + grid-bucket pass over every record, see
  // waeComputeClusters()) SYNCHRONOUSLY on every single firing, with no
  // debounce at all -- and Google Maps fires zoom_changed once per
  // discrete zoom level, not once per gesture, so a fast scroll-wheel
  // zoom through several levels (or a double-click zoom, which animates
  // through intermediate levels on its own) could trigger several of
  // these expensive synchronous recomputes back to back, each one
  // blocking the main thread while the map itself is trying to animate
  // -- reported as "zooming becomes very slow while markers are
  // rendered". Debounced now (waeZoomDebounceMs, trailing-edge -- only
  // the LAST zoom level in a fast sequence actually triggers a
  // recompute, not every intermediate one) and moved off zoom_changed
  // onto idle, which fires once after the map has actually settled
  // (covers pans too, not just zooms, but idle only fires once per
  // gesture regardless, so that's a single redundant recompute on a pure
  // pan at worst, not a pileup of them) -- see waeComputeClusters()'s own
  // comment for the other half of this fix (caching each record's
  // projected position, which zoom itself never actually changes).
  const WAE_ZOOM_DEBOUNCE_MS = 200;
  // BUGFIX (not upstream): only the debounced 'idle' handler below used
  // to have any error handling around waeRefreshPulses() -- every OTHER
  // caller (the initial WFMM.map.onReady() render, waeResyncMapIfVisible()
  // at bootstrap, waeApplyLayerEnabled()'s toggle-on path, and a live
  // appearance-color redraw) called it raw. Reported as "the crosses
  // sometimes don't load when you open the map, but do appear once you
  // click an abuse report": the map's projection/bounds are least likely
  // to be fully settled at the exact moment it first reports itself
  // ready, which is precisely when these load-time callers run -- if
  // that transient state made waeRefreshPulses() throw (see
  // waeComputeClusters()'s own comment on non-finite projected points),
  // the exception had nowhere to go on these paths, and nothing else
  // re-triggers a refresh until the map's own 'idle' event fires from an
  // actual interaction -- e.g. clicking a report, which recenters/zooms
  // the map and lands on the one path that WAS already protected.
  // Pulling that retry logic out into this one shared helper, and
  // routing every caller through it instead of the raw function, gives
  // all of them the same resilience the idle path already had.
  // BUGFIX (not upstream): reported as "the initial render shows every
  // record as its own individual cross, then a moment later reclusters
  // into groups" -- waeComputeClusters() deliberately falls back to
  // "every record is its own cluster" whenever map.getProjection() isn't
  // available yet (see that function's own comment: that fallback exists
  // for a DIFFERENT, more serious failure mode -- without SOME result
  // there, a still-unready projection used to throw and leave the whole
  // layer empty). The three callers that draw immediately after first
  // attaching to a map (WFMM.map.onReady() in waeStartMapTracking(),
  // waeApplyLayerEnabled()'s toggle-on path, and waeResyncMapIfVisible()
  // at bootstrap) can all run before Google Maps has actually finished
  // setting up that map's projection -- which is exactly the visible
  // "unclustered flash before it settles" being reported, now that the
  // actual THROW this fallback was originally written for is already
  // handled elsewhere (see this function's own try/catch below). Waiting
  // here for 'projection_changed' -- a one-time event that fires the
  // moment a map's projection becomes available -- means the very first
  // draw after attaching always has a real projection to cluster
  // against, so waeComputeClusters()'s fallback is only ever reached for
  // a genuinely transient hiccup mid-session, not as the normal outcome
  // of every fresh page load. Deliberately NOT 'idle' (used elsewhere in
  // this file for the same "wait for the map to be ready" purpose): idle
  // only fires once a full pan/zoom gesture settles, and if the map had
  // ALREADY idled once before this particular call happened to run, nothing
  // guarantees it'll ever fire again on its own -- 'projection_changed'
  // fires exactly once, unconditionally, the moment the projection first
  // becomes available, regardless of the map's idle history.
  function waeSafeRefreshPulses() {
    const map = WAE_PULSES.map;
    if (map && typeof google !== 'undefined' && google.maps?.event && !map.getProjection()) {
      google.maps.event.addListenerOnce(map, 'projection_changed', () => {
        if (WAE_PULSES.map === map) waeSafeRefreshPulses();
      });
      return;
    }
    try {
      waeRefreshPulses();
    } catch (e) {
      console.warn('[Wayfarer Map Mods - Abuse Reports] Pulse refresh failed, retrying shortly:', e);
      setTimeout(() => {
        try { waeRefreshPulses(); } catch (e2) { /* give up quietly -- next real map interaction will try again */ }
      }, WAE_ZOOM_DEBOUNCE_MS);
    }
  }
  // BUGFIX (not upstream): this 'idle' listener is the ONLY thing that
  // keeps the crosses in sync with the map after the initial attach --
  // WFMM.map.refresh()'s own fast path (confirmed against the real
  // source) returns without re-emitting "map:ready" whenever the map is
  // still valid, so nothing else here re-fires on an ordinary zoom/pan.
  // That made this the single point of failure behind "crosses vanish on
  // a zoom change and only come back after toggling the layer off/on":
  // waeRefreshPulses() used to have no error handling at all, so if it
  // threw for any reason on a given settle (a transient bad projection
  // value right as the zoom gesture stopped -- see waeComputeClusters()'s
  // own comment), the exception was swallowed by the browser as an
  // uncaught error inside this setTimeout callback, and nothing else
  // would call waeRefreshPulses() again until the NEXT zoom/pan (or the
  // Layers checkbox, which calls it directly). If that failed settle
  // happened to be the last one in the gesture -- i.e. the user stopped
  // zooming right there -- the layer just stayed empty. Now: (1)
  // waeRefreshPulses() itself no longer lets one bad cluster take the
  // whole redraw down (see its own comment), and (2) waeSafeRefreshPulses()
  // above catches anything that still gets through and retries once,
  // shortly after, instead of leaving the layer to rot until another map
  // interaction happens to come along.
  function waeSetCurrentMap(map, surface) {
    if (WAE_PULSES.map === map) return;
    waeClearPulses();
    // Marked Wayspots' own dots (waeMarkMarkerOverlays) are OverlayView
    // instances tied to the OLD map instance -- torn down and redrawn on
    // the new one below, same reasoning as waeClearPulses() just above
    // for the abuse-report crosses/clusters.
    waeClearMarkedWayspotMarkers();
    WAE_PULSES.map = map;
    WAE_PULSES.surface = map ? (surface || null) : null;
    if (map) {
      let debounceTimer = null;
      map.addListener?.('idle', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(waeSafeRefreshPulses, WAE_ZOOM_DEBOUNCE_MS);
      });
      waeRenderMarkedWayspotMarkers();
    }
  }

  async function waeAttachToMapIfNeeded() {
    const map = await wfmmWindow.WFMM.map.refresh({ reason: 'wae-attach' });
    if (!map) return false;
    // refresh() only ever returns the bare google.maps.Map object, not
    // the surrounding context WFMM.map itself tracks (route/surface/
    // adapter/etc) -- getContext() is a separate call for that, and it's
    // safe to call right after refresh() resolves since refresh() is
    // what sets it in the first place.
    const context = wfmmWindow.WFMM.map.getContext?.();
    waeSetCurrentMap(map, context?.surface);
    return true;
  }

  // WFMM.map.onReady()/onCleared() (subscribed once in startPlugin(), see
  // that function) keep WAE_PULSES.map in sync automatically -- including
  // across a mapview<->submit-new switch, since that's a different
  // underlying google.maps.Map object each time and a Marker only ever
  // renders on the one it was created against. But WFMM.map only actually
  // SEARCHES when something calls .refresh() -- nothing in the suite's
  // own core does that automatically on every navigation, it's genuinely
  // each plugin's job to ask when it cares -- so onEnterMapRoute()/
  // onChangeMapRoute() below are what actually trigger a fresh refresh()
  // call at the moment it'd matter (landing on, or switching between,
  // mapview/submit-new), which onReady above then reacts to.
  let waeMapReadyUnsub = null;
  let waeMapClearedUnsub = null;
  let waeRouteEnterUnsub = null;
  let waeRouteChangeUnsub = null;
  // BUGFIX (not upstream): "Show on Map" left toggled on from a previous
  // session didn't reliably re-show its markers on a fresh page load --
  // needed a manual toggle off/on to actually appear. Root cause: this
  // plugin now runs at document-start (see the header's own v1.26.1
  // changelog note), so waeResyncMapIfVisible()'s very first
  // WFMM.map.refresh() call can genuinely race ahead of Angular/Google
  // Maps finishing initialization -- confirmed against the real source
  // (src/core/map/service.js): refresh() already retries internally (80
  // attempts, 250ms apart, ~20s total) before giving up and emitting
  // "map:not-found", but nothing retries again after that -- another
  // .refresh() call only ever happens from a route change or another
  // explicit call, neither of which happens on a page you're already on
  // when it finishes loading. A slow-loading page could exhaust that
  // whole 20s window before its map component ever renders, and from
  // then on the single failed search was just the end of it. Toggling
  // the button off and on again worked purely because that's a SECOND,
  // later .refresh() call, made after the map had had more time to
  // actually appear -- not because anything about the toggle itself
  // mattered. Retrying automatically here removes the need for that.
  let waeMapNotFoundUnsub = null;
  let waeMapRetryTimer = null;
  let waeMapRetriesLeft = 0;
  // Only armed for the two silent/background triggers below (the initial
  // resync at startup, and a route change) -- deliberately NOT armed for
  // an explicit toggle (the native Layers menu checkbox, the only way to
  // turn this on now -- see WAE_LAYER_ID's own comment), which already
  // gets its own clear, immediate error message on failure via
  // waeApplyLayerEnabled(); layering a delayed silent retry underneath
  // that too would risk that error already having shown while pulses
  // then quietly appear anyway a few seconds later, which reads as more
  // confusing than just letting the user flip the checkbox again
  // themselves as their own cheap retry.
  const WAE_MAP_RETRY_LIMIT = 3;
  // BUGFIX (not upstream): abuse crosses still weren't showing up
  // reliably on the submit-Wayspot page specifically, even after the
  // route-level fixes above -- reported as "inconsistent" rather than
  // "never", which pointed at something route-level tracking wouldn't
  // catch. Likely explanation (not confirmed against Base's own source,
  // since this needs live testing on the actual submit flow to fully
  // verify): unlike the general mapview, /new/submit/new is ONE route
  // start to finish -- picking a location, confirming it, moving between
  // whatever internal steps that flow has -- and if the underlying
  // google.maps.Map object gets torn down and recreated as part of that
  // (rather than staying the same instance for the route's whole
  // lifetime), nothing here would ever notice: onEnterMapRoute/
  // onChangeMapRoute only fire on an actual ROUTE change, and this
  // plugin's own map:not-found retry above only fires from a failed
  // SEARCH, not from an already-attached map silently going stale under
  // it. A periodic safety-net refresh() call, gated on pulses actually
  // being on, covers this regardless of the exact internal cause --
  // refresh()'s own fast path (the currently-attached map is still
  // valid) is just a staleness check against a cached value, so this
  // costs essentially nothing on every tick where nothing's actually
  // changed, and only does real work (a fresh search, then onReady above
  // picking up the result) on the tick where it turns out something did.
  const WAE_MAP_PERIODIC_RECHECK_MS = 5000;
  let waeMapPeriodicRecheckTimer = null;

  function waeStartMapTracking() {
    if (waeMapReadyUnsub) return; // already subscribed
    const WFMM = wfmmWindow.WFMM;
    waeMapReadyUnsub = WFMM.map.onReady(({ map, context }) => {
      waeMapRetriesLeft = 0; // a real map showed up -- nothing left to retry
      waeSetCurrentMap(map, context?.surface);
      if (isMapPulsesEnabled()) waeSafeRefreshPulses();
    });
    waeMapClearedUnsub = WFMM.map.onCleared(() => {
      WAE_PULSES.map = null;
      WAE_PULSES.surface = null;
    });
    const onMapRouteEvent = () => {
      if (!isMapPulsesEnabled()) return;
      waeMapRetriesLeft = WAE_MAP_RETRY_LIMIT; // fresh route -> a fresh search that can itself race Angular/Maps, same as the startup case
      WFMM.map.refresh({ reason: 'wae-route-change' });
    };
    waeRouteEnterUnsub = WFMM.routes.onEnterMapRoute(onMapRouteEvent);
    waeRouteChangeUnsub = WFMM.routes.onChangeMapRoute(onMapRouteEvent);
    waeMapNotFoundUnsub = WFMM.events.on('map:not-found', () => {
      if (!isMapPulsesEnabled() || waeMapRetryTimer || waeMapRetriesLeft <= 0) return;
      waeMapRetriesLeft -= 1;
      waeMapRetryTimer = setTimeout(() => {
        waeMapRetryTimer = null;
        if (isMapPulsesEnabled()) WFMM.map.refresh({ reason: 'wae-retry-after-not-found' });
      }, 3000);
    });
    waeMapPeriodicRecheckTimer = setInterval(() => {
      if (isMapPulsesEnabled()) WFMM.map.refresh({ reason: 'wae-periodic-recheck' });
    }, WAE_MAP_PERIODIC_RECHECK_MS);
  }

  function waeStopMapTracking() {
    waeMapReadyUnsub?.();
    waeMapClearedUnsub?.();
    waeRouteEnterUnsub?.();
    waeRouteChangeUnsub?.();
    waeMapNotFoundUnsub?.();
    if (waeMapRetryTimer) { clearTimeout(waeMapRetryTimer); waeMapRetryTimer = null; }
    if (waeMapPeriodicRecheckTimer) { clearInterval(waeMapPeriodicRecheckTimer); waeMapPeriodicRecheckTimer = null; }
    waeMapReadyUnsub = null;
    waeMapClearedUnsub = null;
    waeRouteEnterUnsub = null;
    waeRouteChangeUnsub = null;
    waeMapNotFoundUnsub = null;
    waeMapRetriesLeft = 0;
  }

  // ---------------------------------------------------------------------
  // Review page (/new/review) support.
  //
  // Deliberately independent of everything above: WFMM.map/WAE_LAYER_ID/
  // WFMM.layers/attachSettingsActions() are never touched by anything in
  // this section, and nothing above ever touches WAE_REVIEW_PULSES or
  // WAE_REVIEW_TOGGLE_KEY either. That separation is the point, not an
  // accident -- an earlier attempt at review-page support (reverted in
  // v1.40.0, see that changelog entry) tangled review handling into the
  // same map/route tracking this plugin already used for mapview/submit,
  // and the "Abuse Report Extractor" entry disappearing from the Settings
  // side-panel list on every page load was never actually root-caused
  // before the whole feature was pulled. Keeping this surface's own
  // on/off state, map lookup, and UI entirely apart from that machinery
  // means review-page code literally cannot be what breaks the Settings
  // link this time, whatever else does or doesn't go wrong here -- and
  // it directly satisfies the actual requirement besides: this plugin's
  // tool panel and its Settings side-panel entry stay exclusive to the
  // mapview/submit pages, never on review, so review support gets its
  // OWN small toggle instead, rendered directly above the review page's
  // own map.
  //
  // Map discovery: WFMM.map / WFMM.routes.onEnterMapRoute() never fire
  // for review at all (Map Mods' own ROUTES table marks "review" as
  // hasMap:false -- "WFMM does not currently interact with the review
  // duplicates map"), so there's no suite-provided map to ask for here.
  // Map Mods' OWN bundled review-map-enhancements plugin has to solve the
  // exact same problem internally (see createReviewMapController() in its
  // source) by querying the <nia-map> custom element Angular renders for
  // whichever review card is showing a map, then walking its
  // __ngContext__ (Angular's internal component-instance tree) looking
  // for something that looks like a real google.maps.Map -- but it only
  // exposes getSettings()/renderSettingsSection() on WFMM.reviewMapEnhancements,
  // not the map instance itself, so external plugins can't reuse it
  // directly. waeFindReviewMapOnce() below is this plugin's own from-
  // scratch version of that same technique (the file used to have a
  // comparable hand-rolled __ngContext__ reflection for mapview/submit
  // too, before WFMM.map replaced it in v1.26.0 -- see that changelog
  // entry) -- deliberately NOT narrowed to one specific review mode
  // (duplicates-check vs edit-location vs edit-info vs photo): it just
  // checks every <nia-map> currently in the DOM and uses whichever one
  // actually yields a map object, which is simpler and more robust to
  // Wayfarer's own markup changing than mirroring Map Mods' own mode
  // branching would be, at the cost of harmlessly checking one or two
  // extra elements when only one is really present.
  const WAE_REVIEW_TOGGLE_KEY = 'wae_review_pulses_visible';
  // The list icon on the Abuse Reports panel's header, and (v1.69.0) the
  // same one on the toggle bar under the review map -- both open the
  // Marked Wayspots list (waeOpenMarkedWayspotListModal()).
  const WAE_LIST_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>';
  const WAE_REVIEW_TOGGLE_ID = 'wae-review-toggle-bar';
  const WAE_REVIEW_TOGGLE_WRAP_ID = 'wae-review-toggle-wrap';
  // Defaults ON (unlike WAE_LAYER_ID's mapview/submit crosses, which
  // default off via the native Layers menu) -- this is the one thing the
  // whole feature exists to show, and it's opt-OUT via the toggle bar
  // right above the map rather than opt-in via a menu the reviewer would
  // have to already know to look for.
  function waeReviewPulsesEnabled() {
    return localStorage.getItem(WAE_REVIEW_TOGGLE_KEY) !== 'false';
  }
  function waeSetReviewPulsesEnabled(enabled) {
    localStorage.setItem(WAE_REVIEW_TOGGLE_KEY, enabled ? 'true' : 'false');
  }

  function waeReviewLooksLikeGoogleMap(value) {
    return !!value && typeof value === 'object'
      && typeof value.getDiv === 'function'
      && typeof value.getZoom === 'function'
      && typeof value.setCenter === 'function'
      && typeof value.getProjection === 'function'
      && typeof value.addListener === 'function';
  }

  // Bounded breadth-first walk of an Angular __ngContext__ array/object
  // tree looking for a value waeReviewLooksLikeGoogleMap() accepts.
  // maxDepth/maxItems keep this from ever doing unbounded work against
  // whatever unrelated component state happens to be reachable from the
  // same context -- matches the caution Map Mods' own equivalent
  // (findObjectDeep(), maxDepth 9 / maxItems 5000) takes for the same
  // reason. Explicitly refuses to descend into DOM nodes/Window (both
  // reachable from a component context, both huge and cyclic) since
  // neither can ever itself be the map object we're looking for.
  function waeReviewFindObjectDeep(root, predicate, { maxDepth = 9, maxItems = 5000 } = {}) {
    if (!root || typeof root !== 'object') return null;
    const seen = new Set();
    const queue = [[root, 0]];
    let visited = 0;
    while (queue.length) {
      const [node, depth] = queue.shift();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      visited += 1;
      if (visited > maxItems) return null;
      try {
        if (predicate(node)) return node;
      } catch (e) { /* a weird getter threw -- skip this node, keep walking */ }
      if (depth >= maxDepth) continue;
      if ((typeof Node !== 'undefined' && node instanceof Node) || (typeof Window !== 'undefined' && node instanceof Window)) continue;
      let keys;
      try { keys = Object.keys(node); } catch (e) { continue; }
      for (const key of keys) {
        let val;
        try { val = node[key]; } catch (e) { continue; } // some Angular/Maps getters throw outside their normal call context
        if (val && typeof val === 'object') queue.push([val, depth + 1]);
      }
    }
    return null;
  }

  function waeFindReviewMapHosts() {
    return Array.from(document.querySelectorAll('nia-map'));
  }

  function waeFindReviewMapOnce() {
    for (const host of waeFindReviewMapHosts()) {
      const ctx = host.__ngContext__;
      if (!ctx) continue;
      const map = waeReviewFindObjectDeep(ctx, waeReviewLooksLikeGoogleMap, { maxDepth: 9, maxItems: 5000 });
      if (map) return { map, host };
    }
    return null;
  }

  // Polling search, same shape as Map Mods' own review-map-enhancements
  // scheduleFind()/tryFind() (80 attempts * 250ms = 20s ceiling) --
  // Angular doesn't emit anything this plugin can listen for the moment
  // its map component finishes constructing, so a short poll after
  // entering/changing within the review route is the same approach the
  // suite's own equivalent feature already relies on.
  const WAE_REVIEW_MAP_SEARCH_INTERVAL_MS = 250;
  const WAE_REVIEW_MAP_SEARCH_MAX_ATTEMPTS = 80;
  let waeReviewMapSearchTimer = null;
  let waeReviewMapSearchAttempts = 0;
  // /new/review is a single route across every ticket a reviewer works
  // through, the same "one route, map swapped out underneath it"
  // situation v1.29.3 already had to add a periodic safety-net refresh
  // for on the submit-Wayspot page (see WAE_MAP_PERIODIC_RECHECK_MS
  // above) -- nothing here would otherwise notice the review map going
  // stale between one ticket and the next, since that's not a route
  // change and there's no WFMM.map staleness check backing this surface.
  // A cheap "is the attached map's own div still in the document"
  // check, polled the same way, covers it the same way.
  const WAE_REVIEW_PERIODIC_RECHECK_MS = 3000;
  let waeReviewPeriodicRecheckTimer = null;

  function waeReviewIsOnRoute() {
    return wfmmWindow.WFMM.routes.is('review');
  }

  function waeStopReviewMapSearch() {
    if (waeReviewMapSearchTimer) { clearTimeout(waeReviewMapSearchTimer); waeReviewMapSearchTimer = null; }
  }

  function waeScheduleReviewMapSearch() {
    if (waeReviewMapSearchTimer || WAE_REVIEW_PULSES.map) return;
    const tick = () => {
      waeReviewMapSearchTimer = null;
      if (!waeReviewIsOnRoute()) return; // left the review page before this fired
      const found = waeFindReviewMapOnce();
      if (found) {
        waeReviewMapSearchAttempts = 0;
        waeSetReviewMap(found.map, found.host);
        return;
      }
      waeReviewMapSearchAttempts += 1;
      if (waeReviewMapSearchAttempts < WAE_REVIEW_MAP_SEARCH_MAX_ATTEMPTS) {
        waeReviewMapSearchTimer = setTimeout(tick, WAE_REVIEW_MAP_SEARCH_INTERVAL_MS);
      }
    };
    waeReviewMapSearchTimer = setTimeout(tick, WAE_REVIEW_MAP_SEARCH_INTERVAL_MS);
  }

  function waeReviewMapStillValid() {
    const map = WAE_REVIEW_PULSES.map;
    if (!map) return false;
    try {
      const div = map.getDiv?.();
      return !!(div && div.isConnected);
    } catch (e) {
      return false;
    }
  }

  // Called from the panel's own scan/import/clear handlers (see
  // waeResyncMapIfVisible()'s call sites) alongside that function -- the
  // panel itself only ever shows on mapview/submit, but waeAllRecords is
  // a shared module-level cache, so a scan done there should be
  // reflected on the review map too if it's the one currently attached,
  // not just on the next incidental idle/pan. A no-op whenever no review
  // map is attached.
  function waeResyncReviewIfVisible() {
    if (WAE_REVIEW_PULSES.map) waeSafeRefreshReviewPulses();
  }

  // Doesn't reset waeReviewMapSearchAttempts here -- only
  // waeReviewOnRouteEnter does that, for a genuine fresh 20s burst on
  // actually entering the route. Leaving the counter alone means once a
  // burst exhausts itself (a review card with no map at all, e.g. a
  // report with no location), each subsequent periodic tick here does
  // exactly one more retry (waeScheduleReviewMapSearch() no-ops while a
  // search is already in flight, and a single retry from an exhausted
  // counter doesn't re-arm a whole new 80-attempt burst) rather than
  // resetting the counter and re-triggering a fresh 20-second busy-poll
  // burst every single 3-second tick forever.
  function waeReviewPeriodicRecheck() {
    if (!waeReviewIsOnRoute()) return;
    if (!waeReviewMapStillValid()) {
      waeSetReviewMap(null, null);
      waeScheduleReviewMapSearch();
    }
  }

  let waeReviewMapIdleListener = null;
  let waeReviewIdleDebounceTimer = null;

  function waeSetReviewMap(map, host) {
    if (WAE_REVIEW_PULSES.map === map) {
      if (map && host) waeInjectReviewToggle(host); // same map, host element got re-rendered -- keep the toggle bar anchored to it
      return;
    }
    waeClearReviewPulses();
    if (waeReviewMapIdleListener) {
      try { google.maps.event.removeListener(waeReviewMapIdleListener); } catch (e) { /* ignore */ }
      waeReviewMapIdleListener = null;
    }
    clearTimeout(waeReviewIdleDebounceTimer);
    WAE_REVIEW_PULSES.map = map;
    WAE_REVIEW_PULSES.host = host || null;
    if (map) {
      waeReviewMapIdleListener = map.addListener?.('idle', () => {
        clearTimeout(waeReviewIdleDebounceTimer);
        waeReviewIdleDebounceTimer = setTimeout(waeSafeRefreshReviewPulses, WAE_ZOOM_DEBOUNCE_MS);
      });
      waeInjectReviewToggle(host);
      // BUGFIX: see waeEnsureRecordsLoaded()'s own comment -- same fix as
      // waeApplyLayerEnabled()/waeResyncMapIfVisible(), applied here to
      // the review-page map-attach path. waeSetReviewMap() itself isn't
      // async (called from several synchronous call sites), so this is
      // fire-and-forget rather than awaited -- finally() (not then())
      // so a draw is still attempted even if the load failed, same
      // reasoning as those two functions' own .catch(() => {}).
      waeEnsureRecordsLoaded().finally(waeSafeRefreshReviewPulses);
    } else {
      waeRemoveReviewToggle();
    }
  }

  // Toggle bar embedded in the review page's own layout, directly below
  // whichever <nia-map> element the currently-attached review map came
  // from -- a real DOM descendant of host's own parent again (normal
  // flow, no fixed positioning, no getBoundingClientRect tracking),
  // which is what "embedded in the UI" means here: it scrolls, resizes
  // and reflows with the page instead of a script re-synchronizing a
  // floating copy against it a frame later.
  //
  // v1.43.0's original version of this (host.parentElement.insertBefore
  // (bar, host)) broke on review cards where the map's immediate parent
  // turned out to be a flex/grid ROW (map + photo carousel side by
  // side, confirmed in the field via screenshot) rather than a simple
  // stacked column -- inserting a second child there just became
  // another item in that row. v1.47.0 sidestepped that with
  // position:fixed on document.body, which fixed the placement but
  // introduced the floating/lagging look. v1.50.0 tried forcing the
  // existing row to wrap (flex-wrap:wrap/grid-column:1/-1 on the bar
  // itself) instead -- reported back still landing beside the map,
  // confirming that guessing at and overriding the SITE'S OWN row/grid
  // settings from outside isn't reliable (Wayfarer's own layout code
  // can simply re-apply whatever it was already doing).
  //
  // waePlaceReviewToggle() below takes a different approach that
  // doesn't depend on any of that: it moves host itself inside a new
  // wrapper div this plugin fully owns, with the wrapper -- not host --
  // now occupying host's old slot in whatever row/grid the review card
  // uses. Host's own placement/sizing rules (an external "nia-map{...}"
  // stylesheet rule, an inline style, or an Angular binding -- whichever
  // it was) still apply to host wherever it's nested, but the ones that
  // controlled HOW MUCH SPACE THE ROW GAVE IT (flex-grow/shrink/basis,
  // grid-column/row/area, width) only matter for whatever element is
  // the row's DIRECT child -- so those are read off host's *computed*
  // style (the resolved value, however it got there) and copied onto
  // the wrapper before host moves, giving the wrapper the same
  // footprint host used to have. Inside that wrapper, host and the bar
  // are stacked in a plain flex column this plugin controls end to end,
  // so nothing about the site's own row/grid settings has any say over
  // whether they end up on the same line -- they can't, structurally.
  function waeInjectReviewToggle(host) {
    if (!host) return;
    let bar = document.getElementById(WAE_REVIEW_TOGGLE_ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = WAE_REVIEW_TOGGLE_ID;
      bar.className = 'wae-review-toggle-bar';
      bar.title = 'Shows abuse report markers and your abuse report draft markers on this map, plus the add-to-draft controls in its info windows';
      const label = document.createElement('span');
      label.className = 'wae-review-toggle-label';
      label.textContent = 'Abuse report markers';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wae-review-toggle-btn';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        waeSetReviewPulsesEnabled(!waeReviewPulsesEnabled());
        waeUpdateReviewToggleUi();
        waeSafeRefreshReviewPulses();
        waeReviewIwSchedule(); // also adds/removes the add-to-draft controls in open info windows
      });
      // v1.69.0: the Marked Wayspots list is reachable from here too (the
      // panel it normally lives behind isn't on the review page). Same
      // icon as the panel header's list button; sits next to On/Off so
      // the label can keep truncating on its own at the left.
      const listBtn = document.createElement('button');
      listBtn.type = 'button';
      listBtn.className = 'wae-review-toggle-icon-btn';
      listBtn.title = 'Marked Wayspots List (your abuse report draft)';
      listBtn.setAttribute('aria-label', 'Open the Marked Wayspots list');
      listBtn.innerHTML = WAE_LIST_ICON_SVG;
      listBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        waeOpenMarkedWayspotListModal();
      });
      const actions = document.createElement('span');
      actions.className = 'wae-review-toggle-actions';
      actions.append(listBtn, btn);
      bar.appendChild(label);
      bar.appendChild(actions);
    }
    waeReviewToggleHost = host;
    waePlaceReviewToggle(host, bar);
    // Back to living inside Wayfarer's own app tree (a genuine DOM
    // descendant of host's parent), so the bar and whatever ancestor
    // carries Wayfarer's in-app ".dark" class are in the same subtree
    // again -- but this still checks host.closest('.dark') directly and
    // applies the result as our own class, rather than reintroducing a
    // ".dark .wae-review-toggle-bar" descendant selector, since that's
    // one less thing that can silently stop matching if the bar's exact
    // DOM position ever moves again in a future version.
    bar.classList.toggle('wae-review-dark', !!host.closest('.dark'));
    waeUpdateReviewToggleUi();
  }

  // Moves host inside a wrapper div this plugin owns (if it isn't
  // already), copying host's computed row/grid-placement properties
  // onto the wrapper first so the wrapper keeps host's original
  // footprint in the surrounding page, then stacks host and bar
  // vertically inside that wrapper via a plain flex column -- see
  // waeInjectReviewToggle()'s own comment for why this replaced trying
  // to make the SITE'S row/grid wrap the bar onto its own line instead.
  // 'height' is deliberately left off the copied-property list: copying
  // host's own resolved height onto the wrapper would cap the wrapper
  // at exactly the map's height, leaving no room for the bar and
  // squeezing the map to fit both inside that fixed height instead.
  // Leaving it off means the wrapper has no explicit height of its own
  // and simply grows to fit its two stacked children (host at whatever
  // height it already had, plus the bar) -- taller than a single
  // grid/flex row might otherwise expect, which is an acceptable
  // trade-off next to squeezing the actual map.
  // Idempotent and re-run on every waeInjectReviewToggle() call (not
  // just the first): the map's host element can get replaced wholesale
  // by Angular re-rendering a review card (see waeSetReviewMap()'s own
  // comment), and a fresh host may or may not land back inside the same
  // wrapper depending on how much of the surrounding DOM Angular
  // recreated -- checking parentElement's id on every call re-wraps a
  // host that came back outside our old wrapper, and is a cheap no-op
  // for one that's still inside it.
  // v1.69.1: 'width' is no longer in this list. getComputedStyle().width
  // is the USED width in px at that instant (e.g. "612px", even when the
  // site's own rule was just "fill the column"), and it was frozen onto
  // the wrapper once, when the wrapper was created. Whenever the column
  // later got narrower than it was at that moment (a layout that hadn't
  // settled yet, a scrollbar appearing, a window/zoom change), the
  // wrapper kept the old width and pushed the map and the toggle bar out
  // past the column with a sideways scrollbar -- confirmed by clearing
  // that inline width in DevTools, which snapped the map straight back.
  // See waeReviewWrapperWidth() for what is set instead.
  const WAE_REVIEW_WRAP_COPIED_PROPS = [
    'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'justifySelf',
    'gridColumn', 'gridRow', 'gridArea', 'minWidth', 'maxWidth',
  ];

  // The wrapper's width, expressed so it can never go stale:
  //  - the map filled its parent's content width (the normal case): no
  //    width at all -- a block-level flex container fills its parent by
  //    default, at whatever size the parent has now or later;
  //  - the map was narrower than its parent: the same SHARE of the
  //    parent, as a percentage, so it still scales with the parent;
  //  - not laid out yet (zero widths): nothing, since no width is better
  //    than a wrong one frozen in.
  function waeReviewWrapperWidth(host, parent, hostComputed) {
    const hostWidth = host.getBoundingClientRect().width;
    const parentComputed = getComputedStyle(parent);
    const parentContent = parent.clientWidth
      - (parseFloat(parentComputed.paddingLeft) || 0) - (parseFloat(parentComputed.paddingRight) || 0);
    if (!(hostWidth > 0) || !(parentContent > 0)) return '';
    const outer = hostWidth + (parseFloat(hostComputed.marginLeft) || 0) + (parseFloat(hostComputed.marginRight) || 0);
    if (Math.abs(outer - parentContent) <= 1.5) return '';
    return `${((hostWidth / parentContent) * 100).toFixed(2)}%`;
  }
  function waePlaceReviewToggle(host, bar) {
    let wrap = host.parentElement;
    if (!wrap || wrap.id !== WAE_REVIEW_TOGGLE_WRAP_ID) {
      const originalParent = host.parentElement;
      if (!originalParent) return;
      wrap = document.createElement('div');
      wrap.id = WAE_REVIEW_TOGGLE_WRAP_ID;
      const hostComputed = getComputedStyle(host);
      for (const prop of WAE_REVIEW_WRAP_COPIED_PROPS) wrap.style[prop] = hostComputed[prop];
      const wrapWidth = waeReviewWrapperWidth(host, originalParent, hostComputed);
      if (wrapWidth) wrap.style.width = wrapWidth;
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      // 'auto' (the computed value for most flex items) would stop a
      // flex-item wrapper shrinking below its content -- same overflow
      // risk as the frozen width above
      if (!wrap.style.minWidth || wrap.style.minWidth === 'auto') wrap.style.minWidth = '0'; // avoid flex-content overflow
      originalParent.insertBefore(wrap, host);
      wrap.appendChild(host);
    }
    if (bar.parentElement !== wrap || bar.previousElementSibling !== host) {
      wrap.appendChild(bar); // (re-)place as wrap's last child, right after host
    }
  }

  let waeReviewToggleHost = null;

  function waeRemoveReviewToggle() {
    document.getElementById(WAE_REVIEW_TOGGLE_ID)?.remove();
    waeReviewToggleHost = null;
  }

  function waeUpdateReviewToggleUi() {
    const bar = document.getElementById(WAE_REVIEW_TOGGLE_ID);
    if (!bar) return;
    const btn = bar.querySelector('.wae-review-toggle-btn');
    if (!btn) return;
    const on = waeReviewPulsesEnabled();
    btn.textContent = on ? 'On' : 'Off';
    btn.classList.toggle('wae-review-toggle-on', on);
    btn.setAttribute('aria-pressed', String(on));
  }

  let waeReviewRouteEnterUnsub = null;
  let waeReviewRouteLeaveUnsub = null;

  function waeReviewOnRouteEnter() {
    waeReviewIwStart();
    waeReviewMapSearchAttempts = 0;
    waeScheduleReviewMapSearch();
    if (!waeReviewPeriodicRecheckTimer) {
      waeReviewPeriodicRecheckTimer = setInterval(waeReviewPeriodicRecheck, WAE_REVIEW_PERIODIC_RECHECK_MS);
    }
  }

  function waeReviewOnRouteLeave() {
    waeReviewIwStop();
    waeStopReviewMapSearch();
    if (waeReviewPeriodicRecheckTimer) { clearInterval(waeReviewPeriodicRecheckTimer); waeReviewPeriodicRecheckTimer = null; }
    waeSetReviewMap(null, null);
  }

  function waeStartReviewTracking() {
    if (waeReviewRouteEnterUnsub) return; // already subscribed
    const WFMM = wfmmWindow.WFMM;
    waeReviewRouteEnterUnsub = WFMM.routes.onEnter('review', waeReviewOnRouteEnter);
    waeReviewRouteLeaveUnsub = WFMM.routes.onLeave('review', waeReviewOnRouteLeave);
    if (waeReviewIsOnRoute()) waeReviewOnRouteEnter(); // this version can load while already sitting on /new/review
  }

  // ---------------------------------------------------------------------
  // Review-page abuse helper (folded in from the standalone "Wayfarer
  // Abuse Text Formatter" script): on /new/review, each review candidate
  // gets a small row with a copy icon (copies "name, lat, lng" in the
  // same format as the Marked Wayspots list's Copy All, including a typed
  // note when "Include notes when copying" is on) plus the same note
  // field and "+ add to abuse report draft" button the native side panel
  // has. The old script showed the text itself; this shows only the icon.
  //
  // The candidate comes from the review page's own GET
  // /api/v1/vault/review response, intercepted by wrapping
  // XMLHttpRequest.prototype.open exactly like that script did -- this
  // script already runs @run-at document-start / @inject-into page, so
  // the wrapper is in place before Wayfarer's first request. Guarded by
  // a flag on wfmmWindow so it's only ever installed once. If the old
  // standalone script is still installed you'll get its text AND this
  // row; uninstall it once this is in use.
  // ---------------------------------------------------------------------
  // Niantic's "Reporting Abuse in Wayfarer" Help Center article -- linked
  // from the Marked Wayspots list and from the review-page row below.
  const WAE_ABUSE_FORM_URL = 'https://scopelyexplore.helpshift.com/hc/en/10-wayfarer/faq/1999-reporting-abuse-in-wayfarer/';
  let waePluginActive = false; // true between startPlugin() and stopPlugin() -- the hook below stays installed but does nothing while off
  let waeLatestReviewCandidate = null;
  let waeReviewAbuseInsertToken = 0;

  const WAE_COPY_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V6a2 2 0 0 1 2-2h9"></path></svg>';
  // v1.76.0: the review-page row's other icons -- same 16px outline style
  // as the copy/check icons. Flag with a plus = add to the abuse report
  // draft, wand = auto-fill the abuse form, page with an exclamation mark
  // = open the abuse form (wand and page are Lucide's "wand" and
  // "file-warning" shapes), cross = popup blocked.
  const waeIconSvg = (inner) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const WAE_MARK_ICON_SVG = waeIconSvg('<path d="M5 21V4"></path><path d="M5 4h9l-1.5 3.5L14 11H5"></path><path d="M18 15v6M15 18h6"></path>');
  const WAE_WAND_ICON_SVG = waeIconSvg('<path d="M15 4V2"></path><path d="M15 16v-2"></path><path d="M8 9h2"></path><path d="M20 9h2"></path><path d="M17.8 11.8 19 13"></path><path d="M15 9h.01"></path><path d="M17.8 6.2 19 5"></path><path d="m3 21 9-9"></path><path d="M12.2 6.2 11 5"></path>');
  const WAE_FILE_ALERT_ICON_SVG = waeIconSvg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>');
  const WAE_X_ICON_SVG = waeIconSvg('<path d="M6 6l12 12M18 6 6 18"></path>');
  // v1.78.0, for the Marked Wayspots list modal (Lucide "trash-2" and "clipboard-check")
  const WAE_TRASH_ICON_SVG = waeIconSvg('<path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M10 11v6M14 11v6"></path>');
  const WAE_CLIPBOARD_CHECK_ICON_SVG = waeIconSvg('<rect width="8" height="4" x="8" y="2" rx="1" ry="1"></rect><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><path d="m9 14 2 2 4-4"></path>');
  // v1.89.0, for the review row's Sightengine button (Lucide \"scan-search\")
  const WAE_SCAN_SEARCH_ICON_SVG = waeIconSvg('<path d=\"M3 7V5a2 2 0 0 1 2-2h2\"></path><path d=\"M17 3h2a2 2 0 0 1 2 2v2\"></path><path d=\"M21 17v2a2 2 0 0 1-2 2h-2\"></path><path d=\"M7 21H5a2 2 0 0 1-2-2v-2\"></path><circle cx=\"12\" cy=\"12\" r=\"3\"></circle><path d=\"m16 16-1.9-1.9\"></path>');
  // v1.82.0, for the Marked Wayspots list's Deselect all button (Lucide "square-minus")
  const WAE_DESELECT_ICON_SVG = waeIconSvg('<rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M8 12h8"></path>');

  // An icon-only button for the suite's own modals (ui.button() underneath,
  // so it keeps their look) -- the wording lives in the tooltip and the
  // aria-label. waeFlashButton() swaps the icon + tooltip for a moment
  // (a check after copying, a cross when it failed) and then puts them back.
  function waeIconButton(ui, { icon, title, variant, disabled }) {
    return ui.button({
      html: icon,
      title,
      variant: variant || 'default',
      disabled: !!disabled,
      className: 'wae-list-icon-btn',
      attrs: { 'aria-label': title },
    });
  }

  function waeFlashButton(btn, flashIcon, flashTitle, restoreIcon, restoreTitle, ms = 1500) {
    btn.innerHTML = flashIcon;
    btn.title = flashTitle;
    btn.setAttribute('aria-label', flashTitle);
    setTimeout(() => {
      // restoreIcon / restoreTitle may be functions, for a button whose
      // label changes meanwhile (the Copy selected count)
      const icon = typeof restoreIcon === 'function' ? restoreIcon() : restoreIcon;
      const title2 = typeof restoreTitle === 'function' ? restoreTitle() : restoreTitle;
      btn.innerHTML = icon;
      btn.title = title2;
      btn.setAttribute('aria-label', title2);
    }, ms);
  }
  const WAE_CHECK_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"></path></svg>';

  function waeAwaitElement(get, tries = 30, delayMs = 100) {
    return new Promise((resolve, reject) => {
      let left = tries;
      const loop = () => {
        const ref = get();
        if (ref) resolve(ref);
        else if (!left--) reject(new Error('element not found'));
        else setTimeout(loop, delayMs);
      };
      loop();
    });
  }

  function waeRemoveReviewAbuseRows() {
    document.querySelectorAll('.wae-review-abuse-row').forEach((el) => el.remove());
  }

  // v1.91.0: the addresses of the review's photos, from the review response,
  // at full size (\"=s0\", as Image Mods' magnifier opens them): the new
  // Wayspot's `imageUrl`, its `supportingImageUrls`, and the `newPhotos` of
  // a photo review. Only Google-hosted addresses are taken; unusable
  // entries stay as '' so the positions still line up with the photo cards
  // and the carousel.
  function waeFullSizePhotoUrl(v) {
    if (typeof v !== 'string' || !waeSeIsAllowedPhotoUrl(v)) return '';
    return v.includes('=') ? v : `${v}=s0`;
  }

  function waeReviewPhotoUrls(c) {
    const list = (arr, pick) => (Array.isArray(arr) ? arr.map((x) => waeFullSizePhotoUrl(pick(x))) : []);
    return {
      main: waeFullSizePhotoUrl(c.imageUrl),
      supporting: list(c.supportingImageUrls, (x) => x),
      photos: list(c.newPhotos, (x) => x && x.value),
    };
  }

  // v2.1.0: the Sightengine button, shared by the review-page row and the map
  // side panel's note row. Opens Sightengine's AI-image check with a photo
  // already loaded (see the Sightengine companion near the top of this file)
  // and, with the "start the auto-fill on an AI verdict" setting on (the
  // default), keeps a link back to this tab so the verdict can come back:
  // over 90% AI-generated sends that tab on to the abuse form, filled in for
  // this Wayspot (issue Photo Issues, the note and the verdict as the
  // report details, only name + coordinates as the location), and once the
  // form is submitted the Wayspot is added to the abuse reports table as a
  // "Reported" row.
  //   name / lat / lng   the Wayspot
  //   noteInput          the note field beside the button (read when needed)
  //   getPhotoUrl()      the photo's address at click time ('' = none found)
  //   className          the button's CSS class(es), to match its row
  //   idleTitle          the tooltip when idle
  //   disabledTitle      (optional) disables the button, with this tooltip
  function waeBuildSightengineButton({ name, lat, lng, noteInput, getPhotoUrl, className, idleTitle, disabledTitle }) {
    const seBtn = document.createElement('button');
    seBtn.type = 'button';
    seBtn.className = className;
    const seTitle = disabledTitle || idleTitle;
    seBtn.innerHTML = WAE_SCAN_SEARCH_ICON_SVG;
    seBtn.title = seTitle;
    seBtn.setAttribute('aria-label', seTitle);
    seBtn.disabled = !!disabledTitle;
    const flash = (icon, title) => {
      seBtn.innerHTML = icon;
      seBtn.title = title;
      setTimeout(() => {
        if (!seBtn.isConnected) return;
        seBtn.innerHTML = WAE_SCAN_SEARCH_ICON_SVG;
        seBtn.title = seTitle;
      }, 1500);
    };
    seBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const photoUrl = getPhotoUrl();
      if (!photoUrl) { flash(WAE_X_ICON_SVG, 'No photo found here, so nothing to send to Sightengine'); return; }
      // v1.92.0: with the "start the auto-fill on an AI verdict" setting on
      // (the default), the tab keeps its opener so the verdict can come
      // back to this tab; with it off the tab is cut loose as before.
      const autoStart = wfmmWindow.WFMM.settings.get(PLUGIN_ID, 'sightengineAutoStart', true) !== false;
      const checkId = autoStart
        ? ((typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
        : '';
      const hash = `${WAE_SE_HASH_IMAGE}=${encodeURIComponent(photoUrl)}${checkId ? `&${WAE_SE_HASH_SESSION}=${checkId}` : ''}`;
      const popup = window.open(`${WAE_SE_URL}#${hash}`, '_blank');
      if (popup && !autoStart) { try { popup.opener = null; } catch (e) { /* ignore */ } }
      if (popup && autoStart) {
        const now = Date.now();
        for (const [id, c] of waeSeChecks) if (now - c.createdAt > 10 * 60 * 1000) waeSeChecks.delete(id);
        waeSeChecks.set(checkId, {
          popup,
          createdAt: now,
          onResult: (score) => {
            if (score === null) {
              if (seBtn.isConnected) seBtn.title = 'Sightengine: the verdict could not be read';
              return;
            }
            const pct = Math.round(score * 1000) / 10;
            const high = score > WAE_SE_AI_THRESHOLD;
            if (seBtn.isConnected) {
              seBtn.title = `Sightengine: ${pct}% AI-generated${high ? ' (over 90%, starting the abuse form auto-fill)' : ''}`;
            }
            if (!high) return;
            // A moment to see the verdict, then this Wayspot goes into the
            // abuse form in the same tab. This workflow fills the form its
            // own way: the issue is always "Photo Issues"; the Abuse report
            // details are the note typed beside the button (when there is
            // one) and the verdict, and nothing else (not the settings'
            // default text); the location field only has the Wayspot's name
            // and coordinates.
            const aiNote = `Sightengine estimates this photo is ${pct}% AI-generated`;
            setTimeout(() => {
              const result = waeOpenAbuseFormAutofill(() => ({
                items: [{ name, lat, lng, note: '' }],
                includeNotes: false,
                overrides: {
                  issueType: 'Photo Issues',
                  reportDetails: [noteInput.value.trim(), aiNote].filter(Boolean).join('\n'),
                  locationNotes: false,
                },
              }), undefined, popup, () => {
                // once the form is submitted the Wayspot goes straight into the abuse
                // reports table as a "Reported" row (the note and the verdict as its
                // comment); the next scan that finds its ticket email replaces it
                waeAddReportedRecords([{ name, lat, lng, note: [noteInput.value.trim(), aiNote].filter(Boolean).join('; ') }])
                  .catch((e) => console.warn('[Wayfarer Map Mods - Abuse Reports] Could not add the reported Wayspot to the table:', e));
              });
              if (result !== 'opened') console.warn('[Wayfarer Map Mods - Abuse Reports] Could not send the Sightengine tab to the abuse form (closed?).');
            }, 1500);
          },
        });
      }
      flash(popup ? WAE_CHECK_ICON_SVG : WAE_X_ICON_SVG, popup ? 'Opened' : 'Popup blocked');
    });
    return seBtn;
  }

  // v2.1.0: the photo of the Wayspot open in the map side panel, read off
  // the panel when the button is clicked (it may load after the panel
  // appears): the first Google-hosted <img> or CSS background image in it,
  // with any size suffix (=s60, =w200-h200, ...) swapped for =s0, the full
  // size. '' when the panel shows none.
  function waeSidePanelPhotoUrl(slot) {
    const found = [];
    slot.querySelectorAll('img').forEach((img) => found.push(img.currentSrc || img.src));
    slot.querySelectorAll('*').forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg !== 'none' ? bg.match(/url\((['"]?)(.*?)\1\)/) : null;
      if (m) found.push(m[2]);
    });
    for (const raw of found) {
      if (waeSeIsAllowedPhotoUrl(raw)) return `${raw.replace(/=[^/=]*$/, '')}=s0`;
    }
    return '';
  }

  function waeBuildReviewAbuseRow(candidate) {
    const lat = Number(candidate.lat);
    const lng = Number(candidate.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    // Same naming rule as the side panel: no title -> blank name (the
    // list/copy formatting then shows "(unnamed)").
    const name = typeof candidate.title === 'string' ? candidate.title.trim() : '';

    const row = document.createElement('div');
    row.className = 'wae-review-abuse-row';

    const { noteInput, markBtn } = waeBuildMarkControls({ name, lat, lng, iconOnly: true });

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'wae-review-copy-btn';
    copyBtn.innerHTML = WAE_COPY_ICON_SVG;
    copyBtn.title = 'Copy name and coordinates for the abuse report form';
    copyBtn.setAttribute('aria-label', 'Copy name and coordinates for the abuse report form');
    copyBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const text = waeFormatMarkedWayspotLine({ name, lat, lng, note: noteInput.value.trim() }, waeCopyIncludesNotes());
      const ok = await waeCopyToClipboard(text);
      copyBtn.innerHTML = ok ? WAE_CHECK_ICON_SVG : WAE_COPY_ICON_SVG;
      copyBtn.classList.toggle('wae-copied', ok);
      copyBtn.title = ok ? 'Copied!' : 'Copy failed';
      setTimeout(() => {
        if (!copyBtn.isConnected) return;
        copyBtn.innerHTML = WAE_COPY_ICON_SVG;
        copyBtn.classList.remove('wae-copied');
        copyBtn.title = 'Copy name and coordinates for the abuse report form';
      }, 1200);
    });

    // Link to the abuse form, same target as the Marked Wayspots list's
    // link -- opens in a new tab so the review in progress isn't lost.
    const formLink = document.createElement('a');
    formLink.className = 'wae-review-form-link';
    formLink.innerHTML = WAE_FILE_ALERT_ICON_SVG;
    formLink.title = 'Open the abuse form (new tab)';
    formLink.setAttribute('aria-label', 'Open the abuse form (new tab)');
    formLink.href = WAE_ABUSE_FORM_URL;
    formLink.target = '_blank';
    formLink.rel = 'noopener noreferrer';

    // v1.75.0: opens the abuse form and fills it in for THIS review only --
    // just this Wayspot and the note typed in the field beside it, not the
    // Marked Wayspots list (and nothing is added to that list). The note is
    // read when the Help Center tab asks for the data, so one typed or
    // changed in the meantime is included. It is always included here
    // (clicking this button is asking for it), whatever the "Include notes
    // when copying" checkbox of the list's Copy All says.
    const fillBtn = document.createElement('button');
    fillBtn.type = 'button';
    fillBtn.className = 'wae-review-fill-btn';
    const fillTitle = 'Auto-fill the abuse form for this review only, with the note beside it (opens a new tab)';
    fillBtn.innerHTML = WAE_WAND_ICON_SVG;
    fillBtn.title = fillTitle;
    fillBtn.setAttribute('aria-label', fillTitle);
    fillBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const result = waeOpenAbuseFormAutofill(() => ({
        items: [{ name, lat, lng, note: noteInput.value.trim() }],
        includeNotes: true,
      }));
      const opened = result === 'opened';
      fillBtn.innerHTML = opened ? WAE_CHECK_ICON_SVG : WAE_X_ICON_SVG;
      fillBtn.title = opened ? 'Opened' : 'Popup blocked';
      setTimeout(() => {
        if (!fillBtn.isConnected) return;
        fillBtn.innerHTML = WAE_WAND_ICON_SVG;
        fillBtn.title = fillTitle;
      }, 1500);
    });

    // v1.89.0 / v1.91.0: the Sightengine button (see waeBuildSightengineButton()):
    // the new Wayspot's photo, or the first photo of a photo review. Edits
    // have no photo, so they get no button; a review whose photo address
    // wasn't in the response gets a disabled one, with the reason in the
    // tooltip.
    let seBtn = null;
    const sePhotoUrl = (candidate.photos && (candidate.photos.main || candidate.photos.photos.find(Boolean))) || '';
    if (candidate.type === 'NEW' || candidate.type === 'PHOTO') {
      seBtn = waeBuildSightengineButton({
        name, lat, lng, noteInput,
        getPhotoUrl: () => sePhotoUrl,
        className: 'wae-review-fill-btn wae-review-se-btn',
        idleTitle: 'Check this photo for AI generation on Sightengine (opens a new tab)',
        disabledTitle: sePhotoUrl ? '' : 'No photo address found in this review, so it cannot be sent to Sightengine',
      });
    }

    // v1.79.1: the note field first, then all the icon buttons to its right
    row.append(noteInput, copyBtn, markBtn, fillBtn, formLink);
    if (seBtn) row.append(seBtn);
    return row;
  }

  // Same anchor points the old script used: before the first .mt-2 on a
  // NEW/PHOTO card, as the second child of .review-edit-info on an EDIT
  // card. Waits for the element (the response can land before Angular
  // has rendered the card); a newer candidate arriving while waiting
  // supersedes this one via the token.
  async function waeInsertReviewAbuseRow(candidate) {
    if (!waePluginActive) return;
    const token = ++waeReviewAbuseInsertToken;
    const isEdit = candidate.type === 'EDIT';
    let target;
    try {
      target = await waeAwaitElement(() => document.querySelector(isEdit ? '.review-edit-info' : '.mt-2'));
    } catch (e) {
      return; // no card to attach to (e.g. left the page)
    }
    if (token !== waeReviewAbuseInsertToken || !waePluginActive) return;
    const row = waeBuildReviewAbuseRow(candidate);
    if (!row) return;
    waeRemoveReviewAbuseRows(); // drop the previous candidate's row
    if (isEdit) {
      if (target.children.length >= 1) target.insertBefore(row, target.children[1] || null);
      else target.appendChild(row);
    } else {
      target.parentNode.insertBefore(row, target);
    }
  }

  function waeOnReviewResponse() {
    try {
      const json = typeof this.response === 'string' ? JSON.parse(this.response) : this.response;
      if (!json || json.captcha) return;
      const c = json.result;
      if (!c) return;
      // The nearby Wayspots the review map is about to show -- kept so
      // their info windows can be matched back to coordinates (see
      // waeReviewIwResolvePoi()).
      waeCaptureReviewNearbyPortals(c);
      if (c.type === 'NEW' || c.type === 'PHOTO' || c.type === 'EDIT') {
        waeLatestReviewCandidate = { type: c.type, title: c.title, lat: c.lat, lng: c.lng, photos: waeReviewPhotoUrls(c) };
        waeInsertReviewAbuseRow(waeLatestReviewCandidate);
      }
      waeReviewIwSchedule(); // a different review means different (or no) nearby Wayspots
    } catch (e) { /* not a review response we can use -- ignore */ }
  }

  function waeInstallReviewCandidateHook() {
    const XHR = wfmmWindow.XMLHttpRequest;
    if (!XHR || wfmmWindow.__waeReviewCandidateHooked) return;
    wfmmWindow.__waeReviewCandidateHooked = true;
    const originalOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url) {
      try {
        if (String(method).toUpperCase() === 'GET' && String(url).split('?')[0] === '/api/v1/vault/review') {
          this.addEventListener('load', waeOnReviewResponse, false);
        }
      } catch (e) { /* never let the hook break a request */ }
      return originalOpen.apply(this, arguments);
    };
  }
  waeInstallReviewCandidateHook();

  // ---------------------------------------------------------------------
  // Abuse draft controls inside the review map's info windows (v1.64.0).
  // The same note field + "+ add to abuse report draft" button the side
  // panel and the review-page row above already have, added to the info
  // window that opens when you click a nearby Wayspot on the review map
  // (duplicates, edit-location, edit-info and photo reviews alike), so a
  // Wayspot spotted there can go straight onto the Marked Wayspots list.
  //
  // Built the way Wayfarer Map Mods builds its own "open in map view"
  // link in those same windows (review-map-enhancements, native-info-
  // window-link.js and wayspot-info-window.js): a MutationObserver
  // decorates each .agm-info-window-content as it appears. Nothing here
  // calls into or patches the suite; it only reads the DOM the suite and
  // Wayfarer already render, plus the review response this file already
  // intercepts.
  //
  // Two kinds of window turn up on that map, and the hard part for both
  // is knowing WHICH Wayspot a window is about -- there is no data
  // attribute for it:
  //   - Wayfarer's own windows (the review response's nearbyPortals):
  //     only a title and a photo, no coordinates anywhere in the DOM.
  //     Matched back to the portal list captured from the review
  //     response (waeCaptureReviewNearbyPortals()) by photo first, then
  //     by a title that is unique in that list -- the same order the
  //     suite itself uses to find the Wayspot behind the same windows.
  //   - The suite's own windows (Wayspots it adds that the response
  //     missed, and every edit/photo review): the suite's "open in map
  //     view" link in the window has the exact lat/lng in its href, so
  //     that is read. It is also the fallback for a Wayfarer window that
  //     can't be matched. If that link is switched off in the suite's own
  //     settings there is no position to read, so such a window simply
  //     gets no controls rather than a guess.
  // ---------------------------------------------------------------------
  const WAE_REVIEW_IW_CLASS = 'wae-review-iw-abuse';
  let waeReviewNearbyPortals = []; // [{ name, titleKey, imageUrl, lat, lng }] from the latest review response
  let waeReviewIwObserver = null;
  let waeReviewIwQueued = false;

  // The checkbox itself (Marker Style settings, see
  // waeRenderMarkerStyleSection()) -- just the person's choice, nothing
  // else folded in, which is what that checkbox should show.
  function waeReviewMapControlsSetting() {
    return wfmmWindow.WFMM.settings.get(PLUGIN_ID, 'reviewMapAbuseControls', true) !== false;
  }

  // Off when either that setting says so OR the "Abuse report markers"
  // toggle under the review map is Off -- that toggle is the one switch
  // for everything this plugin adds to that map.
  function waeReviewMapControlsEnabled() {
    return waeReviewPulsesEnabled() && waeReviewMapControlsSetting();
  }

  function waeReviewIwNormalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  // Same tolerance the suite applies when comparing Wayspot photo URLs:
  // http vs https and a trailing "=s<size>" resize suffix don't matter.
  function waeReviewIwNormalizeImageUrl(value) {
    const url = String(value || '').trim();
    if (!url) return '';
    const secure = url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
    return secure.replace(/=s\d+$/i, '');
  }

  function waeIsValidLatLng(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  function waeCaptureReviewNearbyPortals(result) {
    const portals = Array.isArray(result?.nearbyPortals) ? result.nearbyPortals : [];
    waeReviewNearbyPortals = portals.map((p) => {
      const name = typeof p?.title === 'string' ? p.title.trim() : '';
      return {
        name,
        titleKey: waeReviewIwNormalizeText(name).toLowerCase(),
        imageUrl: waeReviewIwNormalizeImageUrl(p?.imageUrl),
        lat: Number(p?.lat),
        lng: Number(p?.lng),
      };
    }).filter((p) => waeIsValidLatLng(p.lat, p.lng));
  }

  function waeReviewIwMatchPortal(content, titleKey) {
    if (!waeReviewNearbyPortals.length) return null;
    const img = content.querySelector('img.wf-image-modal') || content.querySelector('img[wf-image-modal]');
    const imageUrl = waeReviewIwNormalizeImageUrl(img?.currentSrc || img?.src);
    if (imageUrl) {
      const byImage = waeReviewNearbyPortals.filter((p) => p.imageUrl && p.imageUrl === imageUrl);
      if (byImage.length === 1) return byImage[0];
    }
    if (!titleKey) return null;
    const byTitle = waeReviewNearbyPortals.filter((p) => p.titleKey === titleKey);
    return byTitle.length === 1 ? byTitle[0] : null;
  }

  // The suite's map link is /new/mapview?lat=..&lng=..&z=18&poi=<guid>.
  function waeReviewIwCoordsFromLink(content) {
    const link = content.querySelector('a[data-wfmm-poi-guid]');
    if (!link) return null;
    try {
      const params = new URL(link.getAttribute('href') || '', window.location.origin).searchParams;
      if (!params.has('lat') || !params.has('lng')) return null;
      const lat = Number(params.get('lat'));
      const lng = Number(params.get('lng'));
      return waeIsValidLatLng(lat, lng) ? { lat, lng } : null;
    } catch (e) {
      return null;
    }
  }

  // -> { name, lat, lng } or null when this window's Wayspot can't be
  // pinned down. Name follows the rule used everywhere else in this file:
  // no real title -> blank (the list/copy formatting then shows
  // "(unnamed)").
  function waeReviewIwResolvePoi(content) {
    const owned = content.classList.contains('wfmm-review-owned-info-window');
    const titleEl = owned
      ? content.querySelector('.wfmm-review-owned-info-window__title')
      : (content.querySelector(':scope > div > .font-medium') || content.querySelector('.font-medium'));
    const domTitle = waeReviewIwNormalizeText(titleEl?.textContent);
    if (!owned) {
      const portal = waeReviewIwMatchPortal(content, domTitle.toLowerCase());
      if (portal) return { name: portal.name, lat: portal.lat, lng: portal.lng };
    }
    const coords = waeReviewIwCoordsFromLink(content);
    if (!coords) return null;
    const untitled = domTitle === 'Untitled Wayspot' || domTitle === 'Untitled location';
    return { name: untitled ? '' : domTitle, lat: coords.lat, lng: coords.lng };
  }

  function waeReviewIwRemoveControls(content) {
    content.querySelectorAll(`:scope > .${WAE_REVIEW_IW_CLASS}`).forEach((el) => el.remove());
  }

  function waeReviewIwBuildControls(poi, key) {
    const wrap = document.createElement('div');
    wrap.className = WAE_REVIEW_IW_CLASS;
    wrap.dataset.waeKey = key;
    const { noteInput, markBtn } = waeBuildMarkControls({ name: poi.name, lat: poi.lat, lng: poi.lng });
    wrap.append(noteInput, markBtn);
    // Same as the suite's own link in these windows: keep presses here
    // from reaching the map or Wayfarer's own handlers behind the window.
    for (const evName of ['pointerdown', 'mousedown', 'touchstart', 'dblclick', 'keyup']) {
      wrap.addEventListener(evName, (ev) => ev.stopPropagation());
    }
    return wrap;
  }

  function waeReviewIwSyncNow() {
    waeReviewIwQueued = false;
    if (!waeReviewIwObserver) return;
    const enabled = waeReviewMapControlsEnabled();
    for (const content of document.querySelectorAll('.agm-info-window-content')) {
      const existing = content.querySelector(`:scope > .${WAE_REVIEW_IW_CLASS}`);
      const poi = enabled ? waeReviewIwResolvePoi(content) : null;
      if (!poi) {
        if (existing) waeReviewIwRemoveControls(content);
        continue;
      }
      const key = `${poi.lat.toFixed(6)},${poi.lng.toFixed(6)}|${poi.name}`;
      if (existing && existing.dataset.waeKey === key) continue; // nothing changed -- leave a half-typed note alone
      waeReviewIwRemoveControls(content);
      content.append(waeReviewIwBuildControls(poi, key));
    }
  }

  // Batched: a burst of DOM changes (map tiles loading, Angular
  // re-rendering) costs one pass, run before the next paint so the
  // controls never visibly pop in a frame late.
  function waeReviewIwSchedule() {
    if (!waeReviewIwObserver || waeReviewIwQueued) return;
    waeReviewIwQueued = true;
    queueMicrotask(waeReviewIwSyncNow);
  }

  function waeReviewIwStart() {
    if (waeReviewIwObserver) return;
    waeReviewIwObserver = new MutationObserver(waeReviewIwSchedule);
    waeReviewIwObserver.observe(document.documentElement, { childList: true, subtree: true });
    waeReviewIwSchedule();
  }

  function waeReviewIwStop() {
    waeReviewIwObserver?.disconnect();
    waeReviewIwObserver = null;
    waeReviewIwQueued = false;
    waeReviewNearbyPortals = [];
    document.querySelectorAll(`.${WAE_REVIEW_IW_CLASS}`).forEach((el) => el.remove());
  }
  // ---- end of the review map info window controls ----

  function waeStopReviewTracking() {
    waeReviewRouteEnterUnsub?.();
    waeReviewRouteLeaveUnsub?.();
    waeReviewRouteEnterUnsub = null;
    waeReviewRouteLeaveUnsub = null;
    waeReviewOnRouteLeave();
  }

  // ---------------------------------------------------------------------
  // Live Wayspot ticket annotation -- appends "#<ticket>" just above the
  // LIVE/status badge row in the side panel's own Wayspot details card
  // (the one that opens when you click a Wayspot on the map), for any
  // Wayspot within WAE_NEARBY_THRESHOLD_METERS of one of this plugin's
  // own extracted locations.
  //
  // Uses WFMM.sidePanel -- a real, public service (confirmed against the
  // real source, src/core/side-panel.js), NOT the same as this plugin's
  // OWN "Show on Map" markers/popups, and NOT a hook into Wayfarer's
  // truly-native rendering (there isn't a confirmed one -- see the
  // earlier back-and-forth on this feature for why an approach that
  // needed one was abandoned). This IS how Base itself builds that same
  // card (createPoiDetailsElement(), confirmed against the same source),
  // so this plugin is using the identical public surface Base's own code
  // does, not reverse-engineering something undocumented.
  //
  // The mechanism: WFMM.sidePanel.setDetails() -- what Base calls every
  // time a different Wayspot gets selected -- fully replaces the details
  // slot's content, THEN emits "side-panel:details-changed" with a
  // reference to that slot. This plugin only ever listens for that event
  // and inserts one extra element into the ALREADY-rendered slot after
  // the fact -- it never calls setDetails() itself, which would wipe out
  // Base's own card (title, photo, everything) rather than adding to it.
  // Each event gives a freshly-Base-rendered slot (whatever this plugin
  // inserted last time is already gone by the time the event fires, wiped
  // by Base's own replaceSlotContent()), so there's nothing to clean up
  // beforehand -- just insert fresh every time, or don't if there's no
  // match.
  //
  // Which Wayspot is showing isn't in the event payload itself (just
  // {pluginId, panel, slot}) -- read from the already-rendered DOM
  // instead: the coords element Base's own createCoordsElement() builds
  // carries the exact lat/lng as data-lat/data-lng attributes (confirmed
  // against the same source), which is more robust than trying to parse
  // the "(50.312940,6.731698)" display text back apart.
  let waeSidePanelDetailsUnsub = null;

  function waeFindMatchingTicketNumbers(lat, lng) {
    // BUGFIX (not upstream): was a plain linear scan over every record in
    // waeAllRecords -- see waeGetTicketIndexBuckets()'s own comment (just
    // above waeFindNearbyDuplicates()) for why that stopped scaling and
    // what replaced it. Only the 3x3 neighborhood around (lat, lng)'s own
    // grid cell needs checking -- same reasoning as
    // waeFindNearbyDuplicates()'s own neighborhood scan, and the same
    // WAE_GRID_DEG cell size guarantees it here too: anything within
    // WAE_NEARBY_THRESHOLD_METERS always falls in one of these 9 cells.
    const buckets = waeGetTicketIndexBuckets();
    const cellLat = Math.floor(lat / WAE_GRID_DEG);
    const cellLon = Math.floor(lng / WAE_GRID_DEG);
    // Keyed by ticket rather than a plain Set now (feature request: the
    // side-panel line built from this needs each ticket's own
    // lastResponseAt to work out the single most recent date across all
    // of them) -- lastResponseAt is a per-TICKET value, the same on every
    // row for that ticket (see scanImportedEmails()'s own comment), so
    // the first row seen for a given ticket already carries the right
    // value; no need to compare/overwrite on a second sighting.
    const seen = new Map();
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const bucket = buckets.get(`${cellLat + dLat}:${cellLon + dLon}`);
        if (!bucket) continue;
        for (const r of bucket) {
          if (waeHaversineMeters(lat, lng, r.latitude, r.longitude) <= WAE_NEARBY_THRESHOLD_METERS) {
            const ticket = r.conversationId || r.sourceEmailId;
            if (!seen.has(ticket)) seen.set(ticket, r.lastResponseAt);
          }
        }
      }
    }
    return Array.from(seen.entries()).map(([ticket, lastResponseAt]) => ({ ticket, lastResponseAt }));
  }

  // v1.53.6: spelled back out from the terser "+ Add" (v1.52.0's own
  // shortening, once the note field moved into this same row) -- kept as
  // one constant since the label's set in two places below (the button's
  // initial text, and the post-"\u2713 Added"/"\u2713 Updated" reset).
  const WAE_MARK_BTN_LABEL = '+ add to abuse report draft';

  // The username element currently shown in the side panel, if any --
  // kept so a color change in the Marker Style settings modal
  // (waeRenderMarkerStyleSection()'s favoriteUserColor picker) can
  // restyle it immediately, the same "apply live, don't wait for the
  // slot to re-render" behavior markColor's own picker already gives
  // waeRenderMarkedWayspotMarkers(). Cleared (set back to null) at the
  // top of every DETAILS_CHANGED firing, including ones with no username
  // to show at all -- so this never points at a stale element from a
  // previous, different Wayspot's slot.
  let waeCurrentUsernameEl = null;

  // Applies (or clears) the favorite styling on a live username element --
  // shared between where it's first set up below and the toggle-on-click
  // handler right next to it, so both always agree on what "favorited"
  // looks like.
  function waeApplyFavoriteUsernameStyle(el, username) {
    if (waeIsFavoriteUser(username)) {
      el.style.color = waeLoadAppearance().favoriteUserColor;
      el.style.fontWeight = '700';
    } else {
      el.style.color = '';
      el.style.fontWeight = '';
    }
  }

  // Called from the Marker Style settings modal's favoriteUserColor
  // picker (waeRenderMarkerStyleSection()) so a color change applies
  // immediately to whatever username is currently on screen, the same
  // "apply live" behavior markColor's own picker already gives
  // waeRenderMarkedWayspotMarkers() -- rather than leaving it stale until
  // the side panel happens to re-render for some other reason. isConnected
  // guards against the slot (and this element along with it) having
  // already been torn down/replaced by a different selection since --
  // same defensive check the "+ add to abuse report draft" button's own
  // post-click reset uses for the same reason.
  function waeRestyleCurrentFavoriteUsername() {
    if (waeCurrentUsernameEl && waeCurrentUsernameEl.isConnected) {
      waeApplyFavoriteUsernameStyle(waeCurrentUsernameEl, waeCurrentUsernameEl.textContent.trim());
    }
  }

  // Feature request: the note field + "+ add to abuse report draft" button,
  // shared by the native side panel (waeStartSidePanelDetailsWatcher())
  // and the review-page row (waeBuildReviewAbuseRow()) so both behave
  // identically -- a note can be typed BEFORE clicking the button so it's
  // captured in the same Marked Wayspots entry right away, and adding a
  // Wayspot that's already on the list overwrites its note (see
  // waeAddMarkedWayspot()). Returns the two elements unattached; each
  // caller decides where they go.
  //
  // v1.62.3: draftKey (side panel only) keeps a half-typed note alive when
  // Base rebuilds the details slot for the SAME Wayspot -- which it does
  // once the map finishes loading after a zoom, replacing this whole row
  // (and the input with it) mid-typing. The in-progress text, plus whether
  // the field had focus and where the caret was, is mirrored into
  // waeNoteDraft and restored onto the replacement input
  // (waeRestoreNoteFocus(), called by the watcher once the input is back
  // in the DOM). A different Wayspot's key simply never matches, so a
  // draft never carries over to another selection.
  let waeNoteDraft = null; // { key, value, focused, selStart, selEnd }

  function waeRestoreNoteFocus(noteInput, draftKey) {
    const d = waeNoteDraft;
    if (!d || d.key !== draftKey || !d.focused) return;
    noteInput.focus();
    try { noteInput.setSelectionRange(d.selStart, d.selEnd); } catch (e) { /* not selectable -- ignore */ }
  }

  function waeBuildMarkControls({ name, lat, lng, draftKey, iconOnly }) {
    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.className = 'wae-detail-mark-note';
    noteInput.placeholder = 'Note (optional)';
    // Feature request: raised from 300 -- the list's own edit textarea
    // (wae-mark-row-note-input, see waeBuildMarkedWayspotRow()) has never
    // had a cap of its own, so this field's cap was the only place a note
    // could actually get cut short.
    noteInput.maxLength = 1000;
    // Typing/clicking into this field is inside Wayfarer's own page,
    // which has its own click/key handling around it -- without this a
    // keystroke could also trigger whatever that surrounding UI does
    // with keys it doesn't recognize as text input.
    noteInput.addEventListener('click', (ev) => ev.stopPropagation());
    noteInput.addEventListener('keydown', (ev) => ev.stopPropagation());

    if (draftKey) {
      if (waeNoteDraft && waeNoteDraft.key === draftKey) {
        noteInput.value = waeNoteDraft.value;
      } else {
        waeNoteDraft = null; // a different Wayspot -- drop the old draft
      }
      const saveDraft = (focused) => {
        waeNoteDraft = {
          key: draftKey,
          value: noteInput.value,
          focused,
          selStart: noteInput.selectionStart ?? noteInput.value.length,
          selEnd: noteInput.selectionEnd ?? noteInput.value.length,
        };
      };
      for (const evName of ['input', 'keyup', 'click', 'focus']) {
        noteInput.addEventListener(evName, () => saveDraft(true));
      }
      noteInput.addEventListener('blur', () => {
        // A blur caused by Base tearing the slot down also lands here --
        // in that case the input is no longer connected by the time this
        // deferred check runs, and focus should be treated as still
        // wanted on the replacement. A real click-away leaves the input
        // connected, so that one does clear the focused flag.
        setTimeout(() => {
          if (noteInput.isConnected && waeNoteDraft && waeNoteDraft.key === draftKey) {
            waeNoteDraft.focused = false;
          }
        }, 0);
      });
    }

    const markBtn = document.createElement('button');
    markBtn.type = 'button';
    markBtn.className = iconOnly ? 'wae-detail-mark-btn wae-icon-btn' : 'wae-detail-mark-btn';
    // 'idle' | 'added' | 'updated'. Text button by default; with iconOnly
    // (the review-page row) the flag-plus icon, then a check, with the
    // wording in the tooltip / aria-label instead of on the button.
    const setMarkState = (state) => {
      if (iconOnly) {
        const label = state === 'idle' ? 'Add this Wayspot to your abuse report draft (Marked Wayspots list)'
          : (state === 'updated' ? 'Updated' : 'Added');
        markBtn.innerHTML = state === 'idle' ? WAE_MARK_ICON_SVG : WAE_CHECK_ICON_SVG;
        markBtn.title = label;
        markBtn.setAttribute('aria-label', label);
      } else {
        markBtn.textContent = state === 'idle' ? WAE_MARK_BTN_LABEL : (state === 'updated' ? '\u2713 Updated' : '\u2713 Added');
        if (state === 'idle') markBtn.title = 'Add this Wayspot to your Marked Wayspots list';
      }
    };
    setMarkState('idle');
    markBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const result = waeAddMarkedWayspot({ name, lat, lng, note: noteInput.value.trim() });
      noteInput.value = '';
      if (draftKey && waeNoteDraft && waeNoteDraft.key === draftKey) waeNoteDraft = null;
      // waeAddMarkedWayspot() decides whether this was a new entry or an
      // overwrite of an already-marked Wayspot's note.
      setMarkState(result === 'updated' ? 'updated' : 'added');
      markBtn.disabled = true;
      setTimeout(() => {
        // The surrounding DOM may have been torn down/replaced by the
        // time this fires (Base rebuilds the details slot on every
        // selection; the review card re-renders per candidate).
        if (markBtn.isConnected) {
          setMarkState('idle');
          markBtn.disabled = false;
        }
      }, 1200);
    });
    return { noteInput, markBtn };
  }

  function waeStartSidePanelDetailsWatcher() {
    if (waeSidePanelDetailsUnsub) return; // already subscribed
    const WFMM = wfmmWindow.WFMM;
    waeSidePanelDetailsUnsub = WFMM.events.on(WFMM.sidePanel.EVENTS.DETAILS_CHANGED, ({ slot }) => {
      if (!slot) return;

      // Feature request: click a submitter's username -- shown here
      // whenever Base actually renders one for the current slot (e.g.
      // reviewing a nomination; a mapview/submit Wayspot with no
      // submitter of its own has nothing here to click) -- to toggle
      // them in/out of a separate Favorite Users scratch list, visible in
      // the same modal as the Marked Wayspots list (see
      // waeRenderFavoriteUsersSection(), further down this file, for that
      // list itself; waeToggleFavoriteUser()/waeIsFavoriteUser() above
      // for the storage). Handled before the coordinate check below
      // (and independent of it either way) since favoriting a person
      // doesn't need this Wayspot to have coordinates -- the ticket-line/
      // mark-row features right after this DO, hence that check staying
      // where it is.
      waeCurrentUsernameEl = null;
      // Base renders this as one div reading "Submitted by <username>"
      // (.wfmapmods-detail-poi-submitter, confirmed against the live DOM)
      // -- the whole line, not just the name. Split here so only the
      // username itself becomes the click target/gets colored, with the
      // "Submitted by " prefix left as plain text in front of it. The
      // slot is rebuilt by Base on every selection (see this watcher's
      // own top comment), so rewriting this element's children is as
      // safe as the ticket line/mark row this watcher already injects.
      const submitterEl = slot.querySelector('.wfmapmods-detail-poi-submitter');
      const submitterMatch = submitterEl?.textContent.match(/^(\s*Submitted by\s+)(\S.*?)\s*$/i);
      if (submitterMatch) {
        const username = submitterMatch[2];
        submitterEl.textContent = submitterMatch[1];
        const usernameEl = document.createElement('span');
        usernameEl.textContent = username;
        submitterEl.appendChild(usernameEl);
        waeCurrentUsernameEl = usernameEl;
        usernameEl.classList.add('wae-favorite-username-trigger');
        usernameEl.title = 'Click to toggle as a favorite user';
        waeApplyFavoriteUsernameStyle(usernameEl, username);
        usernameEl.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          waeToggleFavoriteUser(username);
          waeApplyFavoriteUsernameStyle(usernameEl, username);
        });
      }

      // v1.81.2: Map Mods 4.9.0 turned .wfmapmods-detail-coords into a
      // CONTAINER of .wfmapmods-detail-coords-row children (one per
      // coordinate: a struck-through "previous" row when the Wayspot was
      // recently moved, then the "current" one), and moved data-lat/
      // data-lng from the container onto those rows. Reading them off the
      // container gave NaN, so this watcher returned right here and the
      // ticket line + note field + add-to-draft button never showed up.
      // The current row is the one that matters; the container itself is
      // still tried as a fallback for the older flat markup.
      const coordsEl = slot.querySelector('.wfmapmods-detail-coords-row--current')
        || slot.querySelector('.wfmapmods-detail-coords-row:last-child')
        || slot.querySelector('.wfmapmods-detail-coords');
      const readCoord = (v) => (v === undefined || v === null || String(v).trim() === '' ? NaN : Number(v));
      const lat = readCoord(coordsEl?.dataset.lat);
      const lng = readCoord(coordsEl?.dataset.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const statusRow = slot.querySelector('.wfmapmods-detail-status');
      if (!statusRow || !statusRow.parentNode) return;

      const tickets = waeFindMatchingTicketNumbers(lat, lng);
      if (tickets.length) {
        const line = document.createElement('div');
        line.className = 'wae-detail-ticket-line';
        // Feature request: the date of the last interaction, shown after
        // the ticket number(s) -- when this Wayspot matches more than one
        // ticket, only the single most recent date across all of them is
        // shown (not one date per ticket), since that's the one that
        // actually answers "is this still active?" and this line has
        // limited room for a per-ticket breakdown. Reuses
        // waeFormatTicketDateSuffix() (this file's own InfoWindow
        // functions use the exact same helper) for the same short-in-the-
        // line/full-on-hover formatting everywhere this shows up.
        const ticketText = tickets.map((t) => `#${t.ticket}`).join(', ');
        const latest = tickets.reduce((max, t) => (
          Number.isFinite(t.lastResponseAt) && (max === null || t.lastResponseAt > max) ? t.lastResponseAt : max
        ), null);
        const dateSuffix = waeFormatTicketDateSuffix(latest);
        line.textContent = dateSuffix ? `${ticketText}${dateSuffix.text}` : ticketText;
        if (dateSuffix) line.title = dateSuffix.title;
        statusRow.parentNode.insertBefore(line, statusRow);
      }

      // Feature request: a "+" right in this same spot (where the
      // ticket-number line above shows, whether or not there's actually
      // one to show right now) to add THIS Wayspot to the separate
      // Marked Wayspots scratch list -- see that feature's own
      // top-of-section comment (search "Marked Wayspots" further down
      // this file) for what that list is for. An earlier version of this
      // feature tried a global "arm marking mode, then click a Wayspot
      // on the map" toggle instead, reported back as not matching the
      // wanted interaction -- individual Wayspots need their own "+" to
      // click, not a separate mode. Same DOM-read approach as the ticket
      // line above (title read off .wfmapmods-detail-title, confirmed
      // against Base's own createTitleElement(), same source as
      // everything else in this watcher) rather than WFMM.selection/
      // WFMM.pois -- one mechanism for this whole watcher, not two, and
      // this one's already proven reliable here.
      const titleText = slot.querySelector('.wfmapmods-detail-title')?.textContent?.trim() || '';
      const name = (titleText && titleText !== 'Untitled location') ? titleText : '';

      const markRow = document.createElement('div');
      markRow.className = 'wae-detail-mark-row';
      // Note field + the add-to-draft button come from
      // waeBuildMarkControls() (shared with the review-page row, see
      // waeBuildReviewAbuseRow()) rather than being built inline here.
      // v1.77.0: the button is the flag-plus icon here too, like the
      // review-page row. It also stays in the row beside the note field now:
      // this function used to insert it a second time, straight into the
      // panel, which pulled it out of the row onto a line of its own.
      const draftKey = `${lat},${lng}`;
      const { noteInput, markBtn } = waeBuildMarkControls({ name, lat, lng, draftKey, iconOnly: true });
      // v2.1.0: the Sightengine button right after it; the photo is read off
      // this panel when it is clicked
      const seBtn = waeBuildSightengineButton({
        name, lat, lng, noteInput,
        getPhotoUrl: () => waeSidePanelPhotoUrl(slot),
        className: 'wae-detail-mark-btn wae-icon-btn wae-detail-se-btn',
        idleTitle: 'Check this Wayspot\u2019s photo for AI generation on Sightengine (opens a new tab)',
      });
      markRow.append(noteInput, markBtn, seBtn);
      statusRow.parentNode.insertBefore(markRow, statusRow);
      waeRestoreNoteFocus(noteInput, draftKey);
    });
  }

  function waeStopSidePanelDetailsWatcher() {
    waeSidePanelDetailsUnsub?.();
    waeSidePanelDetailsUnsub = null;
  }

  // Panel-row click -> jump the map to that location. The panel is a
  // full-screen backdrop, so the map isn't visible until it closes -- this
  // closes it as part of navigating BY DEFAULT, the same way clicking a
  // location is expected to actually show it rather than just move
  // something behind the modal -- but only when
  // waeAutoCloseOnNavigateEnabled() says so; see that setting's own
  // comment for why it's optional. Shows the InfoWindow on arrival
  // either way, as immediate visual confirmation regardless of whether
  // "Show on Map" pins are toggled on -- that part was never conditional
  // on autoclose, only whether the panel itself gets out of the way.
  async function waeGoToLocation(record) {
    if (!Number.isFinite(record.latitude) || !Number.isFinite(record.longitude)) return;
    const attached = await waeAttachToMapIfNeeded();
    if (!attached) {
      if (waeUI) log(waeUI.logEl, '✗ Could not find the Wayfarer map on this page -- try again from the mapview or the submit-Wayspot map.', 'err');
      return;
    }
    const map = WAE_PULSES.map;
    const latLng = new google.maps.LatLng(record.latitude, record.longitude);
    map.setCenter(latLng);
    const z = map.getZoom();
    if (typeof z === 'number' && z < 17) map.setZoom(17);
    if (waeAutoCloseOnNavigateEnabled()) closePanel();
    google.maps.event.addListenerOnce(map, 'idle', () => waeShowPulseInfoWindow(record, latLng));
  }

  // BUGFIX (not upstream): this used to be its own independent
  // localStorage flag, toggled only from this plugin's own "Show on Map"
  // button -- meaning it had no presence in the suite's own native
  // Layers menu (the stacked-squares icon next to the map's search bar),
  // unlike Wayspots/OSM/etc. Registered as a real WFMM.layers entry now
  // (see startPlugin()) instead, confirmed against the real source
  // (src/core/layers.js) -- that menu (src/plugins/map-ui/layers-menu.js)
  // just iterates WFMM.layers.list() and builds a plain checkbox per
  // entry, so registering ours is the entire integration; nothing else
  // to build for it to show up there with a working toggle. This is now
  // the single source of truth for on/off, backed by WFMM's own settings
  // persistence rather than this plugin's own. This plugin's own "Show
  // on Map" button was removed entirely in v1.33.0 once it became purely
  // redundant with that native checkbox -- the checkbox is the only way
  // to toggle this now, and this function is just reading whatever it's
  // currently set to.
  function isMapPulsesEnabled() {
    return wfmmWindow.WFMM.layers.isEnabled(WAE_LAYER_ID);
  }

  // The one place that actually reacts to the layer's on/off state
  // changing -- registered as the layer's own onChange in startPlugin().
  // The only way to toggle this is the native Layers menu now (v1.33.0
  // removed this plugin's own "Show on Map"/"Hide from Map" button,
  // since it was entirely redundant with that menu once the layer was
  // registered there -- see WAE_LAYER_ID's own comment) -- no button of
  // this plugin's own left to show a transient "Attaching to map..."
  // state on, or to disable/re-enable around the attach.
  async function waeApplyLayerEnabled(enabled) {
    if (enabled) {
      const attached = await waeAttachToMapIfNeeded();
      if (attached) {
        // BUGFIX: used to call waeSafeRefreshPulses() immediately here,
        // which drew nothing at all if waeAllRecords hadn't loaded yet
        // this session (see waeEnsureRecordsLoaded()'s own comment) --
        // toggling the layer off/on looked like it simply didn't work.
        // Awaited so the very first draw after turning this on always
        // has real data to draw from.
        await waeEnsureRecordsLoaded().catch(() => {}); // best-effort -- still try to draw with whatever's cached (likely []) rather than leave the layer on with a silent failure
        waeSafeRefreshPulses();
        // v1.53.4: Marked Wayspots' dots are gated on isMapPulsesEnabled()
        // now (see waeRenderMarkedWayspotMarkers()'s own comment), but
        // re-ticking this checkbox reuses the SAME map instance as before
        // (WAE_PULSES.map already pointed at it) -- waeSetCurrentMap()'s
        // guard clause means it won't re-fire its own render call the way
        // it does for a genuinely new map, so this has to ask explicitly.
        waeRenderMarkedWayspotMarkers();
      } else {
        if (waeUI) log(waeUI.logEl, '✗ Could not find the Wayfarer map on this page -- try again from the mapview or the submit-Wayspot map.', 'err');
        // Couldn't actually attach -- don't leave the layer claiming to
        // be on. Triggers this same function again (via onChange, since
        // the state genuinely changes false->true->false), which just
        // takes the `else` branch below and no-ops on an already-empty
        // set of markers.
        wfmmWindow.WFMM.layers.setEnabled(WAE_LAYER_ID, false);
      }
    } else {
      waeClearPulses();
      // v1.53.4: hide Marked Wayspots' dots the instant the box is
      // unticked, rather than leaving them up until the next list
      // mutation happens to call waeRenderMarkedWayspotMarkers() again --
      // isMapPulsesEnabled() already reflects the new (disabled) state by
      // this point, so the gate inside that function clears them here.
      waeRenderMarkedWayspotMarkers();
    }
  }

  // Re-syncs the map layer with whatever's currently in storage, but only
  // if the toggle is actually on -- called after scan/clear so the map
  // doesn't silently drift out of date while "Show on Map" is active, and
  // at bootstrap so a persisted-on toggle re-attaches on page load. The
  // bootstrap case is exactly where WAE_MAP_RETRY_LIMIT (see
  // waeStartMapTracking()'s own comment) matters most -- @run-at
  // document-start means this specific call can run before Angular/
  // Google Maps have actually finished initializing, so it's armed here
  // before attaching, not just left at whatever it happened to be.
  // Keeping in sync with view switches after this point is
  // waeStartMapTracking()'s job (see its own comment), not this
  // function's -- that's a one-time subscription set up in startPlugin(),
  // not something re-armed on every resync.
  async function waeResyncMapIfVisible() {
    if (!isMapPulsesEnabled()) return;
    waeMapRetriesLeft = WAE_MAP_RETRY_LIMIT;
    const attached = await waeAttachToMapIfNeeded();
    if (attached) {
      // BUGFIX: see waeEnsureRecordsLoaded()'s own comment -- this is
      // the actual first-page-load case that comment describes. Awaited
      // (not fire-and-forget) so the map's very first draw, right after
      // attaching on a fresh page load, has real data instead of [].
      await waeEnsureRecordsLoaded().catch(() => {});
      waeSafeRefreshPulses();
    }
  }


  // ---------------------------------------------------------------------
  // Scan-and-persist: runs scanImportedEmails() (below) and writes its
  // result to storage, carrying starred flags and CSV-imported rows
  // forward across the rebuild -- factored out of the panel's own Scan
  // button (buildPanelContent()'s scanBtn handler) so the exact same
  // logic can also run with no panel open at all. That's what the
  // external API right below this needs: the companion Abuse Email
  // Importer script's own "scan after import" checkbox triggers a scan
  // right after a Gmail sync/.eml import, which will essentially always
  // happen from ITS panel, not this one -- refreshPanel() alone bails out
  // entirely when waeUI is null (see its own comment), which was never a
  // problem before this function existed since a scan could previously
  // only be triggered by clicking a button inside this panel, guaranteeing
  // it was already open. Explicitly refreshes the map/review surfaces
  // here too, for exactly that externally-triggered, panel-closed case.
  async function waeScanAndPersist(onProgress) {
    // Fetched BEFORE the rebuild below wipes them -- carries starred
    // flags forward across a re-scan, which the full-rebuild-from-
    // scratch approach (see the comment a few lines down) would
    // otherwise silently lose every single time, same as it would
    // any other flag not sourced fresh from the emails themselves.
    await waeMigrateReportedHistory().catch(() => {});
    const previousRecords = await getAllExtractedRecords();
    const starredKeys = new Set(previousRecords.filter((r) => r.starred).map(waeStarredKey));
    // CSV-imported rows (see waeParseCsvImport()) don't come from a
    // scanned email at all, so there's nothing for a re-scan to
    // re-derive them from -- unlike every other row, wiping them in
    // the rebuild below would be permanent, not just "re-scan to get
    // them back". Set aside here and re-added after the rebuild
    // completes, same idea as the starred carry-over just above but
    // for whole rows rather than one field on rows that do get
    // re-derived.
    const csvRecords = previousRecords.filter((r) => r.source === 'csv');
    // Same idea for rows the user edited by hand (pencil column): the
    // scan would otherwise re-derive the ORIGINAL values and silently
    // throw the edit away. editedFromKey is the row's waeStarredKey()
    // from BEFORE its first edit, so the matching freshly-scanned row
    // can be dropped (instead of showing up next to the edited copy as
    // a duplicate) even when the edit changed the coordinates.
    // CSV-imported rows are already carried above, so they're excluded.
    const editedRecords = previousRecords.filter((r) => r.edited && r.source !== 'csv' && r.source !== 'reported');
    // v1.84.0: Wayspots reported from the draft (see waeAddReportedRecords()) -- no email behind them yet, so carried along like the CSV rows
    const reportedRecords = previousRecords.filter((r) => r.source === 'reported');

    const { extracted: scannedAll, ticketDetails } = await scanImportedEmails(onProgress);
    // Rows the user deleted by hand (see waeDeleteRecord()): a scan would
    // otherwise re-derive them from the source emails and bring them
    // straight back, so their identity keys are remembered and skipped.
    const deletedKeys = new Set(waeLoadDeletedRowKeys());
    const scanned = deletedKeys.size
      ? scannedAll.filter((r) => !deletedKeys.has(waeStarredKey(r)))
      : scannedAll;
    const editedOrigKeys = new Set(editedRecords.map((r) => r.editedFromKey).filter(Boolean));
    const extracted = editedOrigKeys.size
      ? scanned.filter((r) => !editedOrigKeys.has(waeStarredKey(r)))
      : scanned;
    // An edited row keeps its old id, which a re-scan may have reused
    // for a different row ("conv:X:0" style suffixes can shift) --
    // upserting by id would then overwrite one of them. Re-id on clash.
    const takenIds = new Set(extracted.map((r) => r.id));
    for (const r of editedRecords) {
      if (takenIds.has(r.id)) r.id = `${r.id}:edited:${Date.now().toString(36)}`;
      takenIds.add(r.id);
    }
    if (starredKeys.size) {
      for (const r of extracted) {
        if (starredKeys.has(waeStarredKey(r))) r.starred = true;
      }
    }
    // v1.84.0: a reported placeholder whose ticket this scan found is
    // replaced by that ticket's own row (its star carries over); the rest wait
    // for a later scan.
    const reportedKept = [];
    for (const placeholder of reportedRecords) {
      const match = waeFindTicketRowForReported(placeholder, extracted.concat(editedRecords));
      if (match) { if (placeholder.starred) match.starred = true; } else reportedKept.push(placeholder);
    }
    // Rebuild from scratch rather than upsert: a ticket's row count can
    // change between scans (a multi-location ticket now yields several
    // "conv:X:0" / "conv:X:1" / ... rows instead of one "conv:X" row),
    // and upserting alone would leave the old id's row behind as a
    // stale duplicate. Source data is the already-imported emails, so
    // a full rebuild is cheap and side-steps that entirely. Both
    // stores rebuild together -- ticketDetails is the per-ticket raw
    // text extractedReports' rows now reference via ticketKey rather
    // than each carrying their own copy (see EXTRACT_DB_VERSION note).
    await clearExtractedRecords();
    await clearTicketDetails();
    await putExtractedRecords([...extracted, ...csvRecords, ...editedRecords, ...reportedKept]);
    await putTicketDetails(ticketDetails);

    const ticketCount = new Set(extracted.concat(editedRecords).map((r) => r.conversationId || r.sourceEmailId)).size;
    const missingCoords = extracted.concat(editedRecords).filter((r) => r.latitude === null).length;

    await refreshPanel(); // no-op if the panel isn't open -- see its own comment
    if (!waeUI) {
      // refreshPanel() would otherwise have done exactly this -- see its
      // own comment on why that's nested under an early `if (!waeUI)
      // return` -- so it's repeated here for the panel-closed case.
      // v1.84.0: with fresh rows too -- the cached ones are from before this scan.
      try {
        waeAllRecords = await getAllExtractedRecords();
        waeRecordsById = new Map(waeAllRecords.map((r) => [r.id, r]));
        waeRecordsLoadPromise = Promise.resolve(waeAllRecords);
      } catch (e) { /* keep drawing from what is cached */ }
      if (WAE_PULSES.map && isMapPulsesEnabled()) waeSafeRefreshPulses();
      if (WAE_REVIEW_PULSES.map) waeSafeRefreshReviewPulses();
    }
    waeMarkListRenderHook?.(); // v1.85.0: an open draft list re-checks its "already reported" flags
    return { extractedCount: extracted.length + editedRecords.length, ticketCount, missingCoords };
  }

  // ---------------------------------------------------------------------
  // Scan: raw imported emails -> extracted rows
  // ---------------------------------------------------------------------

  async function scanImportedEmails(onProgress) {
    const allEmails = await WSTStorage.getAllEmails();

    // Pass 1: classify + parse every stored email into its own thread,
    // and group by conversationId. A long-running ticket can span
    // several separate email notifications -- Helpshift/the mailer only
    // includes a recent window of quoted history in each one, not
    // necessarily the complete conversation -- so a ticket's true
    // complete picture can require several stored emails, not just
    // whichever one happens to be newest. Emails with no conversationId
    // (couldn't be parsed as a ticket at all) each get their own
    // single-email group, keyed by record.id, same as before.
    const groups = new Map(); // key -> { threads: [], records: [] }
    let scanned = 0;

    for (const record of allEmails) {
      scanned++;
      if (onProgress) onProgress(scanned, allEmails.length);

      let email;
      try {
        email = new OPREmail.Email(record.headers, record.body);
      } catch (e) { continue; }

      let classification;
      try {
        classification = email.classify();
      } catch (e) { continue; }
      if (!classification || typeof classification.type !== 'string' || !classification.type.startsWith('ABUSE_REPORT_')) {
        continue;
      }

      let thread;
      try {
        thread = OPREmail.helpshift.parseThread(email.getBody('text/plain') || '', email.getFirstHeaderValue('Date', null));
      } catch (e) { continue; }

      const key = thread.conversationId ? `conv:${thread.conversationId}` : `email:${record.id}`;
      if (!groups.has(key)) groups.set(key, { threads: [], records: [] });
      const group = groups.get(key);
      group.threads.push(thread);
      group.records.push(record);
    }

    // Pass 2: merge each group's messages into one complete thread (a
    // no-op for single-email groups -- mergeThreads on one thread just
    // returns it), then extract locations/fields/status from that
    // complete picture instead of any single email's own partial view.
    const extracted = [];
    const ticketDetails = [];
    for (const [idBase, group] of groups.entries()) {
      const merged = OPREmail.helpshift.mergeThreads(group.threads);

      let parsed;
      try {
        parsed = OPREmail.helpshift.parseAbuseReportThread(merged);
      } catch (e) { continue; }

      const ticketStatus = OPREmail.helpshift.classifyAbuseReportStatus(merged.messages) || 'ABUSE_REPORT_UPDATED';

      // Per-ticket, not per-location -- same value on every row for this
      // ticket, same reasoning as ticketStatus just above. merged.messages
      // is already newest-first (mergeThreads' own re-sort, by actual
      // parsed timestamp -- see its comment), so [0] is reliably the
      // actual most recent message across every source email that fed
      // into this ticket, not just whichever export happened to be
      // scanned. An unparseable/missing timestamp (no messages at all,
      // or a date/time pair Date.parse() can't make sense of) leaves this
      // null rather than showing a wrong date -- the table/CSV both
      // already have an established "blank rather than guess" convention
      // for exactly this (see e.g. wayspotName).
      const newestMessage = merged.messages[0];
      const lastResponseAtMs = newestMessage ? Date.parse(`${newestMessage.date} ${newestMessage.time}`) : NaN;
      const lastResponseAt = Number.isNaN(lastResponseAtMs) ? null : lastResponseAtMs;

      // Multiple source emails can contribute to one merged ticket now --
      // list all of them (oldest first, matching the merged message
      // order's intent) rather than picking just one, so every email that
      // fed into this row's data is still traceable.
      const sourceEmailId = group.records.map((r) => r.id).join('; ');
      const sourceFilename = group.records.map((r) => r.filename).filter(Boolean).join('; ') || null;

      // issueType/locationDetails/reportDetails are per-TICKET, not
      // per-location -- written once here rather than duplicated onto
      // every location row below (see the v1.21.0 changelog note on
      // EXTRACT_DB_VERSION for why: a 12-location ticket used to store
      // the same ~2.4KB of raw text 12 times).
      ticketDetails.push({
        id: idBase,
        issueType: parsed.issueType || null,
        locationDetails: parsed.locationDetails || null,
        reportDetails: parsed.reportDetails || null,
      });

      // parsed.locations is every Wayspot found anywhere in the merged
      // thread -- the original report can list several at once, and
      // later replies ("I see I missed some: ...") can add more. One row
      // per location, all sharing conversationId/ticketStatus/ticketKey
      // so they're still recognizable as one ticket in the CSV. A ticket
      // with no parseable location at all still gets exactly one row (so
      // it's not silently dropped from the scan), with everything
      // location-related left null.
      const locations = parsed.locations && parsed.locations.length ? parsed.locations : [null];

      locations.forEach((loc, i) => {
        extracted.push({
          id: locations.length > 1 ? `${idBase}:${i}` : idBase,
          ticketKey: idBase,
          conversationId: parsed.conversationId || null,
          ticketStatus,
          lastResponseAt,
          wayspotName: loc ? loc.name : null,
          latitude: loc ? Number(loc.latitude) : null,
          longitude: loc ? Number(loc.longitude) : null,
          comment: loc ? (loc.comment || null) : null,
          sourceEmailId,
          sourceFilename,
          scannedAt: Date.now(),
        });
      });
    }

    return { extracted, ticketDetails };
  }

  // ---------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------

  const CSV_COLUMNS = [
    ['starred', 'Starred'],
    ['conversationId', 'Conversation ID'],
    ['ticketStatus', 'Ticket Status'],
    ['lastResponseAt', 'Last Response (UTC)'],
    ['wayspotName', 'Wayspot Name (best guess)'],
    ['latitude', 'Latitude'],
    ['longitude', 'Longitude'],
    ['comment', 'Comment'],
    ['nearbyTickets', 'Nearby Tickets (<20m, other tickets)'],
    ['issueType', 'Issue Type'],
    ['locationDetails', 'Location Details (raw)'],
    ['reportDetails', 'Report Details (raw)'],
    ['sourceEmailId', 'Source Email ID'],
    ['sourceFilename', 'Source Filename'],
  ];

  function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // BUGFIX (not upstream): issueType/locationDetails/reportDetails are
  // genuinely per-TICKET data (see the v1.21.0 changelog note on
  // EXTRACT_DB_VERSION) -- they're stored just once per ticket, in the
  // separate ticketDetails object store, precisely so a 12-location
  // ticket doesn't pay for 12 copies of the same raw text at rest.
  // getAllExtractedRecords() then transparently HYDRATES that one stored
  // copy back onto every location row sharing the ticket, so every
  // existing caller (table rendering, search, nearby-duplicate
  // detection) keeps seeing the same familiar per-row shape without
  // needing its own join logic -- that hydration is correct and
  // intentional for those callers. CSV export used to hand the fully
  // hydrated rows straight to recordsToCsv() too, though, which meant a
  // reader opening the file saw the same (often long) raw report text
  // repeated once per Wayspot the ticket reported -- reported as "many
  // duplicated texts" in the export (and, from the outside, easy to
  // mistake for the storage itself being duplicated, even though that
  // part was already fixed in v1.21.0). This keeps the raw ticket-level
  // text on only the FIRST row for a given ticketKey and blanks it on
  // every later row of that same ticket, purely for the exported file --
  // waeAllRecords / the on-screen table / getAllExtractedRecords() are
  // untouched, so nothing else loses the per-row hydration it relies on.
  // conversationId/ticketStatus/lastResponseAt stay on every row
  // deliberately -- they're short, and needed on every row to identify
  // which ticket it belongs to once the raw text below is blanked out.
  const WAE_TICKET_LEVEL_EXPORT_COLUMNS = ['issueType', 'locationDetails', 'reportDetails'];
  function waeDedupeTicketLevelColumnsForExport(records) {
    const seenTicketKeys = new Set();
    return records.map((r) => {
      const alreadySeen = seenTicketKeys.has(r.ticketKey);
      seenTicketKeys.add(r.ticketKey);
      if (!alreadySeen) return r;
      const deduped = { ...r };
      for (const key of WAE_TICKET_LEVEL_EXPORT_COLUMNS) deduped[key] = null;
      return deduped;
    });
  }

  function recordsToCsv(records) {
    const header = CSV_COLUMNS.map(([, label]) => csvEscape(label)).join(',');
    const rows = waeDedupeTicketLevelColumnsForExport(records)
      .map((r) => CSV_COLUMNS.map(([key]) => csvEscape(r[key])).join(','));
    return [header, ...rows].join('\r\n');
  }

  function downloadCsv(records) {
    // Leading BOM so Excel opens the UTF-8 file correctly instead of
    // guessing a legacy codepage and mangling any accented characters.
    const csv = '\uFEFF' + recordsToCsv(records);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `wayfarer-abuse-reports-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------------------------------------------------------------------
  // CSV import -- for locations that didn't come from a scanned email at
  // all (a known problem spot from another source, something a reviewer
  // wants to track manually, etc.) rather than anything this plugin
  // extracted itself. Deliberately forgiving: only Latitude/Longitude are
  // required, every other column is optional, and column names are
  // matched case-insensitively against a short list of common spellings
  // rather than requiring one exact header row -- someone hand-building a
  // CSV in a spreadsheet app is the expected case, not another export
  // from this same tool.
  //
  // A minimal RFC4180-ish parser (quoted fields, "" as an escaped quote
  // inside one, commas/newlines inside quotes) -- not the full spec (no
  // BOM stripping here specifically, since File.text() already decodes
  // as UTF-8 and a leading BOM character just ends up harmless leading
  // whitespace on the first header name once trimmed), but enough for
  // what a spreadsheet app or a hand-written file will actually produce.
  function csvParse(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; } // swallow bare \r -- \r\n handled by the \n case below, a lone \r (old Mac line endings) still just ends the row
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    // Final field/row if the file doesn't end in a newline.
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0].trim() === '')); // drop fully-blank trailing lines
  }

  // header -> column index, matched against a few common spellings per
  // field rather than one fixed name -- e.g. "Lat" and "Latitude" both
  // work, so does "Lng"/"Long"/"Longitude". Latitude/longitude are the
  // only ones that block the whole file if missing; everything else
  // just means that field comes back empty for every row.
  const WAE_CSV_COLUMN_ALIASES = {
    latitude: ['latitude', 'lat'],
    longitude: ['longitude', 'lng', 'long', 'lon'],
    wayspotName: ['name', 'wayspot name', 'wayspotname'],
    comment: ['comment', 'comments', 'note', 'notes'],
    conversationId: ['conversation id', 'conversationid', 'ticket', 'ticket id', 'ticketid'],
  };
  function waeMapCsvHeader(headerRow) {
    const normalized = headerRow.map((h) => h.trim().toLowerCase());
    const indexOf = {};
    for (const [field, aliases] of Object.entries(WAE_CSV_COLUMN_ALIASES)) {
      const idx = normalized.findIndex((h) => aliases.includes(h));
      if (idx !== -1) indexOf[field] = idx;
    }
    return indexOf;
  }

  // Returns { records, skipped, error }. `error` (a string) means the
  // whole file was rejected outright (no usable header); otherwise each
  // unparseable/out-of-range row is just skipped and counted rather than
  // failing the whole import over one bad line.
  function waeParseCsvImport(text) {
    const rows = csvParse(text);
    if (!rows.length) return { records: [], skipped: 0, error: 'That file is empty.' };
    const indexOf = waeMapCsvHeader(rows[0]);
    if (indexOf.latitude === undefined || indexOf.longitude === undefined) {
      return { records: [], skipped: 0, error: 'Could not find Latitude/Longitude columns in the header row -- see the format hint above the button.' };
    }
    const records = [];
    let skipped = 0;
    for (const cells of rows.slice(1)) {
      const lat = Number((cells[indexOf.latitude] || '').trim());
      const lng = Number((cells[indexOf.longitude] || '').trim());
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        skipped++;
        continue;
      }
      // Ticket ids are numeric -- strip anything else a CSV might carry
      // along with them (a leading "#", "Ticket #", stray whitespace) so
      // only the digits are stored. No digits at all -> null, same as an
      // empty cell.
      const conversationId = indexOf.conversationId !== undefined ? (cells[indexOf.conversationId] || '').replace(/\D/g, '') || null : null;
      // A stable id (ticket + rounded coordinates) when the row supplies
      // its own Conversation ID, so re-importing the same file updates
      // those rows instead of duplicating them -- there's no other
      // reliable dedup key for data that didn't come from this plugin's
      // own extraction in the first place. Falls back to a random id
      // when no Conversation ID is given, same as it would for any
      // other never-seen-before location.
      const id = conversationId
        ? `csv:${conversationId}:${lat.toFixed(6)},${lng.toFixed(6)}`
        : `csv:${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
      records.push({
        id,
        ticketKey: null,
        conversationId,
        ticketStatus: 'CSV_IMPORT',
        lastResponseAt: null,
        wayspotName: indexOf.wayspotName !== undefined ? (cells[indexOf.wayspotName] || '').trim() || null : null,
        latitude: lat,
        longitude: lng,
        comment: indexOf.comment !== undefined ? (cells[indexOf.comment] || '').trim() || null : null,
        sourceEmailId: null,
        sourceFilename: null,
        scannedAt: Date.now(),
        source: 'csv',
      });
    }
    return { records, skipped, error: null };
  }

  // -dialog / -title / -btn etc., confirmed against openModal() in Base's
  // real source) instead of a custom floating box -- centered, white,
  // blocks the rest of the page while open, closes on the × button,
  // Escape, or a click on the backdrop outside the dialog, matching every
  // other Map Mods - Base panel. "wae-" prefix throughout so nothing
  // collides with the importer script's "wei-" ids/classes.
  // ---------------------------------------------------------------------

  // Only the bits WFMM.ui's own base styles (injected by
  // ui.injectBaseStyles()/ui.openModal() itself) don't already cover --
  // the modal shell, buttons, inputs, section headers, empty/loading
  // states, and the table's core look all come from the suite's own
  // wfmm-* classes now, applied via WFMM.ui.createElement/button/
  // textInput/table/etc rather than reimplemented here. This is layered
  // ON TOP of ui.table()'s own .wfmm-table styling for the report-
  // specific semantics it doesn't know about (missing-value styling,
  // status badges, nearby-duplicate highlighting, the floating nearby-
  // ticket popover, which has no equivalent in the suite's UI service).
  const STYLE = `
    #wae-panel .wfmapmods-modal-dialog{ width:600px; max-width:calc(100vw - 24px); }
    .wae-sub{ font-size:11px; color:var(--wfmm-muted-text, #667085); margin-bottom:8px; }
    /* Holds the panel's summary line (countEl, "N reports across M tickets"
       or similar) on the left, and -- grouped together on the right, via
       .wae-panel-header-actions -- the small envelope + cog icon buttons
       that open the Email Importer panel and Marker Style settings. See
       buildPanelContent()'s own comments on emailImporterBtn/
       markerStyleBtn for why both live here (tucked next to this line)
       rather than as labeled buttons of their own. */
    .wae-panel-header-row{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
    .wae-panel-header-row .wae-sub{ margin-bottom:0; }
    .wae-panel-header-actions{ display:flex; align-items:center; gap:4px; flex-shrink:0; }
    /* Marked Wayspots -- the list modal's rows (waeBuildMarkedWayspotRow()).
       The "+" itself is styled separately (.wae-detail-mark-btn, in the
       side-panel-details section below) since it lives in the Wayspot
       details side panel, not this panel. */
    /* This dialog had no width of its own (only #wae-panel did), so it sized to
       its content -- a long Wayspot name widened the row past the dialog's
       max width, and the trailing \u00d7 got pushed out under the list's scrollbar
       instead of the name being ellipsized. Fixed width + every flex ancestor
       allowed to shrink (min-width:0) means the name truncates and the \u00d7
       always stays inside the visible row. */
    #wae-mark-list .wfmapmods-modal-dialog{ width:480px; max-width:calc(100vw - 24px); }
    .wae-mark-list{ max-height:320px; overflow-y:auto; overflow-x:hidden; scrollbar-gutter:stable; padding-right:8px; min-width:0; box-sizing:border-box; margin-top:8px; }
    /* The on-map dot for a Marked Wayspots entry (waeRenderMarkedWayspotMarkers()) --
       same absolute-positioned/centered pattern as .wae-pulse-marker,
       just its own class since it lives in a different pane
       (overlayMouseTarget, not overlayLayer -- see that function's own
       comment) and isn't subject to the clickable-or-not toggle the
       abuse-report crosses are. */
    .wae-mark-marker{ position:absolute; transform:translate(-50%, -50%); cursor:pointer; line-height:0; }
    .wae-mark-marker svg{ display:block; }
    .wae-list-icon-btn{ display:inline-flex; align-items:center; justify-content:center; padding:6px 10px; text-decoration:none; }
    .wae-list-icon-btn svg{ pointer-events:none; }
    .wae-btn-count{ margin-left:4px; font-size:11px; font-weight:600; line-height:1; }
    .wae-mark-row{ border:1px solid var(--wfmm-border, #e5e7eb); border-radius:6px; padding:6px 8px; margin-bottom:6px; min-width:0; max-width:100%; box-sizing:border-box; }
    .wae-mark-row-main{ display:flex; align-items:center; gap:8px; cursor:pointer; min-width:0; }
    .wae-mark-row-checkbox{ flex-shrink:0; margin:0; cursor:pointer; }
    .wae-clear-prompt{ display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:8px; margin-bottom:8px; font-size:12px; border:1px solid #fcd34d; background:#fffbeb; color:#78350f; border-radius:6px; }
    .wae-clear-prompt[hidden]{ display:none; }
    .wae-clear-prompt-text{ flex:1 1 200px; min-width:0; }
    .wae-mark-row-main:hover .wae-mark-row-name{ text-decoration:underline; }
    .wae-mark-row-name{ font-weight:600; font-size:12px; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .wae-mark-row-coord{ font-size:11px; color:var(--wfmm-muted-text, #667085); flex-shrink:0; white-space:nowrap; }
    .wae-mark-row-delete{ flex-shrink:0; border:none; background:none; color:var(--wfmm-muted-text, #667085); font-size:16px; line-height:1; cursor:pointer; padding:0 2px; }
    .wae-mark-row-delete:hover{ color:#dc2626; }
    .wae-row-total{ margin:6px 0 0; text-align:right; }
    .wae-mark-row-flag{ margin-top:4px; font-size:11px; font-weight:600; color:#b45309; word-break:break-word; }
    .wae-mark-row-note{ margin-top:4px; font-size:11px; color:var(--wfmm-muted-text, #667085); cursor:pointer; word-break:break-word; white-space:pre-wrap; }
    .wae-mark-row-note-empty{ font-style:italic; opacity:0.7; }
    .wae-mark-row-note-input{ margin-top:4px; width:100%; box-sizing:border-box; font:inherit; font-size:11px; resize:vertical; }
    /* Feature request: Favorite Users list -- same visual language
       (bordered row, small "\u00d7" remove button) as the Marked Wayspots
       rows just above -- now including a note line, same click-to-edit
       styling (.wae-favorite-user-note* mirrors .wae-mark-row-note*
       above) since favorite users can carry a note too. */
    .wae-favorite-user-row{
      border:1px solid var(--wfmm-border, #e5e7eb); border-radius:6px;
      padding:6px 8px; margin-bottom:6px; min-width:0; max-width:100%; box-sizing:border-box;
    }
    .wae-favorite-user-row-main{ display:flex; align-items:center; gap:8px; min-width:0; }
    .wae-favorite-user-checkbox{ flex-shrink:0; margin:0; cursor:pointer; }
    .wae-favorite-user-name{ font-size:12px; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .wae-favorite-user-remove{ flex-shrink:0; border:none; background:none; color:var(--wfmm-muted-text, #667085); font-size:16px; line-height:1; cursor:pointer; padding:0 2px; }
    .wae-favorite-user-remove:hover{ color:#dc2626; }
    .wae-favorite-user-note{ margin-top:4px; font-size:11px; color:var(--wfmm-muted-text, #667085); cursor:pointer; word-break:break-word; white-space:pre-wrap; }
    .wae-favorite-user-note-empty{ font-style:italic; opacity:0.7; }
    .wae-favorite-user-note-input{ margin-top:4px; width:100%; box-sizing:border-box; font:inherit; font-size:11px; resize:vertical; }
    /* Feature request: the submitter-username element itself, live in
       Wayfarer's own side panel -- see waeStartSidePanelDetailsWatcher()'s
       own comment. Underline-on-hover is the only affordance needed here
       (unlike the Marked Wayspots "+" row, this isn't adding a whole new
       row of controls to the panel) since the color change on click is
       itself immediate, visible feedback that something happened.
       Favorited color itself is applied inline (waeApplyFavoriteUsernameStyle()),
       not here, since it's user-customizable (Marker Style settings). */
    .wae-favorite-username-trigger{ cursor:pointer; }
    .wae-favorite-username-trigger:hover{ text-decoration:underline; }
    .wae-csv-hint{ white-space:pre-line; font-family:ui-monospace, monospace; }
    /* BUGFIX (not upstream): the crosses/clusters this plugin draws on the
       map used to be google.maps.Marker instances with a data: URI SVG
       as their icon -- fine on Chrome, but reported (and confirmed
       against WFMM's own source: its directly analogous "Report History"
       pulse layer, pulse-layer.js, deliberately avoids Marker + icon
       images entirely) as considerably slower on Firefox once a dataset
       grew into the hundreds. Marker's icon is an <img>, which goes
       through the browser's IMAGE decode pipeline -- Firefox's is
       measurably heavier than Chrome's for many small repeated data:
       URIs specifically. WFMM's own pulse layer instead positions a
       plain CSS-styled <div> per point via a custom
       google.maps.OverlayView (see WaePulseOverlay in the script itself)
       -- these two rules are that div's real content now: the SVG shape
       is set as actual inline markup (real DOM/SVG rendering, the same
       pipeline as any other on-page SVG, not the image pipeline), and
       .wae-pulse-count is a plain positioned label over it for a
       cluster's count, replacing what used to be a Marker's built-in
       .setLabel().
    */
    .wae-pulse-marker{ position:absolute; transform:translate(-50%, -50%); pointer-events:none; line-height:0; }
    .wae-pulse-marker.wae-pulse-clickable{ pointer-events:auto; cursor:pointer; }
    .wae-pulse-marker svg{ display:block; }
    /* v1.67.0: the review maps' crosses live in Google's markerLayer (see
       WaeReviewPulseOverlayCtor.onAdd()) and must out-stack the Wayspot
       markers there; an abuse draft cross sits just above a report cross
       at the same spot. Both are click-through, so this blocks nothing. */
    .wae-pulse-marker.wae-pulse-review{ z-index:2147483000; }
    .wae-pulse-marker.wae-pulse-review.wae-pulse-draft{ z-index:2147483001; }
    /* The invisible click-target twin WaePulseOverlayCtor's applyToDiv()
       creates in overlayMouseTarget -- see that class's own comment for
       why a second element is needed at all. opacity:0 (not visibility
       or display) so it still receives the DOM events overlayMouseTarget
       exists for, while never changing what's actually on screen -- the
       ORIGINAL div, still in overlayLayer, is what renders the visible
       cross/cluster graphic. */
    .wae-pulse-hit{ opacity:0; }
    .wae-pulse-count{ position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); color:#ffffff; font-size:10px; font-weight:700; pointer-events:none; user-select:none; }
    .wae-progress{ font-size:11px; color:#2563eb; margin:4px 0; min-height:14px; }
    .wae-log{ margin-top:8px; max-height:110px; overflow-y:auto; font-size:11px; line-height:1.5; }
    .wae-log div.ok{ color:#16a34a; }
    .wae-log div.warn{ color:#b45309; }
    .wae-log div.err{ color:#dc2626; }
    .wae-search-wrap{ position:relative; margin:6px 0; }
    .wae-search-wrap .wae-search-input{ margin:0; width:100%; box-sizing:border-box; padding-right:34px; }
    .wae-search-clear{ position:absolute; top:50%; right:8px; transform:translateY(-50%); display:none; align-items:center; justify-content:center; width:22px; height:22px; padding:0; border:0; border-radius:50%; background:transparent; color:inherit; opacity:.55; cursor:pointer; font-size:16px; line-height:1; }
    .wae-search-clear:hover{ opacity:1; background:rgba(128,128,128,.2); }
    .wae-search-wrap.wae-has-text .wae-search-clear{ display:flex; }
    /* Live Wayspot ticket annotation -- see waeStartSidePanelDetailsWatcher()'s
       own comment. Styled as a small badge-ish line (not plain text, and
       not one of the wae-status-badge pills either) so it reads as "this
       plugin added something here" without looking like it's part of
       Base's own card. */
    .wae-detail-ticket-line{
      font-size:11px; font-weight:600; color:#dc2626;
      margin:2px 0 6px; text-align:center;
    }
    /* "+" row (note field + button) added right alongside the
       ticket-number line above -- see waeStartSidePanelDetailsWatcher()'s
       own comment. A small plain button rather than a pill/badge like
       the ticket line itself, so it reads as clickable (an action)
       rather than as more status text. */
    .wae-detail-mark-row{ display:flex; align-items:stretch; gap:4px; margin:2px 0 6px; }
    .wae-detail-mark-note{
      flex:1 1 auto; min-width:0; padding:4px 6px;
      font-size:11px; font-family:Roboto, Arial, sans-serif;
      border:1px solid #c7d2fe; border-radius:5px; box-sizing:border-box;
      /* Explicit, not inherited: Wayfarer's dark theme hands inputs a
         light-grey text color while the field's own background stays
         white, which made typed notes nearly unreadable (v1.64.1).
         !important because the host page's own input rules can be
         more specific than a single class selector. */
      color:#111827 !important; background:#fff !important;
    }
    .wae-detail-mark-note::placeholder{ color:#6b7280 !important; opacity:1; }
    .wae-detail-mark-btn{
      flex:0 0 auto; padding:4px 8px; white-space:nowrap;
      font-size:11px; font-weight:600; font-family:Roboto, Arial, sans-serif;
      color:#154aab; background:#eef2ff; border:1px solid #c7d2fe; border-radius:5px;
      cursor:pointer; text-align:center;
    }
    .wae-detail-mark-btn:hover{ background:#e0e7ff; }
    /* Review-page row (copy icon + note + add button) -- see
       waeBuildReviewAbuseRow(). Reuses the side panel's note/button
       styles above; only the row layout and the copy icon are new. */
    /* v1.79.1: one row, never wrapped: the note field takes all the width
       the icon buttons to its right leave over (it shrinks, they don't). */
    .wae-review-abuse-row{ display:flex; align-items:center; gap:6px; flex-wrap:nowrap; width:100%; box-sizing:border-box; margin:4px 0; }
    .wae-review-abuse-row .wae-detail-mark-note{ flex:1 1 0; min-width:0; }
    .wae-review-copy-btn{
      flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center;
      padding:4px 6px; color:#154aab; background:#eef2ff;
      border:1px solid #c7d2fe; border-radius:5px; cursor:pointer;
    }
    .wae-review-copy-btn:hover{ background:#e0e7ff; }
    /* v1.76.0/1.77.0: the review row's buttons and the side panel's add
       button are all icons now and share one look. */
    .wae-review-form-link,
    .wae-review-fill-btn,
    .wae-detail-mark-btn.wae-icon-btn{
      flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center;
      padding:4px 6px; color:#154aab; background:#eef2ff; text-decoration:none;
      border:1px solid #c7d2fe; border-radius:5px; cursor:pointer;
    }
    .wae-review-form-link:hover,
    .wae-review-fill-btn:hover,
    .wae-detail-mark-btn.wae-icon-btn:not(:disabled):hover{ background:#e0e7ff; }
    .wae-review-fill-btn:disabled{ opacity:.45; cursor:not-allowed; }
    .wae-review-copy-btn.wae-copied{ color:#16a34a; background:#f0fdf4; border-color:#bbf7d0; }
    /* Note field + button inside a review map info window (see
       waeReviewIwSyncNow()). Stacked and sized to line up with the
       180px photo the suite's own windows show; reuses the side
       panel's field/button styles above. */
    .wae-review-iw-abuse{ display:flex; flex-direction:column; gap:4px; box-sizing:border-box; width:100%; min-width:160px; max-width:200px; margin:6px auto 0; }
    .wae-review-iw-abuse .wae-detail-mark-note{ width:100%; flex:0 0 auto; }
    .wae-review-iw-abuse .wae-detail-mark-btn{ width:100%; flex:0 0 auto; white-space:normal; }
    .wae-detail-mark-btn:disabled{ color:#16a34a; background:#f0fdf4; border-color:#bbf7d0; cursor:default; }
    /* Star toggle -- matches Report History's own \u2605/\u2606 button
       convention (plain glyph, no pill/border) rather than inventing a
       new visual language for what's already a familiar affordance. */
    .wae-star-cell{ text-align:center; cursor:pointer; }
    .wae-star-toggle{
      background:none; border:none; padding:0; margin:0; cursor:pointer;
      font-size:15px; line-height:1; color:#d97706;
    }
    .wae-star-toggle:hover{ color:#b45309; }
    /* Pencil / save / cancel buttons in the last column, same plain-glyph
       convention as the star toggle. */
    .wae-edit-cell{ text-align:center; white-space:nowrap; }
    .wae-edit-btn{
      background:none; border:none; padding:0 2px; margin:0; cursor:pointer;
      font-size:14px; line-height:1; color:#6b7280;
    }
    .wae-edit-actions{ display:flex; flex-direction:column; align-items:center; gap:3px; }
    .wae-edit-btn:hover{ color:#2563eb; }
    .wae-edit-btn.wae-edit-save{ color:#16a34a; font-weight:700; }
    .wae-edit-btn.wae-edit-cancel{ color:#6b7280; }
    .wae-edit-btn.wae-edit-delete{ color:#b91c1c; font-weight:700; }
    .wae-edited-mark{ color:#2563eb; font-size:10px; margin-left:2px; cursor:help; }
    tr.wae-row-editing td{ background:#eff6ff; }
    .wae-edit-input{
      width:100%; box-sizing:border-box; min-width:0; font:inherit; font-size:12px;
      padding:2px 4px; border:1px solid #9ca3af; border-radius:4px; background:#fff; color:#111827;
    }
    .wae-edit-input + .wae-edit-input{ margin-top:3px; }
    /* v1.87.1: the Wayspot Name cell of an unlocked row holds the name input
       and the note input. It used to be a .wae-edit-cell, whose nowrap put
       the two inputs side by side, so the note ended up cut off past the
       column's right edge. A column keeps them stacked at any column width. */
    .wae-edit-stack{ display:flex; flex-direction:column; gap:3px; min-width:0; }
    .wae-edit-stack .wae-edit-input + .wae-edit-input{ margin-top:0; }
    .wae-edit-input.wae-invalid{ border-color:#dc2626; background:#fef2f2; }
    /* BUGFIX v1.25.0: WFMM.ui.table()'s own base CSS (.wfmm-table) has no
       table-layout:fixed and no per-cell max-width/overflow -- columns
       size purely to content, so one long unbroken string (e.g. a URL)
       could blow a column out wide enough to push Status/the nearby-flag
       column out of the visible/scrollable area entirely. The old hand-
       rolled #wae-table had this constraint (max-width:160px + ellipsis
       on every td) and it silently didn't carry over when the table
       switched to WFMM.ui.table() -- fixed widths per column below (by
       position, since table() has no per-column width option) restore
       it.
       BUGFIX v1.29.2: percentages below were tuned for 7 columns and
       never revisited when the "Last Response" column was added
       (v1.28.0), landing it and Status (both real content -- a status
       pill, and a date + sort-arrow header -- not filler) too narrow for
       what they actually render. Only columns 1-2 had overflow:hidden at
       the time (the two free-text columns, the original overflow risk),
       so instead of wrapping or clipping, Status'/Last Response's own
       content just visually spilled out past their cell boundary into
       whatever sits next to them -- reported as the two columns
       "overlapping". Widths rebalanced below to actually fit a "Pending
       Review" badge and a wrapped two-line "Last Response ▼" header
       without that, and overflow:hidden now applies to every column, not
       just the two free-text ones -- so the next new column added here
       clips instead of bleeding into its neighbor if it's ever undersized
       the same way, rather than silently reproducing this exact bug
       again. */
    .wae-table{ table-layout: fixed; }
    /* Per-column widths used to be fixed here by nth-child position --
       now a <colgroup> waeMakeTableColumnsResizable() builds at render
       time controls each column's share instead (see that function's own
       comment for why a colgroup, specifically, rather than width on the
       header cells themselves), driven by WAE_TABLE_COLUMN_DEFAULTS/
       waeLoadTableColumnWidths() further up the file. table-layout:fixed
       above still needs to stay, though -- that's what makes a
       <colgroup>'s widths authoritative at all instead of every column
       just sizing to its own content. */
    .wae-table td{
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* Feature request: the actual drag handle waeMakeTableColumnsResizable()
       attaches to every header cell except the last -- a thin strip
       straddling the border between two columns (right:-3px, half its own
       6px width past the header cell's own right edge) so the hit target
       is centered ON the border a user would expect to drag, not offset
       to one side of it. th itself gets position:relative from that same
       function (JS, not here) so this absolute positioning is relative to
       the RIGHT header cell, not the table or the page. */
    .wae-col-resize-handle{
      position:absolute; top:0; right:-3px; width:6px; height:100%;
      cursor:col-resize; z-index:2;
    }
    .wae-col-resize-handle:hover{ background:rgba(37,99,235,0.35); }
    .wae-pagination{ display:flex; align-items:center; justify-content:center; gap:10px; margin-top:8px; }
    .wae-pagination .wae-sub{ margin:0; white-space:nowrap; }
    td.wae-missing{ color:#9ca3af; font-style:italic; }
    /* Feature request: the Wayspot Name cell now holds the name text and
       (when present) the nearby-ticket warning icon side by side -- name
       truncates with an ellipsis on its own (wae-name-text) rather than
       the whole cell, so the warning icon never gets pushed out of view
       by a long name the way it would sharing the cell's own
       overflow:hidden with no sub-layout of its own. */
    .wae-name-cell{ display:flex; align-items:center; gap:4px; min-width:0; }
    .wae-name-text{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
    .wae-nearby-trigger{ flex-shrink:0; cursor:help; }
    .wae-status-badge{
      display:inline-block; border:1px solid; border-radius:9999px;
      padding:1px 8px; font-size:10.5px; font-weight:600; white-space:nowrap;
    }
    tr.wae-row-nearby td{ background:#fffbeb; }
    tr.wae-row-clickable{ cursor:pointer; }
    tr.wae-row-clickable:hover td{ background:#fff7ed; }

    #wae-nearby-popover{
      position:fixed; z-index:2100; background:#fff; border:1px solid #e5e7eb;
      border-radius:6px; box-shadow:0 8px 24px rgba(0,0,0,0.18);
      padding:6px; max-width:320px; font-family:Roboto, Arial, sans-serif;
    }
    .wae-nearby-popover-title{
      font-size:11px; color:#6b7280; padding:2px 6px 6px; white-space:normal;
    }
    .wae-nearby-item{
      display:block; width:100%; text-align:left; background:none; border:none;
      border-radius:4px; padding:6px; font-size:12px; color:#111827; cursor:pointer;
      white-space:normal;
    }
    .wae-nearby-item:hover{ background:#fffbeb; }

    /* Review page (/new/review) toggle bar -- see waeInjectReviewToggle()'s
       and waePlaceReviewToggle()'s own comments for the full history.
       Lives in the page's own normal flow, directly under host inside
       waePlaceReviewToggle()'s own wrapper div (no position:fixed, no
       JS-computed top/left) -- v1.47.0's fixed-on-document.body version
       fixed a real placement bug but left the bar visibly floating a
       frame behind the page during scroll/resize; the wrapper's flex
       column keeps it pinned directly under the map without that.
       Kept its own opaque background/border/shadow even though it's
       embedded now rather than floating over arbitrary content --
       review cards can still place it next to a photo carousel or
       other non-uniform background, and it doubles as a visual
       separator between the map and whatever the reviewer's own
       controls render right below this bar.
       Dark/light color pair is chosen by the .wae-review-dark class,
       which waeInjectReviewToggle() sets directly on the bar itself from
       host.closest('.dark') rather than a ".dark .wae-review-toggle-bar"
       descendant selector, so it keeps working regardless of exactly
       where in the DOM the bar ends up relative to whatever ancestor
       carries that class. The prefers-color-scheme block stays too,
       purely as a fallback for the (currently unobserved) case of no
       ".dark" ancestor at all. */
    .wae-review-toggle-bar{
      position:static; box-sizing:border-box;
      display:flex; align-items:center; justify-content:space-between; gap:10px;
      margin:6px 0; padding:6px 10px; border-radius:6px;
      background:#ffffff; color:#111827; border:1px solid #d1d5db;
      box-shadow:0 1px 3px rgba(0,0,0,0.15);
      font-family:Roboto, Arial, sans-serif; font-size:12px; font-weight:600;
    }
    .wae-review-toggle-label{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .wae-review-toggle-btn{
      min-width:44px; padding:3px 10px; border-radius:9999px; cursor:pointer;
      font-size:11px; font-weight:700; line-height:1.4; flex-shrink:0;
      background:transparent; color:#111827; border:1px solid currentColor;
    }
    .wae-review-toggle-btn.wae-review-toggle-on{
      background:#16a34a; color:#ffffff; border-color:#15803d;
    }
    .wae-review-toggle-actions{ display:flex; align-items:center; gap:6px; flex-shrink:0; }
    .wae-review-toggle-icon-btn{
      display:inline-flex; align-items:center; justify-content:center;
      width:26px; height:24px; padding:0; border-radius:6px; cursor:pointer; flex-shrink:0;
      background:transparent; color:#111827; border:1px solid #d1d5db;
    }
    .wae-review-toggle-icon-btn:hover{ background:#f3f4f6; }
    .wae-review-toggle-icon-btn svg{ display:block; pointer-events:none; }
    @media (prefers-color-scheme: dark){
      .wae-review-toggle-bar{ background:#1f2937; color:#f9fafb; border-color:#4b5563; box-shadow:0 2px 6px rgba(0,0,0,0.5); }
      .wae-review-toggle-btn{ color:#f9fafb; }
      .wae-review-toggle-btn.wae-review-toggle-on{ background:#22c55e; color:#052e16; border-color:#16a34a; }
      .wae-review-toggle-icon-btn{ color:#f9fafb; border-color:#4b5563; }
      .wae-review-toggle-icon-btn:hover{ background:#374151; }
    }
    .wae-review-toggle-bar.wae-review-dark{ background:#1f2937; color:#f9fafb; border-color:#4b5563; box-shadow:0 2px 6px rgba(0,0,0,0.5); }
    .wae-review-toggle-bar.wae-review-dark .wae-review-toggle-btn{ color:#f9fafb; }
    .wae-review-toggle-bar.wae-review-dark .wae-review-toggle-icon-btn{ color:#f9fafb; border-color:#4b5563; }
    .wae-review-toggle-bar.wae-review-dark .wae-review-toggle-icon-btn:hover{ background:#374151; }
    .wae-review-toggle-bar.wae-review-dark .wae-review-toggle-btn.wae-review-toggle-on{ background:#22c55e; color:#052e16; border-color:#16a34a; }
  `;

  function log(container, msg, cls) {
    const line = waeUiApi.createElement('div', { className: cls || '', text: msg });
    container.prepend(line);
    while (container.children.length > 50) container.removeChild(container.lastChild);
  }

  // Friendly label + color per ticket status -- matches Niantic Support's
  // three confirmed canned closing replies (see opr-email-lib.js's
  // HELPSHIFT_TEMPLATES disambiguate()): ACTIONED means the report was
  // reviewed and acted on (nothing more to do here), PENDING means it's
  // still being looked into (revisit later), DENIED means it was
  // reviewed but didn't meet the removal criteria (also nothing more to
  // do, but distinct from ACTIONED). RECEIVED is just the initial
  // auto-ack; UPDATED is the catch-all for anything that isn't one of
  // those three canned replies (a custom reply, the reporter's own
  // follow-up being the newest message, etc.).
  const WAE_STATUS_BADGES = {
    // v1.84.0: reported from the draft, ticket not scanned yet (see waeAddReportedRecords())
    REPORTED_PENDING: { label: 'Reported', color: '#0891b2' },
    ABUSE_REPORT_RECEIVED: { label: 'Received', color: '#2563eb' },
    ABUSE_REPORT_PENDING: { label: 'Pending Review', color: '#b45309' },
    ABUSE_REPORT_ACTIONED: { label: 'Actioned', color: '#16a34a' },
    ABUSE_REPORT_DENIED: { label: 'Denied', color: '#6b7280' },
    ABUSE_REPORT_UPDATED: { label: 'Updated', color: '#6b7280' },
    // Not a real ticket status at all -- see waeParseCsvImport()'s own
    // comment. Placed last so sorting by Status still puts every genuine
    // abuse-report pipeline stage before it, rather than interleaving
    // with them at whatever rank an unrecognized value would otherwise
    // fall back to.
    CSV_IMPORT: { label: 'Imported', color: '#7c3aed' },
  };

  function waeStatusLabel(ticketStatus) {
    const info = WAE_STATUS_BADGES[ticketStatus];
    return info ? info.label : String(ticketStatus).replace('ABUSE_REPORT_', '');
  }

  // Status pipeline order (not alphabetical) -- Received -> Pending Review
  // -> a settled state (Actioned/Denied/Updated) -- so sorting by status
  // groups tickets by where they are in that pipeline instead of by
  // label text. Anything not in WAE_STATUS_BADGES (a status value this
  // plugin doesn't recognize) sorts last, after every known stage.
  const WAE_STATUS_SORT_RANK = Object.keys(WAE_STATUS_BADGES).reduce((m, key, i) => { m[key] = i; return m; }, {});
  function waeStatusSortRank(ticketStatus) {
    return ticketStatus in WAE_STATUS_SORT_RANK ? WAE_STATUS_SORT_RANK[ticketStatus] : 999;
  }


  function waeStatusBadgeEl(ticketStatus) {
    const info = WAE_STATUS_BADGES[ticketStatus] || { label: waeStatusLabel(ticketStatus), color: '#6b7280' };
    return waeUiApi.createElement('span', {
      className: 'wae-status-badge',
      text: info.label,
      style: { color: info.color, borderColor: info.color },
    });
  }

  // "Last Response" column -- the ticket's lastResponseAt (see
  // scanImportedEmails()'s own comment on where that comes from), shown
  // as a locale-formatted date/time. toLocaleDateString() alone for the
  // cell text (day-level precision is enough to scan a column of these
  // at a glance) with the full toLocaleString() -- date AND time -- in
  // the title attribute for whoever wants the exact time on hover, same
  // "short in the cell, full detail on hover" pattern the Wayspot Name
  // column already uses.
  function waeFormatLastResponse(ms) {
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    return { short: d.toLocaleDateString(), full: d.toLocaleString() };
  }

  // Identity key for carrying a starred flag across a re-scan -- NOT the
  // record's own `id`, which isn't reliably stable between scans (a
  // ticket's row count can change if extraction finds more/fewer
  // locations than last time, shifting the "conv:X:0"/"conv:X:1"-style
  // index suffixes -- see the scan handler's own "Rebuild from scratch"
  // comment for why that already rules out id-based upserting for the
  // rows themselves, and the same instability applies here). Coordinates
  // are what actually identify "the same real-world location" across two
  // scans of the same source emails, so ticket + coordinates is used
  // instead wherever a record has them; falling back to ticket + name for
  // the (rarer) case of a starred record with no coordinates, since
  // there's nothing else stable enough to key on there.
  function waeStarredKey(r) {
    const ticket = r.conversationId || r.sourceEmailId || '';
    if (Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) {
      return `${ticket}|${r.latitude.toFixed(6)},${r.longitude.toFixed(6)}`;
    }
    return `${ticket}|name:${r.wayspotName || ''}`;
  }

  // Feature request: makes an already-rendered wae-table's columns
  // user-resizable by dragging the border between two header cells.
  // Called fresh at the end of buildTableSection() on every render (that
  // whole table is torn down and rebuilt from scratch on every render
  // anyway -- see waeRenderFilteredTable() -- so there's no separate
  // "keep an existing colgroup in sync" case to maintain).
  //
  // A <colgroup> (one <col> per column, same order as the `columns` array
  // buildTableSection() itself builds) is what actually controls each
  // column's share of the table here, rather than setting width directly
  // on the header cells -- more reliable across browsers for a
  // table-layout:fixed table, some of which only really respect a
  // column's width from a table's very first row (which may or may not
  // count a <thead> row, depending on the engine); a <colgroup> has no
  // such ambiguity.
  //
  // Dragging a handle only ever trades width between the TWO columns it
  // sits between (their combined share stays constant) rather than
  // growing the table's overall width -- keeps every column's percentage
  // summing to 100% always, with no horizontal-scroll container needed
  // for this table (it's never had one).
  function waeMakeTableColumnsResizable(tableEl, columns) {
    tableEl.querySelector(':scope > colgroup')?.remove();
    const colgroup = document.createElement('colgroup');
    const widths = waeLoadTableColumnWidths();
    const cols = columns.map((col) => {
      const c = document.createElement('col');
      c.style.width = `${widths[col.key] ?? (100 / columns.length)}%`;
      colgroup.appendChild(c);
      return c;
    });
    tableEl.insertBefore(colgroup, tableEl.firstChild);

    const headerRow = tableEl.querySelector('thead tr');
    if (!headerRow) return; // defensive -- nothing to attach handles to
    const ths = Array.from(headerRow.children);

    ths.forEach((th, i) => {
      if (i >= columns.length - 1) return; // no handle after the last column -- nothing to its right to trade width with
      const handle = document.createElement('div');
      handle.className = 'wae-col-resize-handle';
      // Absolute-positioned relative to THIS header cell (not the table
      // or the page) -- th's own default position (static) would anchor
      // it to the nearest ALREADY-positioned ancestor instead, which
      // could be the table or scroll wrapper depending on what table()'s
      // own markup happens to do upstream of this.
      // Only anchors the handle itself if this header cell isn't already
      // a positioned element. Header cells of a sticky header are
      // `position: sticky` (already a containing block for the absolute
      // handle) -- forcing `relative` inline on them used to override
      // that, so every header cell but the last scrolled away with the
      // rows while the last one stayed stuck at the top as a white block
      // covering the first visible row's pencil. The table is still
      // detached from the document here, so computed style can't be read
      // yet; the check runs once it has been attached.
      th.appendChild(handle);
      requestAnimationFrame(() => {
        if (th.isConnected && getComputedStyle(th).position === 'static') th.style.position = 'relative';
      });

      handle.addEventListener('mousedown', (ev) => {
        // Stops this from also reaching whatever sort-on-click handling
        // table() itself put on this header cell (or a button inside
        // it) -- a drag to resize shouldn't also re-sort the column.
        ev.preventDefault();
        ev.stopPropagation();
        const tableWidth = tableEl.getBoundingClientRect().width;
        if (!tableWidth) return;
        const startX = ev.clientX;
        const startLeftPercent = parseFloat(cols[i].style.width) || 0;
        const startRightPercent = parseFloat(cols[i + 1].style.width) || 0;
        const leftKey = columns[i].key;
        const rightKey = columns[i + 1].key;
        const previousCursor = document.body.style.cursor;
        document.body.style.cursor = 'col-resize';

        const onMove = (moveEv) => {
          const deltaPercent = ((moveEv.clientX - startX) / tableWidth) * 100;
          let newLeft = startLeftPercent + deltaPercent;
          let newRight = startRightPercent - deltaPercent;
          // Floor enforcement moves the OTHER column's share by whatever
          // amount was clamped off this one, rather than just clamping
          // this one alone -- that's what keeps the pair's combined
          // share (and so the whole row's 100% total) exactly constant
          // through the clamp, not just before it.
          if (newLeft < WAE_TABLE_MIN_COLUMN_PERCENT) {
            newRight -= (WAE_TABLE_MIN_COLUMN_PERCENT - newLeft);
            newLeft = WAE_TABLE_MIN_COLUMN_PERCENT;
          }
          if (newRight < WAE_TABLE_MIN_COLUMN_PERCENT) {
            newLeft -= (WAE_TABLE_MIN_COLUMN_PERCENT - newRight);
            newRight = WAE_TABLE_MIN_COLUMN_PERCENT;
          }
          cols[i].style.width = `${newLeft}%`;
          cols[i + 1].style.width = `${newRight}%`;
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.style.cursor = previousCursor;
          // Re-reads current saved widths (rather than reusing `widths`
          // from this render) before writing back -- avoids clobbering a
          // change from some other, unrelated column drag that happened
          // to be saved in between this table's render and this drag
          // actually finishing.
          const latest = waeLoadTableColumnWidths();
          latest[leftKey] = parseFloat(cols[i].style.width);
          latest[rightKey] = parseFloat(cols[i + 1].style.width);
          waeSaveTableColumnWidths(latest);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Row editing (pencil column). Rows are "locked" by default; the pencil
  // at the end of a row unlocks that one row, turning each of its cells
  // into an input. Only one row is editable at a time -- starting another
  // edit discards the first one's unsaved draft. The draft lives here
  // (not in the DOM) so a re-render caused by paging/sorting/searching
  // doesn't lose what was typed.
  //
  // Saving mutates the record in place (same object waeAllRecords and
  // waeRecordsById already share -- same pattern as the star toggle),
  // marks it `edited` with `editedFromKey` (its identity BEFORE the
  // first edit, see waeScanAndPersist()) so a later re-scan carries the
  // edit across instead of wiping it, and upserts it to storage.
  // ---------------------------------------------------------------------
  let waeEditingId = null;
  let waeEditDraft = null;

  function waeToDatetimeLocalValue(ms) {
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function waeStartEdit(record) {
    waeEditingId = record.id;
    waeEditDraft = {
      conversationId: record.conversationId || '',
      wayspotName: record.wayspotName || '',
      comment: record.comment || '',
      coordinates: (Number.isFinite(record.latitude) && Number.isFinite(record.longitude))
        ? `${record.latitude.toFixed(6)}, ${record.longitude.toFixed(6)}`
        : '',
      ticketStatus: record.ticketStatus,
      lastResponse: waeToDatetimeLocalValue(record.lastResponseAt),
    };
    waeRenderFilteredTable();
    const first = waeUI && waeUI.tableContainer.querySelector('.wae-edit-input[data-field="wayspotName"]');
    if (first) first.focus();
  }

  function waeCancelEdit() {
    waeEditingId = null;
    waeEditDraft = null;
    waeRenderFilteredTable();
  }

  // Returns { latitude, longitude } or null when the text isn't valid.
  // Blank means "no coordinates" (both null), same as a scanned row
  // whose email had none.
  function waeParseCoordinateInput(text) {
    const t = (text || '').trim();
    if (!t) return { latitude: null, longitude: null };
    const parts = t.split(/[\s,;]+/).filter(Boolean);
    if (parts.length !== 2) return null;
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { latitude: lat, longitude: lng };
  }

  async function waeSaveEdit() {
    const record = waeRecordsById.get(waeEditingId);
    if (!record || !waeEditDraft) { waeCancelEdit(); return; }
    const draft = waeEditDraft;

    const coords = waeParseCoordinateInput(draft.coordinates);
    if (!coords) {
      const input = waeUI && waeUI.tableContainer.querySelector('.wae-edit-input[data-field="coordinates"]');
      if (input) { input.classList.add('wae-invalid'); input.focus(); }
      if (waeUI) log(waeUI.logEl, '\u2717 Coordinates must be "lat, lng" (e.g. 52.221500, 6.893700) or left blank.', 'err');
      return;
    }
    let lastResponseAt = null;
    if (draft.lastResponse) {
      const ms = new Date(draft.lastResponse).getTime();
      if (!Number.isFinite(ms)) {
        const input = waeUI && waeUI.tableContainer.querySelector('.wae-edit-input[data-field="lastResponse"]');
        if (input) { input.classList.add('wae-invalid'); input.focus(); }
        return;
      }
      lastResponseAt = ms;
    }

    // Identity before the FIRST edit only -- see waeScanAndPersist().
    if (!record.edited && record.source !== 'csv' && record.source !== 'reported') record.editedFromKey = waeStarredKey(record);
    record.edited = true;
    record.editedAt = Date.now();
    record.conversationId = draft.conversationId.trim() || null;
    record.wayspotName = draft.wayspotName.trim() || null;
    record.comment = draft.comment.trim() || null;
    record.latitude = coords.latitude;
    record.longitude = coords.longitude;
    record.ticketStatus = draft.ticketStatus;
    record.lastResponseAt = lastResponseAt;
    delete record._waeHaystack; // search text cache -- see waeMatchesQuery()

    waeEditingId = null;
    waeEditDraft = null;

    // Fresh array reference invalidates every cache keyed on
    // waeAllRecords identity (sort/filter, stats, nearby index).
    waeAllRecords = waeAllRecords.slice();
    waeRecordsLoadPromise = Promise.resolve(waeAllRecords);
    waeNearbyMap = waeFindNearbyDuplicates(waeAllRecords);
    waeNearbyMapFingerprint = waeRecordsFingerprint(waeAllRecords);
    waeRenderFilteredTable();
    if (WAE_PULSES.map && isMapPulsesEnabled()) waeSafeRefreshPulses();
    if (WAE_REVIEW_PULSES.map) waeSafeRefreshReviewPulses();

    try {
      await putExtractedRecords([record]);
    } catch (e) {
      if (waeUI) log(waeUI.logEl, `\u2717 Could not save edit: ${e.message || e}`, 'err');
    }
  }

  // Keys of rows deleted by hand, so a re-scan doesn't resurrect them.
  // Stored with the suite's settings (same mechanism as the Marked
  // Wayspots list), so they also travel with Settings > Backups.
  const WAE_DELETED_ROWS_SETTINGS_KEY = 'deletedRowKeys';

  function waeLoadDeletedRowKeys() {
    try {
      const list = wfmmWindow.WFMM.settings.get(PLUGIN_ID, WAE_DELETED_ROWS_SETTINGS_KEY, []);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function waeSaveDeletedRowKeys(list) {
    try {
      wfmmWindow.WFMM.settings.set(PLUGIN_ID, WAE_DELETED_ROWS_SETTINGS_KEY, list);
    } catch (e) { /* ignore -- next mutation attempt will just try again */ }
  }

  // Deletes one row for good (the x next to the pencil while editing).
  // Scanned rows are remembered by their pre-edit identity (editedFromKey
  // if they were edited, otherwise their current key) so the matching
  // freshly-scanned row is skipped on the next scan. CSV-imported rows
  // have no source email, so there is nothing to suppress for them.
  async function waeDeleteRecord(record) {
    if (!record) return;
    const label = record.wayspotName || '(unnamed)';
    // A ticket can hold several rows (one per reported Wayspot), and
    // this only ever removes the one row -- the prompt says so, and how
    // many sibling rows of the same ticket are left untouched.
    const ticketId = record.conversationId;
    const siblings = ticketId
      ? waeAllRecords.filter((r) => r.id !== record.id && r.conversationId === ticketId).length
      : 0;
    const scope = ticketId
      ? `This deletes only this single row, not the whole ticket (${ticketId}).`
        + (siblings ? ` The ${siblings} other row${siblings === 1 ? '' : 's'} of this ticket will be kept.` : '')
      : 'This deletes only this single row.';
    const csvNote = record.source === 'reported'
      ? ' It was added from your reported Wayspots and has no email behind it yet, so it cannot be recovered by re-scanning.'
      : record.source === 'csv'
      ? ' It was imported from a CSV, so it cannot be recovered by re-scanning.'
      : ' It will stay hidden when you re-scan; Clear Extracted Data brings deleted rows back on the next scan.';
    if (!confirm(`Delete the row "${label}"?\n\n${scope}${csvNote}`)) return;

    if (record.source !== 'csv' && record.source !== 'reported') {
      const key = record.editedFromKey || waeStarredKey(record);
      const keys = waeLoadDeletedRowKeys();
      if (!keys.includes(key)) {
        keys.push(key);
        waeSaveDeletedRowKeys(keys);
      }
    }

    waeEditingId = null;
    waeEditDraft = null;

    // Fresh array reference invalidates every cache keyed on
    // waeAllRecords identity (sort/filter, stats, nearby index).
    waeAllRecords = waeAllRecords.filter((r) => r.id !== record.id);
    waeRecordsById.delete(record.id);
    waeRecordsLoadPromise = Promise.resolve(waeAllRecords);
    waeNearbyMap = waeFindNearbyDuplicates(waeAllRecords);
    waeNearbyMapFingerprint = waeRecordsFingerprint(waeAllRecords);
    waeRenderFilteredTable();
    if (WAE_PULSES.map && isMapPulsesEnabled()) waeSafeRefreshPulses();
    if (WAE_REVIEW_PULSES.map) waeSafeRefreshReviewPulses();

    try {
      await deleteExtractedRecords([record.id]);
      if (waeUI) log(waeUI.logEl, `\u2713 Deleted "${label}".`, 'ok');
    } catch (e) {
      if (waeUI) log(waeUI.logEl, `\u2717 Could not delete row: ${e.message || e}`, 'err');
    }
  }

  // One input/select bound to a draft field. Enter saves, Escape cancels.
  function waeBuildEditInput(field, { type = 'text', placeholder = '', title = '' } = {}) {
    const input = waeUiApi.createElement('input', {
      className: 'wae-edit-input',
      attrs: { type, placeholder, title, 'data-field': field },
    });
    input.value = waeEditDraft[field] ?? '';
    input.addEventListener('input', () => {
      waeEditDraft[field] = input.value;
      input.classList.remove('wae-invalid');
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); waeSaveEdit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); waeCancelEdit(); }
    });
    return input;
  }

  function waeBuildStatusSelect() {
    const select = waeUiApi.createElement('select', {
      className: 'wae-edit-input',
      attrs: { 'data-field': 'ticketStatus' },
    });
    const keys = Object.keys(WAE_STATUS_BADGES);
    // A status this plugin doesn't recognize is kept as an option so
    // opening and saving a row never silently changes it.
    if (waeEditDraft.ticketStatus && !keys.includes(waeEditDraft.ticketStatus)) keys.push(waeEditDraft.ticketStatus);
    for (const key of keys) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = waeStatusLabel(key);
      select.appendChild(opt);
    }
    select.value = waeEditDraft.ticketStatus;
    select.addEventListener('change', () => { waeEditDraft.ticketStatus = select.value; });
    select.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); waeCancelEdit(); }
    });
    return select;
  }

  // Builds the table (or an empty-state) for the current page, using
  // WFMM.ui.table()/pager()/emptyState() instead of an innerHTML string --
  // see the v1.22.0 changelog note. table()'s own onRowClick fires for
  // ANY click on a row, so the nearby-flag trigger has to be special-cased
  // inside it (checked via event.target.closest()) rather than getting
  // its own listener the way the old delegated click handler on
  // #wae-table-container used to split these apart.
  function buildTableSection(sorted, hasQuery, nearbyMap) {
    if (!sorted.length) {
      return waeUiApi.emptyState(
        hasQuery
          ? 'No rows match that search.'
          : 'No abuse reports extracted yet -- click "Scan Imported Emails".'
      );
    }

    if (waeEditingId && !waeRecordsById.has(waeEditingId)) { waeEditingId = null; waeEditDraft = null; }

    const totalPages = Math.max(1, Math.ceil(sorted.length / WAE_PAGE_SIZE));
    if (waeCurrentPage > totalPages) waeCurrentPage = totalPages;
    if (waeCurrentPage < 1) waeCurrentPage = 1;
    const startIdx = (waeCurrentPage - 1) * WAE_PAGE_SIZE;
    const pageRecords = sorted.slice(startIdx, startIdx + WAE_PAGE_SIZE);

    const columns = [
      {
        // BUGFIX (not upstream): label was '' (matching the Comment/
        // Nearby icon columns, which are correctly blank since they're
        // NOT sortable) -- but combined with sortable: true, table()'s
        // own header-building code (children: [column.label ?? column.key,
        // marker]) renders a real, clickable sort button with genuinely
        // no visible text before it's ever been sorted by, since ''
        // isn't nullish and so doesn't fall through to column.key
        // either. The button technically existed and worked, there was
        // just nothing to see or reliably click -- reported as sorting
        // by star not being possible at all. A literal star as the
        // header label fixes both at once: something visible to click,
        // and it reads as "this column is about stars" on its own.
        key: 'starred', label: '\u2605', sortable: true, cellClassName: 'wae-star-cell',
        render: (r) => waeUiApi.createElement('button', {
          className: 'wae-star-toggle',
          text: r.starred ? '\u2605' : '\u2606',
          attrs: { type: 'button', title: r.starred ? 'Unstar' : 'Star' },
        }),
      },
      {
        key: 'conversation', label: 'Conversation', sortable: true,
        render: (r) => {
          if (waeEditingId === r.id) return waeBuildEditInput('conversationId', { placeholder: 'Conversation ID' });
          const v = r.conversationId || r.sourceEmailId;
          return waeUiApi.createElement('span', { text: v, attrs: { title: v } });
        },
      },
      {
        // Feature request: the note (formerly its own \uD83D\uDCAC column) and
        // the nearby-ticket warning (formerly its own \u26A0\uFE0F column) both
        // fold into this cell now -- name text first, nearby trigger
        // (still its own element with the same class/dataset onRowClick
        // already looks for, just relocated) appended after it when
        // there IS a nearby ticket. The note isn't shown as text at all
        // here; it's folded into this cell's own title so it only shows
        // on hover, same idea as a truncated name already showing its
        // full text on hover -- just two things in that same tooltip now
        // instead of one when there's a note to show.
        key: 'name', label: 'Wayspot Name',
        render: (r) => {
          if (waeEditingId === r.id) {
            const box = waeUiApi.createElement('div', { className: 'wae-edit-stack' });
            box.appendChild(waeBuildEditInput('wayspotName', { placeholder: 'Wayspot name' }));
            box.appendChild(waeBuildEditInput('comment', { placeholder: 'Note (optional)' }));
            return box;
          }
          const name = r.wayspotName || '(none found)';
          const titleParts = [name];
          if (r.comment) titleParts.push(`Note: ${r.comment}`);
          const cell = waeUiApi.createElement('span', {
            className: 'wae-name-cell',
            attrs: { title: titleParts.join('\n\n') },
          });
          cell.appendChild(waeUiApi.createElement('span', {
            className: r.wayspotName ? 'wae-name-text' : 'wae-name-text wae-missing',
            text: name,
          }));
          const nearby = nearbyMap && nearbyMap.get(r.id);
          if (nearby && nearby.length) {
            cell.appendChild(waeUiApi.createElement('span', {
              className: 'wae-nearby-trigger',
              text: '\u26A0\uFE0F',
              attrs: { title: 'Click to see nearby ticket(s)' },
              dataset: { nearbyId: r.id },
            }));
          }
          return cell;
        },
      },
      {
        // Feature request: Lat/Lng merged into one column, shown to two
        // decimal places (roughly 1km precision -- plenty for "is this
        // the same general area", which is all a table scan needs) with
        // the full six-decimal value on hover, same short-in-the-cell/
        // full-on-hover convention as Last Response's own column.
        key: 'coordinates', label: 'Coordinates',
        render: (r) => {
          if (waeEditingId === r.id) return waeBuildEditInput('coordinates', { placeholder: 'lat, lng', title: 'Latitude, longitude -- e.g. 52.221500, 6.893700' });
          if (r.latitude === null || r.longitude === null) {
            return waeUiApi.createElement('span', { className: 'wae-missing', text: '-' });
          }
          const short = `${r.latitude.toFixed(2)}, ${r.longitude.toFixed(2)}`;
          const full = `${r.latitude.toFixed(6)}, ${r.longitude.toFixed(6)}`;
          return waeUiApi.createElement('span', { text: short, attrs: { title: full } });
        },
      },
      {
        key: 'status', label: 'Status', sortable: true,
        render: (r) => (waeEditingId === r.id ? waeBuildStatusSelect() : waeStatusBadgeEl(r.ticketStatus)),
      },
      {
        key: 'lastResponse', label: 'Last Response', sortable: true,
        render: (r) => {
          if (waeEditingId === r.id) return waeBuildEditInput('lastResponse', { type: 'datetime-local' });
          const f = waeFormatLastResponse(r.lastResponseAt);
          return f
            ? waeUiApi.createElement('span', { text: f.short, attrs: { title: f.full } })
            : waeUiApi.createElement('span', { className: 'wae-missing', text: '-' });
        },
      },
      {
        // Pencil: unlocks this row for editing. While editing, it's
        // replaced by save (check), discard (undo arrow) and delete (x).
        // Clicks are handled in
        // onRowClick below via the .wae-edit-btn class, same pattern as
        // the star toggle.
        key: 'edit', label: '', cellClassName: 'wae-edit-cell',
        render: (r) => {
          const wrap = waeUiApi.createElement('span', {});
          if (waeEditingId === r.id) {
            // Stacked, not side by side: the pencil column is narrow and
            // three buttons in a row got clipped (the delete x vanished).
            wrap.className = 'wae-edit-actions';
            wrap.appendChild(waeUiApi.createElement('button', {
              className: 'wae-edit-btn wae-edit-save', text: '\u2713',
              attrs: { type: 'button', title: 'Save changes', 'data-action': 'save' },
            }));
            wrap.appendChild(waeUiApi.createElement('button', {
              className: 'wae-edit-btn wae-edit-cancel', text: '\u21A9',
              attrs: { type: 'button', title: 'Discard changes (Esc)', 'data-action': 'cancel' },
            }));
            wrap.appendChild(waeUiApi.createElement('button', {
              className: 'wae-edit-btn wae-edit-delete', text: '\u2715',
              attrs: { type: 'button', title: 'Delete this entry', 'data-action': 'delete' },
            }));
          } else {
            wrap.appendChild(waeUiApi.createElement('button', {
              className: 'wae-edit-btn', text: '\u270E',
              attrs: { type: 'button', title: r.edited ? 'Edit this row (edited by hand)' : 'Edit this row', 'data-action': 'edit' },
            }));
            if (r.edited) {
              wrap.appendChild(waeUiApi.createElement('span', {
                className: 'wae-edited-mark', text: '\u25CF',
                attrs: { title: 'Edited by hand -- kept across re-scans' },
              }));
            }
          }
          return wrap;
        },
      },
    ];

    const { wrap, tbody } = waeUiApi.table({
      columns,
      rows: pageRecords,
      className: 'wae-table',
      stickyHeader: true,
      maxHeight: 260,
      sortState: { key: waeSortKey, direction: waeSortDirection },
      onSort: (key) => {
        // Clicking the already-active column's header flips direction;
        // clicking a different sortable column switches to it, starting
        // ascending. Back to page 1 too -- sorting reshuffles which
        // records land on which page, so staying on e.g. page 3 after a
        // re-sort would show an arbitrary slice rather than what's
        // actually 3 pages in under the new order.
        waeSortDirection = (waeSortKey === key && waeSortDirection === 'asc') ? 'desc' : 'asc';
        waeSortKey = key;
        waeSaveSortState();
        waeCurrentPage = 1;
        waeRenderFilteredTable();
      },
      onRowClick: (record, rowIndex, event) => {
        const starToggle = event.target.closest('.wae-star-toggle');
        if (starToggle) {
          event.stopPropagation();
          const next = !record.starred;
          record.starred = next;
          starToggle.textContent = next ? '\u2605' : '\u2606';
          starToggle.title = next ? 'Unstar' : 'Star';
          // Fire-and-forget, same as Report History's own equivalent --
          // the visible toggle above already happened, so a slow/failed
          // write shouldn't block or roll back what the user just saw
          // happen. putExtractedRecords() upserts by id, and `record` is
          // the exact same object already held in waeAllRecords (not a
          // copy), so this persists the one changed field without
          // needing to touch or re-fetch anything else on the row.
          putExtractedRecords([record]).catch((e) => {
            if (waeUI) log(waeUI.logEl, `\u2717 Could not save star: ${e.message || e}`, 'err');
          });
          return;
        }
        const editBtn = event.target.closest('.wae-edit-btn');
        if (editBtn) {
          event.stopPropagation();
          const action = editBtn.dataset.action;
          if (action === 'edit') waeStartEdit(record);
          else if (action === 'save') waeSaveEdit();
          else if (action === 'cancel') waeCancelEdit();
          else if (action === 'delete') waeDeleteRecord(record);
          return;
        }
        // Clicking into an input of the row being edited must not also
        // jump the map to that row.
        if (waeEditingId === record.id) return;
        const flagTrigger = event.target.closest('.wae-nearby-trigger');
        if (flagTrigger) {
          event.stopPropagation();
          const nearby = nearbyMap.get(flagTrigger.dataset.nearbyId);
          if (nearby && nearby.length) waeOpenNearbyPopover(flagTrigger, nearby);
          return;
        }
        if (record.latitude !== null && record.longitude !== null) {
          waeGoToLocation(record);
        }
      },
    });

    wrap.classList.add('wae-table-scroll'); // v1.68.0: what waeFitTableToPanel() resizes

    // table() has no per-row className/title option -- applied directly
    // to the rendered <tr> elements afterward instead, matched back up to
    // pageRecords by index (same order table() rendered them in).
    pageRecords.forEach((record, i) => {
      const tr = tbody.children[i];
      if (!tr) return;
      const hasCoords = record.latitude !== null && record.longitude !== null;
      const nearby = nearbyMap && nearbyMap.get(record.id);
      if (waeEditingId === record.id) {
        tr.classList.add('wae-row-editing');
      } else if (hasCoords) {
        tr.classList.add('wae-row-clickable');
        tr.title = 'Click to locate on the map';
      }
      if (nearby && nearby.length) tr.classList.add('wae-row-nearby');
    });

    // table() has no per-column width option either -- see
    // waeMakeTableColumnsResizable()'s own comment just above
    // buildTableSection() for what this actually builds and why.
    const tableEl = wrap.tagName === 'TABLE' ? wrap : wrap.querySelector('table');
    if (tableEl) waeMakeTableColumnsResizable(tableEl, columns);

    const children = [wrap];
    if (totalPages > 1) {
      children.push(waeUiApi.pager({
        page: waeCurrentPage,
        pageCount: totalPages,
        label: `Page ${waeCurrentPage} of ${totalPages} (rows ${startIdx + 1}\u2013${Math.min(startIdx + WAE_PAGE_SIZE, sorted.length)} of ${sorted.length})`,
        onPage: (nextPage) => {
          waeCurrentPage = nextPage;
          waeRenderFilteredTable();
        },
        className: 'wae-pagination',
      }));
    }

    children.push(waeUiApi.createElement('div', {
      className: 'wae-sub wae-row-total',
      text: waeRowTotalText(sorted.length, waeAllRecords.length, WAE_TOTAL_NOUN_REPORTED),
    }));

    return waeUiApi.createElement('div', { children });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let waeFilteredSortedCache = null;
  let waeFilteredSortedCacheFor = null;

  // Only re-filters/re-sorts when the underlying data or the search query
  // actually changed since last time -- refreshPanel() always assigns a
  // fresh array to waeAllRecords on a real data reload, so comparing by
  // reference (not content) is enough to detect that cheaply. A pure page
  // turn (Prev/Next) calls waeRenderFilteredTable() with neither of those
  // changed, so it hits this cache instead of redoing the same filter and
  // sort pass across the whole dataset for the sake of showing 200
  // already-known rows.
  // Only re-filters/re-sorts when the underlying data, search query, or
  // sort column/direction actually changed since last time -- refreshPanel()
  // always assigns a fresh array to waeAllRecords on a real data reload,
  // so comparing by reference (not content) is enough to detect that
  // cheaply. A pure page turn (Prev/Next) calls waeRenderFilteredTable()
  // with none of those changed, so it hits this cache instead of redoing
  // the same filter and sort pass across the whole dataset for the sake
  // of showing 200 already-known rows.
  function waeGetFilteredSorted() {
    const q = waeSearchQuery.trim().toLowerCase();
    if (
      waeFilteredSortedCacheFor
      && waeFilteredSortedCacheFor.recordsRef === waeAllRecords
      && waeFilteredSortedCacheFor.query === q
      && waeFilteredSortedCacheFor.sortKey === waeSortKey
      && waeFilteredSortedCacheFor.sortDirection === waeSortDirection
    ) {
      return waeFilteredSortedCache;
    }
    const filtered = q ? waeAllRecords.filter((r) => waeMatchesQuery(r, q)) : waeAllRecords;
    const dir = waeSortDirection === 'asc' ? 1 : -1;
    let compare;
    if (waeSortKey === 'starred') {
      // Ascending (the default the first time this header's clicked)
      // means starred-first here, not literally "false before true" --
      // that reads as the useful default (show me what I starred),
      // matching Report History's own "Starred first" wording for what
      // amounts to the same sort.
      compare = (a, b) => dir * ((a.starred ? 0 : 1) - (b.starred ? 0 : 1));
    } else if (waeSortKey === 'conversation') {
      compare = (a, b) => dir * String(a.conversationId || a.sourceEmailId).localeCompare(String(b.conversationId || b.sourceEmailId), undefined, { numeric: true, sensitivity: 'base' });
    } else if (waeSortKey === 'status') {
      compare = (a, b) => dir * (waeStatusSortRank(a.ticketStatus) - waeStatusSortRank(b.ticketStatus));
    } else if (waeSortKey === 'lastResponse') {
      // Missing/unparseable timestamps sort last regardless of direction
      // -- "no known last-response date" isn't meaningfully "oldest" or
      // "newest", it's just unknown, so it shouldn't jump to the top on
      // a descending sort the way treating it as 0/-Infinity would.
      // Number.isFinite() rather than checking specifically for null --
      // a record extracted before this column existed has no
      // lastResponseAt property at all (undefined), not null, and both
      // need the same "unknown" treatment here.
      compare = (a, b) => {
        const af = Number.isFinite(a.lastResponseAt);
        const bf = Number.isFinite(b.lastResponseAt);
        if (!af && !bf) return 0;
        if (!af) return 1;
        if (!bf) return -1;
        return dir * (a.lastResponseAt - b.lastResponseAt);
      };
    } else {
      // Default/original behavior -- newest-scanned first, direction not
      // user-adjustable since there's no header for it to click.
      compare = (a, b) => (b.scannedAt || 0) - (a.scannedAt || 0);
    }
    const sorted = filtered.slice().sort(compare);
    waeFilteredSortedCache = sorted;
    waeFilteredSortedCacheFor = { recordsRef: waeAllRecords, query: q, sortKey: waeSortKey, sortDirection: waeSortDirection };
    return sorted;
  }

  let waeStatsCache = null;
  let waeStatsCacheFor = null;

  // Same idea as waeGetFilteredSorted -- these three counts only depend
  // on waeAllRecords itself, never the current page or search query, so
  // recomputing three O(n) passes over the full dataset on every single
  // render (including a plain page turn) was pure waste.
  function waeGetStats() {
    if (waeStatsCacheFor === waeAllRecords) return waeStatsCache;
    waeStatsCache = {
      withCoords: waeAllRecords.filter((r) => r.latitude !== null && r.longitude !== null).length,
      withName: waeAllRecords.filter((r) => r.wayspotName).length,
      ticketCount: new Set(waeAllRecords.map((r) => r.conversationId || r.sourceEmailId)).size,
    };
    waeStatsCacheFor = waeAllRecords;
    return waeStatsCache;
  }

  // ---------------------------------------------------------------------
  // v1.68.0: the table follows the panel's size. Its height used to be a
  // fixed 260px (the max-height passed to ui.table() in
  // buildTableSection()), so resizing the panel taller just left empty
  // space under it, and smaller made the whole panel body scroll instead.
  //
  // How the suite's resizable modals work (desktop-modal-interactions.js):
  // dragging the corner handle puts an explicit pixel height on the
  // dialog element, which is a flex column whose body scrolls. So:
  //  - dialog has no explicit height (never resized, or phone layout) ->
  //    the table keeps its stock 260px;
  //  - dialog has one -> the table gets exactly the space the rest of the
  //    body leaves free, so it shows more rows when the panel is made
  //    taller and fewer (down to WAE_TABLE_MIN_HEIGHT) when shorter.
  // The table's max-height is the suite's own --wfmm-table-max-height CSS
  // variable on its wrapper (what ui.table({ maxHeight }) sets).
  //
  // Re-fitted when: the dialog or any other block in the panel changes
  // size (ResizeObserver -- covers the resize drag, the progress bar and
  // log growing, the CSV hint, ...), and after every table render (a
  // render replaces the wrapper, which starts at the stock height again).
  // Setting the table's own height never resizes anything observed (the
  // table container isn't observed, and a resized dialog has a fixed
  // height), so this can't feed back on itself.
  // ---------------------------------------------------------------------
  const WAE_TABLE_BASE_HEIGHT = 260; // px -- unchanged stock height
  const WAE_TABLE_MIN_HEIGHT = 120;  // px -- header row plus a couple of rows
  let waePanelFit = null;            // { dialog, body, observer, raf }

  function waeFitTableToPanel() {
    const fit = waePanelFit;
    if (!fit || !waeUI) return;
    const scroller = waeUI.tableContainer.querySelector('.wae-table-scroll');
    if (!scroller) return;
    const setHeight = (px) => scroller.style.setProperty('--wfmm-table-max-height', `${px}px`);
    if (!(parseFloat(fit.dialog.style.height) > 0)) {
      setHeight(WAE_TABLE_BASE_HEIGHT);
      return;
    }
    const { body } = fit;
    const last = body.lastElementChild;
    if (!last) return;
    // Bottom of the body's content in content coordinates (so a scrolled
    // body still measures right), plus what sits below it: the last
    // block's bottom margin and the body's bottom padding.
    const contentBottom = last.getBoundingClientRect().bottom - body.getBoundingClientRect().top + body.scrollTop
      + (parseFloat(getComputedStyle(last).marginBottom) || 0)
      + (parseFloat(getComputedStyle(body).paddingBottom) || 0);
    const everythingElse = contentBottom - scroller.getBoundingClientRect().height;
    const available = Math.floor(body.clientHeight - everythingElse);
    setHeight(Math.max(WAE_TABLE_MIN_HEIGHT, available));
  }

  // One fit per frame however many resize notifications arrive.
  function waeSchedulePanelFit() {
    const fit = waePanelFit;
    if (!fit || fit.raf) return;
    fit.raf = requestAnimationFrame(() => {
      fit.raf = 0;
      waeFitTableToPanel();
    });
  }

  function waeStartPanelFit(modal, tableContainer) {
    waeStopPanelFit();
    if (typeof ResizeObserver !== 'function' || !modal.dialog || !modal.body) return;
    const fit = { dialog: modal.dialog, body: modal.body, observer: null, raf: 0 };
    fit.observer = new ResizeObserver(() => waeSchedulePanelFit());
    waePanelFit = fit;
    fit.observer.observe(modal.dialog);
    for (const child of modal.body.children) {
      if (child !== tableContainer) fit.observer.observe(child);
    }
  }

  function waeStopPanelFit() {
    if (!waePanelFit) return;
    waePanelFit.observer?.disconnect();
    if (waePanelFit.raf) cancelAnimationFrame(waePanelFit.raf);
    waePanelFit = null;
  }

  // v1.87.0: the scrollable ancestor of `el` (the panel body when it is
  // taller than the dialog), or null.
  function waeScrollParent(el) {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return null;
  }

  // Which page / sort / search the table was last drawn for. A re-render
  // for the same view (an edit, star, delete, cancel ...) keeps the scroll
  // position instead of jumping back to the top; a different view (page
  // turn, sort, search) starts at the top as before.
  let waeLastRenderView = null;

  function waeRenderFilteredTable() {
    if (!waeUI) return; // panel isn't open -- nothing to render into
    const q = waeSearchQuery.trim().toLowerCase();
    const sorted = waeGetFilteredSorted();

    // v1.87.0: remember where the table (and the panel body around it) is
    // scrolled to -- drawing a fresh table resets both
    const oldScroller = waeUI.tableContainer.querySelector('.wae-table-scroll');
    const bodyScroller = waeScrollParent(waeUI.tableContainer);
    const keep = {
      top: oldScroller ? oldScroller.scrollTop : 0,
      left: oldScroller ? oldScroller.scrollLeft : 0,
      bodyTop: bodyScroller ? bodyScroller.scrollTop : 0,
    };

    waeUiApi.empty(waeUI.tableContainer);
    waeUI.tableContainer.appendChild(buildTableSection(sorted, !!q, waeNearbyMap));
    waeFitTableToPanel(); // v1.68.0: the fresh table starts at the stock height

    const view = `${waeCurrentPage}|${waeSortKey}|${waeSortDirection}|${q}`;
    if (view === waeLastRenderView) {
      const newScroller = waeUI.tableContainer.querySelector('.wae-table-scroll');
      if (newScroller) { newScroller.scrollTop = keep.top; newScroller.scrollLeft = keep.left; }
      if (bodyScroller) bodyScroller.scrollTop = keep.bodyTop;
    }
    waeLastRenderView = view;

    const { withCoords, withName, ticketCount } = waeGetStats();
    const nearbyCount = waeNearbyMap.size;
    let base = `${waeAllRecords.length} location(s) extracted from ${ticketCount} ticket(s) -- ${withCoords} with coordinates, ${withName} with a name guess.`;
    if (nearbyCount) base += ` \u26A0\uFE0F ${nearbyCount} within ${WAE_NEARBY_THRESHOLD_METERS}m of a report from another ticket.`;
    waeUI.countEl.textContent = q ? `${sorted.length} match${sorted.length === 1 ? '' : 'es'} -- ${base}` : base;

    waeUI.exportBtn.disabled = waeAllRecords.length === 0;
    waeUI.clearBtn.disabled = waeAllRecords.length === 0;
  }

  let waeNearbyMapFingerprint = null;

  // Cheap "did the underlying record set change" check -- count alone
  // would miss a rescan that happens to produce the same number of rows,
  // but the scan handler always clears and rewrites the whole store with
  // a fresh Date.now() scannedAt on every row (see its own v1.4.0 note),
  // so the latest scannedAt changes on every real scan even when the
  // count doesn't.
  function waeRecordsFingerprint(records) {
    let maxScannedAt = 0;
    for (const r of records) if (r.scannedAt > maxScannedAt) maxScannedAt = r.scannedAt;
    return `${records.length}:${maxScannedAt}`;
  }

  async function refreshPanel() {
    if (!waeUI) return; // panel isn't open
    try {
      await waeMigrateReportedHistory().catch(() => {});
      waeAllRecords = await getAllExtractedRecords();
      waeRecordsById = new Map(waeAllRecords.map((r) => [r.id, r]));
      // Keeps waeEnsureRecordsLoaded()'s cache in sync with this fresher
      // read, rather than leaving it pointed at whatever (possibly
      // stale, possibly still-empty) data it resolved with earlier --
      // a review map or a layer toggle-on right after this shouldn't
      // redraw from data older than what the panel itself just showed.
      waeRecordsLoadPromise = Promise.resolve(waeAllRecords);
    } catch (e) {
      waeUI.countEl.textContent = 'Could not read extracted-report storage.';
      return;
    }
    // This used to recompute unconditionally, which meant a full O(n^2)
    // (now grid-bucketed, but still real work) nearby-duplicate scan on
    // every single panel open, not just when data actually changed --
    // with a few thousand accumulated rows that was slow enough to
    // visibly hang the page right as the panel opened. Skipping it when
    // nothing changed since last time is what actually fixes that.
    const fp = waeRecordsFingerprint(waeAllRecords);
    if (fp !== waeNearbyMapFingerprint) {
      waeNearbyMap = waeFindNearbyDuplicates(waeAllRecords);
      waeNearbyMapFingerprint = fp;
    }
    waeRenderFilteredTable();
    // BUGFIX: see waeEnsureRecordsLoaded()'s own comment -- opening the
    // panel used to only ever refresh the table, never the map, so
    // whichever surface (mapview/submit crosses, the review-page
    // markers) happened to already be attached wouldn't pick up
    // whatever just loaded here until its own next pan/zoom. Only
    // redraws a surface that's actually attached right now -- this
    // isn't what makes either surface attach or turn on in the first
    // place, same restraint waeSaveAppearance() already applies.
    if (WAE_PULSES.map && isMapPulsesEnabled()) waeSafeRefreshPulses();
    if (WAE_REVIEW_PULSES.map) waeSafeRefreshReviewPulses();
  }

  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // Marked Wayspots -- feature request: a "+" button on the Wayspot
  // details side panel (see waeStartSidePanelDetailsWatcher(), where it's
  // actually added -- right alongside the existing ticket-number
  // annotation, per the request) records the currently-shown Wayspot's
  // name/coordinates into a small persistent list, editable with a
  // per-entry note, viewable/copyable/clearable from its own modal
  // (waeOpenMarkedWayspotListModal(), opened via markListBtn on the main
  // panel). Meant as a scratch list to copy from while filing an actual
  // abuse report elsewhere (Niantic's own form/email), not a duplicate of
  // the ticket-tracking table above -- nothing here reads from or writes
  // to waeAllRecords/the extracted-report storage.
  //
  // Persisted via WFMM.settings, same mechanism as appearance/
  // autoCloseOnNavigate elsewhere in this file -- a handful to a few
  // dozen manually-marked entries is a trivially small amount of data
  // next to what that's already used for.
  //
  // (Two earlier approaches to WHERE/HOW this "+" gets clicked didn't
  // survive first contact with real use: a capturing map-click listener
  // that could only guess at the Wayspot's name since Wayfarer's markers
  // render through deck.gl with no DOM element to read one off, then a
  // global "arm marking mode, then click a Wayspot" toggle once the name
  // problem was fixed via WFMM.selection/WFMM.pois -- reported back as
  // not the wanted interaction. Individual Wayspots need their own "+",
  // not a separate mode, hence this landing in the side panel instead.)
  // ---------------------------------------------------------------------

  const WAE_MARK_LIST_SETTINGS_KEY = 'markedWayspots';

  function waeLoadMarkedWayspots() {
    try {
      const list = wfmmWindow.WFMM.settings.get(PLUGIN_ID, WAE_MARK_LIST_SETTINGS_KEY, []);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function waeSaveMarkedWayspots(list) {
    try {
      wfmmWindow.WFMM.settings.set(PLUGIN_ID, WAE_MARK_LIST_SETTINGS_KEY, list);
    } catch (e) { /* ignore -- next mutation attempt will just try again */ }
  }

  function waeAddMarkedWayspot({ name, lat, lng, note }) {
    const list = waeLoadMarkedWayspots();
    // Feature request: adding a Wayspot that's already on this list --
    // matched on coordinates, not name, since the side-panel title can
    // read blank/"Untitled location" for the very same physical Wayspot
    // depending on what happened to be rendered at click time (see this
    // watcher's own name-reading comment above) -- now updates that
    // existing entry's note in place instead of pushing a second entry
    // for the same Wayspot. Coordinates come from the same WFMM/side-panel
    // source every time, so an exact match at toFixed(6) precision -- the
    // same precision this file already keys duplicate/identity checks on
    // elsewhere (the CSV-row key, the review-page pulse key) -- is enough
    // here; no Haversine "nearby" fuzz-match needed the way it is for
    // independently-typed abuse-report coordinates (waeFindNearbyDuplicates()).
    const existing = list.find((item) =>
      Number(item.lat).toFixed(6) === Number(lat).toFixed(6) &&
      Number(item.lng).toFixed(6) === Number(lng).toFixed(6)
    );
    let result;
    if (existing) {
      existing.note = note || '';
      // Keep the name in sync too, but only ever upgrade a blank one --
      // never clobber a real title with a blank one from a stale re-read.
      if (name) existing.name = name;
      existing.markedAt = Date.now();
      result = 'updated';
    } else {
      list.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: name || '',
        lat,
        lng,
        note: note || '',
        markedAt: Date.now(),
      });
      result = 'added';
    }
    waeSaveMarkedWayspots(list);
    waeMarkListRenderHook?.();
    waeRenderMarkedWayspotMarkers();
    return result;
  }

  // Set by waeRenderMarkedWayspotListSection() (below) to its own render()
  // while that modal is open, cleared on close -- lets waeAddMarkedWayspot()
  // above keep the list modal's own view in sync with entries added by
  // clicking the map WHILE the list modal happens to already be open,
  // without the two having any other reference to each other.
  let waeMarkListRenderHook = null;

  // ---------------------------------------------------------------------
  // v1.84.0: Wayspots reported from the draft. They become rows of the
  // abuse reports table itself (source 'reported', status "Reported", no
  // ticket number yet) -- and ONLY the "Clear them" answer to the
  // after-submit question (see waeRenderMarkedWayspotListSection()) puts
  // them there; the x on a row, the trash button and every other removal
  // just delete. A scan carries these rows along (waeScanAndPersist()) until
  // it finds the ticket for them -- a ticket row within
  // WAE_NEARBY_THRESHOLD_METERS whose newest message is not older than the
  // report -- and then drops the placeholder, since the real row replaces
  // it.
  // ---------------------------------------------------------------------
  // The ticket dates are parsed without a time zone, hence a day of slack.
  const WAE_REPORTED_LINK_SLACK_MS = 24 * 60 * 60 * 1000;
  // v1.83.0 kept these in a separate history list in the settings; moved
  // into the table by waeMigrateReportedHistory().
  const WAE_REPORTED_SETTINGS_KEY = 'reportedWayspots';

  function waeBuildReportedRecord(item, at) {
    return {
      id: `reported:${at}-${Math.random().toString(36).slice(2, 8)}`,
      ticketKey: null,
      conversationId: null,
      ticketStatus: 'REPORTED_PENDING',
      lastResponseAt: at,
      reportedAt: at,
      wayspotName: item.name || null,
      latitude: Number(item.lat),
      longitude: Number(item.lng),
      comment: item.note || null,
      sourceEmailId: null,
      sourceFilename: null,
      scannedAt: at,
      source: 'reported',
    };
  }

  // The ticket row (from `rows`) a reported placeholder turned into, or
  // null while there is none. Of several the oldest qualifying one wins,
  // i.e. the one filed first after the report.
  function waeFindTicketRowForReported(placeholder, rows) {
    const lat = Number(placeholder.latitude);
    const lng = Number(placeholder.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const earliest = (Number(placeholder.reportedAt) || Number(placeholder.lastResponseAt) || 0) - WAE_REPORTED_LINK_SLACK_MS;
    let best = null;
    for (const r of rows) {
      if (!r.conversationId || !Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
      if (!Number.isFinite(r.lastResponseAt) || r.lastResponseAt < earliest) continue;
      if (Math.abs(r.latitude - lat) > WAE_GRID_DEG || Math.abs(r.longitude - lng) > WAE_GRID_DEG * 2) continue; // cheap prefilter before the real distance
      if (waeHaversineMeters(lat, lng, r.latitude, r.longitude) > WAE_NEARBY_THRESHOLD_METERS) continue;
      if (!best || r.lastResponseAt < best.lastResponseAt) best = r;
    }
    return best;
  }

  // Called from the "Clear them" button. The same Wayspot (same
  // coordinates) reported again refreshes its one placeholder instead of
  // adding a second row.
  async function waeAddReportedRecords(items) {
    if (!items.length) return;
    const now = Date.now();
    const keyOf = (lat, lng) => `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
    const existing = (await getAllFromStore(EXTRACT_STORE_NAME)).filter((r) => r.source === 'reported');
    const records = items.map((item) => {
      const rec = waeBuildReportedRecord(item, now);
      const prev = existing.find((x) => keyOf(x.latitude, x.longitude) === keyOf(rec.latitude, rec.longitude));
      if (prev) { rec.id = prev.id; if (prev.starred) rec.starred = true; }
      return rec;
    });
    await putExtractedRecords(records);
    waeRecordsLoadPromise = null;
    await waeEnsureRecordsLoaded().catch(() => {});
    if (waeUI) {
      await refreshPanel();
    } else {
      if (WAE_PULSES.map && isMapPulsesEnabled()) waeSafeRefreshPulses();
      if (WAE_REVIEW_PULSES.map) waeSafeRefreshReviewPulses();
    }
    waeMarkListRenderHook?.();
  }

  // One-off: the separate "Reported History" list v1.83.0 kept in the
  // settings becomes table rows. Entries that already found their ticket
  // are dropped -- that ticket's own row is in the table.
  async function waeMigrateReportedHistory() {
    let old;
    try { old = wfmmWindow.WFMM.settings.get(PLUGIN_ID, WAE_REPORTED_SETTINGS_KEY, []); } catch (e) { return; }
    if (!Array.isArray(old) || !old.length) return;
    const records = old
      .filter((item) => !item.ticketId && Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng)))
      .map((item) => waeBuildReportedRecord(item, Number(item.reportedAt) || Date.now()));
    await putExtractedRecords(records);
    wfmmWindow.WFMM.settings.set(PLUGIN_ID, WAE_REPORTED_SETTINGS_KEY, []);
  }

  // ---------------------------------------------------------------------
  // Feature request: a Favorite Users scratch list -- click a submitter's
  // username in the native side panel (waeStartSidePanelDetailsWatcher()
  // below) to toggle them in/out. Deliberately its own small list rather
  // than folded into Marked Wayspots above (a username isn't a location,
  // has no coordinates/note of its own to carry), but shown in that same
  // modal (waeRenderFavoriteUsersSection(), further down) rather than a
  // modal of its own -- exactly what was asked for, and the two lists
  // already share a natural home: both are "things noticed while
  // reviewing, jotted down for later" scratch lists, not part of the
  // ticket-tracking table this plugin's main panel is otherwise about.
  // Persisted via WFMM.settings, same mechanism (and same reasoning) as
  // the Marked Wayspots list just above.
  // ---------------------------------------------------------------------

  const WAE_FAVORITE_USERS_SETTINGS_KEY = 'favoriteUsers';

  function waeLoadFavoriteUsers() {
    try {
      const list = wfmmWindow.WFMM.settings.get(PLUGIN_ID, WAE_FAVORITE_USERS_SETTINGS_KEY, []);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function waeSaveFavoriteUsers(list) {
    try {
      wfmmWindow.WFMM.settings.set(PLUGIN_ID, WAE_FAVORITE_USERS_SETTINGS_KEY, list);
    } catch (e) { /* ignore -- next mutation attempt will just try again */ }
  }

  // Matched case-insensitively, trimmed -- a username read off the side
  // panel a second time (a different report by the same person, or the
  // same one re-opened) should still count as the SAME favorite even if
  // whatever rendered it capitalized it differently that time, rather
  // than silently accumulating near-duplicate entries that all display
  // the same to a human but never match each other.
  function waeFavoriteUserKey(username) {
    return (username || '').trim().toLowerCase();
  }

  function waeIsFavoriteUser(username) {
    const key = waeFavoriteUserKey(username);
    if (!key) return false;
    return waeLoadFavoriteUsers().some((u) => waeFavoriteUserKey(u.username) === key);
  }

  // Toggles rather than a separate add/remove pair -- one click target
  // (the username itself, see waeStartSidePanelDetailsWatcher()) has to
  // serve both "mark" and "unmark", there's no second control to put an
  // explicit remove action on the way the Marked Wayspots list has its
  // own "\u00d7" button for that. Returns the new state so the caller
  // (both the side panel and this list's own row remove button) can
  // restyle whatever it's showing without a second waeIsFavoriteUser()
  // lookup right after.
  function waeToggleFavoriteUser(username) {
    const name = (username || '').trim();
    const key = waeFavoriteUserKey(name);
    if (!key) return false;
    const list = waeLoadFavoriteUsers();
    const idx = list.findIndex((u) => waeFavoriteUserKey(u.username) === key);
    let isFavoriteNow;
    if (idx >= 0) {
      list.splice(idx, 1);
      isFavoriteNow = false;
    } else {
      list.push({ username: name, note: '', markedAt: Date.now() });
      isFavoriteNow = true;
    }
    waeSaveFavoriteUsers(list);
    waeFavoriteUsersRenderHook?.();
    return isFavoriteNow;
  }

  // Feature request: a note per favorite user, editable in that list's
  // own rows (waeBuildFavoriteUserRow(), further down) the same way a
  // Marked Wayspots entry's note is -- click to edit, click outside to
  // save. Matched by username the same way waeToggleFavoriteUser() itself
  // does, not by array index, since the list can be re-sorted/filtered
  // later without this breaking.
  function waeSetFavoriteUserNote(username, note) {
    const key = waeFavoriteUserKey(username);
    if (!key) return;
    const list = waeLoadFavoriteUsers();
    const idx = list.findIndex((u) => waeFavoriteUserKey(u.username) === key);
    if (idx < 0) return; // no longer a favorite -- nothing to attach a note to
    list[idx] = { ...list[idx], note: (note || '').trim() };
    waeSaveFavoriteUsers(list);
    waeFavoriteUsersRenderHook?.();
  }

  // Same idea as waeMarkListRenderHook above, for the Favorite Users
  // block within that same modal.
  let waeFavoriteUsersRenderHook = null;

  // ---------------------------------------------------------------------
  // Feature request: a visual marker on the map (mapview/submit) for
  // every entry on the Marked Wayspots list, not just an entry in the
  // list modal -- a small filled dot, default blue, in a color this
  // plugin's own Marker Style settings can change (see
  // waeRenderMarkerStyleSection()'s new markColorInput) just like the
  // abuse-report cross/cluster color already is. Deliberately its own,
  // much simpler OverlayView -- no clustering (this list is manually
  // curated, realistically never dense enough to need it the way
  // hundreds of scanned tickets are) and a single div per marker rather
  // than WaePulseOverlayCtor's visible+hit-div pair, added straight to
  // overlayMouseTarget: there's no "stay visually under real Wayspot
  // markers" requirement for these the way there is for abuse-report
  // crosses (see THAT class's own comment for why it's split there), so
  // nothing here needs to trade away reliable clicks (see v1.50.2's own
  // changelog entry) to get it.
  // ---------------------------------------------------------------------

  // Feature request: an "X" cross, same glyph as waeGetMarkerSvgMarkup()'s
  // own abuse-report markers (see that function's own comment for why a
  // cross rather than a filled circle/pin in the first place -- it reads
  // as "a problem here", not just another POI dot), just in this list's
  // own configurable color instead of fillColor. Reuses the same size
  // math (markerSize * 2 viewbox, 0.35 arm length, stroke scaled off
  // markerSize) so the two marker types stay visually consistent in
  // scale too, not just in shape -- there's no separate "Marked Wayspot
  // size" control, this rides on the same markerSize the abuse-report
  // crosses use.
  //
  // BUGFIX (not upstream, performance): used to rebuild this SVG string
  // from scratch on every single call -- i.e. once per marker, on every
  // single waeRenderMarkedWayspotMarkers() pass, even though every marker
  // in a given pass shares the exact same color and markerSize (there's
  // one global setting for each, not a per-entry one). WAE_MARKER_ICON/
  // WAE_CLUSTER_ICON above cache the same way for the same reason, just
  // invalidated externally (from waeSaveAppearance(), since those two
  // read appearance internally rather than taking it as a parameter) --
  // this one instead compares its own last-seen color/markerSize against
  // the current call's before deciding whether to rebuild, since color is
  // already threaded in as a parameter here. Self-contained rather than
  // one more place waeSaveAppearance() has to remember to reach into.
  let WAE_MARK_ICON = { color: null, markerSize: null, svg: null };
  function waeGetMarkedWayspotSvgMarkup(color, forReview) {
    const markerSize = waeLoadAppearance().markerSize + (forReview ? WAE_REVIEW_MARKER_SIZE_BONUS : 0); // v1.67.0
    if (WAE_MARK_ICON.color === color && WAE_MARK_ICON.markerSize === markerSize) {
      return WAE_MARK_ICON.svg;
    }
    const size = markerSize * 2;
    const half = size / 2;
    const arm = size * 0.35;
    const stroke = Math.max(2, Math.round(markerSize * 0.45));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
      + `<line x1="${half - arm}" y1="${half - arm}" x2="${half + arm}" y2="${half + arm}" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>`
      + `<line x1="${half + arm}" y1="${half - arm}" x2="${half - arm}" y2="${half + arm}" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>`
      + '</svg>';
    WAE_MARK_ICON = { color, markerSize, svg };
    return svg;
  }

  function waeShowMarkedWayspotInfoWindow(item, latLng) {
    if (typeof google === 'undefined' || !google.maps?.InfoWindow || !WAE_PULSES.map) return;
    if (!WAE_PULSES.infoWindow) WAE_PULSES.infoWindow = new google.maps.InfoWindow();
    const name = escapeHtml(item.name || '(unnamed)');
    const parts = [`<div style="font-size:12px;max-width:260px;"><strong>${name}</strong>`];
    parts.push(`<div>${latLng.lat().toFixed(6)}, ${latLng.lng().toFixed(6)}</div>`);
    if (item.note) parts.push(`<div style="margin-top:4px;color:#6b7280;word-break:break-word;white-space:pre-wrap;">${escapeHtml(item.note)}</div>`);
    parts.push('</div>');
    WAE_PULSES.infoWindow.setContent(parts.join(''));
    WAE_PULSES.infoWindow.setPosition(latLng);
    WAE_PULSES.infoWindow.open(WAE_PULSES.map);
  }

  // Feature request: clicking a Marked Wayspots list row navigates the
  // map there and shows an InfoWindow, same as clicking a row in the main
  // abuse-report table already does via waeGoToLocation() -- this is that
  // same attach/center/zoom/autoclose sequence, just for a marked-wayspot
  // item's own shape (lat/lng/name/note) rather than a report record's
  // (latitude/longitude/wayspotName/comment/conversationId), and reusing
  // the InfoWindow this list's own map markers already show on click
  // (waeShowMarkedWayspotInfoWindow, right above) rather than
  // waeGoToLocation()'s waeShowPulseInfoWindow().
  async function waeGoToMarkedWayspot(item) {
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lng)) return;
    // v1.69.0: the list can now be opened from the review page too (the
    // button on the toggle bar under the review map). There the map is the
    // review map, which waeAttachToMapIfNeeded() below can't find (it
    // looks for the map view's / submit map), so a row click did nothing.
    // Pan it instead -- no popup: the draft markers on that map are
    // click-through and have none. Same minimum zoom as below.
    const reviewMap = WAE_REVIEW_PULSES.map;
    if (reviewMap) {
      reviewMap.setCenter(new google.maps.LatLng(item.lat, item.lng));
      const rz = reviewMap.getZoom();
      if (typeof rz === 'number' && rz < 17) reviewMap.setZoom(17);
      return;
    }
    const attached = await waeAttachToMapIfNeeded();
    if (!attached) {
      if (waeUI) log(waeUI.logEl, '✗ Could not find the Wayfarer map on this page -- try again from the mapview or the submit-Wayspot map.', 'err');
      return;
    }
    const map = WAE_PULSES.map;
    const latLng = new google.maps.LatLng(item.lat, item.lng);
    map.setCenter(latLng);
    const z = map.getZoom();
    if (typeof z === 'number' && z < 17) map.setZoom(17);
    if (waeAutoCloseOnNavigateEnabled()) closePanel();
    google.maps.event.addListenerOnce(map, 'idle', () => waeShowMarkedWayspotInfoWindow(item, latLng));
  }

  let WaeMarkMarkerOverlayCtor = null;
  function waeEnsureMarkMarkerOverlayCtor() {
    if (WaeMarkMarkerOverlayCtor) return true;
    if (typeof google === 'undefined' || !google.maps?.OverlayView) return false;
    WaeMarkMarkerOverlayCtor = class extends google.maps.OverlayView {
      constructor() {
        super();
        this.div = null;
        this.latLng = null;
        this.item = null;
      }
      onAdd() {
        const div = document.createElement('div');
        div.className = 'wae-mark-marker';
        div.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (this.item && this.latLng) waeShowMarkedWayspotInfoWindow(this.item, this.latLng);
        });
        this.div = div;
        // overlayMouseTarget, not overlayLayer -- see this section's own
        // top comment: unlike WaePulseOverlayCtor's crosses, there's no
        // "must not visually cover a real marker" requirement to trade
        // against reliable clicks here (see v1.50.2's own changelog
        // entry for why overlayLayer alone can't ever deliver those).
        this.getPanes().overlayMouseTarget.appendChild(div);
        this.applyToDiv();
        this.draw();
      }
      draw() {
        if (!this.div || !this.latLng) return;
        const point = this.getProjection()?.fromLatLngToDivPixel(this.latLng);
        if (!point) return;
        this.div.style.left = `${point.x}px`;
        this.div.style.top = `${point.y}px`;
      }
      onRemove() {
        this.div?.remove();
        this.div = null;
      }
      getPosition() {
        return this.latLng;
      }
      applyToDiv() {
        if (!this.div || !this.item) return;
        this.div.innerHTML = waeGetMarkedWayspotSvgMarkup(this._color);
        this.div.title = this.item.name || '(unnamed)';
      }
      setItem(item, color) {
        this.item = item;
        this._color = color;
        this.latLng = new google.maps.LatLng(item.lat, item.lng);
        this.applyToDiv();
        this.draw();
      }
    };
    return true;
  }

  // id -> overlay instance, reused across refreshes the same way
  // WAE_PULSES.markersById is -- redrawing everything from scratch on
  // every add/delete/map-change would work too, but this way an entry
  // that didn't change (position, color) doesn't churn its own DOM node
  // for no reason.
  const waeMarkMarkerOverlays = new Map();

  function waeClearMarkedWayspotMarkers() {
    for (const overlay of waeMarkMarkerOverlays.values()) overlay.setMap(null);
    waeMarkMarkerOverlays.clear();
  }

  // Called on every list mutation (add/delete/clear -- see this
  // feature's own call sites) and on every map change (waeSetCurrentMap())
  // -- no viewport/idle-based redraw the way waeSafeRefreshPulses() needs
  // (see that function's own comment): a manually-curated list is
  // realistically never large enough that redrawing the whole thing on
  // every one of those triggers is worth debouncing against a map pan.
  function waeRenderMarkedWayspotMarkers() {
    waeRenderReviewDraftMarkers(); // v1.65.1: the review map shows the same list -- every caller of this refreshes both
    const map = WAE_PULSES.map;
    // Gated on isMapPulsesEnabled() (the "Abuse Report Crosses" Layers-menu
    // checkbox) same as the abuse-report crosses/clusters themselves --
    // added in v1.53.4, see that changelog entry for why this was missing
    // up to v1.53.3. Centralizing the check here, rather than at each of
    // this function's call sites, is what makes every one of them --
    // add/edit/delete/clear-list, marker-style changes, a fresh map
    // attach -- respect the toggle without having to touch them individually.
    if (!map || !isMapPulsesEnabled() || !waeEnsureMarkMarkerOverlayCtor()) {
      waeClearMarkedWayspotMarkers();
      return;
    }
    const color = waeLoadAppearance().markColor;
    const list = waeLoadMarkedWayspots();
    const seen = new Set();
    for (const item of list) {
      if (!Number.isFinite(item.lat) || !Number.isFinite(item.lng)) continue;
      seen.add(item.id);
      let overlay = waeMarkMarkerOverlays.get(item.id);
      if (!overlay) {
        overlay = new WaeMarkMarkerOverlayCtor();
        waeMarkMarkerOverlays.set(item.id, overlay);
      }
      overlay.setItem(item, color);
      if (overlay.getMap() !== map) overlay.setMap(map);
    }
    for (const [id, overlay] of waeMarkMarkerOverlays) {
      if (!seen.has(id)) {
        overlay.setMap(null);
        waeMarkMarkerOverlays.delete(id);
      }
    }
  }

  async function waeCopyToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through to the execCommand fallback below */ }
    // Fallback for a context where the async Clipboard API isn't
    // available/permitted (an insecure context, or a permission
    // prompt that was denied) -- the old hidden-textarea +
    // execCommand('copy') trick, synchronous and far less capable but
    // reliable enough for a plain-text copy.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Abuse form auto-fill, Wayfarer side (v1.70.0) -- see the comment block
  // at the very top of this file for the whole picture. Opens the Help
  // Center article with a one-time session id in the URL hash and answers
  // that tab's request for data (waeHandleAbuseFormMessage(), installed in
  // startPlugin()). The text sent is built when the request ARRIVES, not
  // when the button was clicked, so a note edited while the Help Center
  // was loading is still included. Same text, same "Include notes when
  // copying" choice, as Copy All -- that is what the form's location
  // parser (opr-email-lib.js) reads back out of the ticket email later.
  // ---------------------------------------------------------------------
  // v1.92.0: Sightengine checks opened from the review row that are waiting for
  // their verdict: sessionId -> { popup, createdAt, onResult(score|null) }
  const waeSeChecks = new Map();

  function waeHandleSightengineMessage(event) {
    if (event.origin !== WAE_SE_ORIGIN) return;
    const data = event.data;
    if (!data || data.type !== WAE_SE_MSG_RESULT || data.protocolVersion !== WAE_AF_PROTOCOL) return;
    const check = waeSeChecks.get(data.sessionId);
    if (!check || event.source !== check.popup) return;
    waeSeChecks.delete(data.sessionId);
    const score = typeof data.score === 'number' && data.score >= 0 && data.score <= 1 ? data.score : null;
    try { check.onResult(score); } catch (e) { console.warn('[Wayfarer Map Mods - Abuse Reports] Sightengine result handler failed:', e); }
  }

  const waeAbuseFormSessions = new Map(); // sessionId -> { popup, getSource, kind, itemIds, createdAt, expiresAt, submitted }
  // v1.81.0: the "clear the draft list?" question after a submitted form.
  // waeShowClearPromptHook is set by the open list modal (shows the question
  // in it); when the modal isn't open the ids wait in waePendingClear and
  // the modal, opened for the purpose, picks them up when it builds.
  let waeShowClearPromptHook = null;
  let waePendingClear = null;
  const WAE_DEFAULT_ISSUE_TYPE = 'Fake Nominations or criteria issues';
  // The options of the form's "What issue are you reporting?" dropdown,
  // as the form lists them (offered in the settings cog's Issue type menu).
  const WAE_ISSUE_TYPE_OPTIONS = [
    'Title/Description/Supporting Information',
    'Invalid Location Edits',
    'Fake Nominations or criteria issues',
    'Photo Issues',
    'Inappropriate Behavior by an Explorer',
  ];

  function waeGetReporterContact() {
    const s = wfmmWindow.WFMM.settings;
    return {
      name: String(s.get(PLUGIN_ID, 'reporterName', '') || '').trim(),
      email: String(s.get(PLUGIN_ID, 'reporterEmail', '') || '').trim(),
      afterSubmit: s.get(PLUGIN_ID, 'afterSubmitCleanup', false) === true,
      issueType: String(s.get(PLUGIN_ID, 'reporterIssueType', WAE_DEFAULT_ISSUE_TYPE) || '').trim(),
      reportDetails: String(s.get(PLUGIN_ID, 'reporterReportDetails', '') || '').trim(),
      abuser: String(s.get(PLUGIN_ID, 'reporterAbuser', '') || '').trim(),
      // v1.88.0: the list goes into the report details too, with the notes
      listInDetails: s.get(PLUGIN_ID, 'reporterListInDetails', false) === true,
      // v1.92.0: a Sightengine verdict over 90% AI-generated starts the auto-fill
      sightengineAutoStart: s.get(PLUGIN_ID, 'sightengineAutoStart', true) !== false,
    };
  }

  // v1.82.0: the Marked Wayspots entries an action should work on -- just the
  // ones with these ids (the ticked rows of the list modal), or the whole
  // list when no ids are given. Always read fresh from storage, so a note
  // edited after the ids were picked is still what gets sent.
  function waeMarkedItemsFor(ids) {
    const all = waeLoadMarkedWayspots();
    if (!ids || !ids.length) return all;
    const wanted = new Set(ids);
    return all.filter((item) => wanted.has(item.id));
  }

  // `getSource` (optional) is a function returning { items, includeNotes }
  // -- what to put in the form's location field INSTEAD of the Marked
  // Wayspots list. The review page's "Auto-fill abuse form" button uses it
  // to send just the open review's Wayspot with the note typed beside it.
  function waeBuildAbuseFormPayload(source) {
    const list = source.items;
    const includeNotes = source.includeNotes;
    const contact = waeGetReporterContact();
    const linesOf = (withNotes) => list.map((item) => waeFormatMarkedWayspotLine(item, withNotes)).join('\n');
    // v1.88.0: with the "list in the report details" option the location
    // field gets the list WITHOUT notes (whatever "Include notes when
    // copying" says) and the report details get it WITH notes. The default
    // report details text from the settings is NOT used then (v1.88.1).
    const listInDetails = contact.listInDetails;
    // v1.93.0: a workflow can pin parts of the form (the Sightengine one
    // does) with `source.overrides`: issueType, reportDetails (instead of the
    // settings' default text and of the list-in-details option) and
    // locationNotes: false (the location field then only has name + coordinates).
    const o = source.overrides || {};
    return {
      name: contact.name,
      email: contact.email,
      watchSubmit: contact.afterSubmit,
      issueType: o.issueType !== undefined ? o.issueType : contact.issueType,
      reportDetails: o.reportDetails !== undefined
        ? o.reportDetails
        : (listInDetails ? linesOf(true) : contact.reportDetails),
      abuser: contact.abuser,
      count: list.length,
      locationDetails: o.locationNotes === false ? linesOf(false) : linesOf(listInDetails ? false : includeNotes),
    };
  }

  // 'opened' | 'empty' | 'blocked'. Must run straight from a click, or the
  // browser's popup blocker will refuse the window.open() call -- unless
  // `existingPopup` is given (v1.92.0): then that tab, one this tab opened
  // earlier (the Sightengine check), is sent to the form instead of a new
  // one being opened, which needs no click.
  // `onlyIds` (optional, list mode only) limits the form to those Marked
  // Wayspots (the ticked rows); without it the whole list is sent.
  // `onSubmitted` (optional, v1.94.0) runs once when the form tab reports the
  // form as submitted (only happens with the \"After the form is submitted\"
  // setting on).
  function waeOpenAbuseFormAutofill(getSource, onlyIds, existingPopup, onSubmitted) {
    const subset = !getSource && Array.isArray(onlyIds) && onlyIds.length ? onlyIds.slice() : null;
    if (!(getSource ? getSource().items : waeMarkedItemsFor(subset)).length) return 'empty';
    const sessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const url = new URL(WAE_ABUSE_FORM_URL);
    url.hash = new URLSearchParams({
      [WAE_AF_HASH_SESSION]: sessionId,
      [WAE_AF_HASH_ORIGIN]: window.location.origin,
    }).toString();
    // No "noopener" -- the Help Center tab needs window.opener to ask for
    // the data.
    let popup;
    if (existingPopup) {
      // a tab this one opened (and that kept its opener) can be navigated from here
      if (existingPopup.closed) return 'blocked';
      try { existingPopup.location.href = url.toString(); } catch (e) { return 'blocked'; }
      popup = existingPopup;
    } else {
      popup = window.open(url.toString(), '_blank');
    }
    if (!popup) return 'blocked';
    const now = Date.now();
    // sessions linger for hours, not the 15 minutes the data request is good
    // for: the "submitted" message can come long after the form was opened
    for (const [id, s] of waeAbuseFormSessions) if (now - s.createdAt > 3 * 60 * 60 * 1000) waeAbuseFormSessions.delete(id);
    waeAbuseFormSessions.set(sessionId, {
      popup,
      getSource,
      onlyIds: subset,
      kind: getSource ? 'review' : 'list', // the review page's button sends one Wayspot, not the draft list
      itemIds: [],
      onSubmitted: typeof onSubmitted === 'function' ? onSubmitted : null,
      createdAt: now,
      expiresAt: now + WAE_AF_SESSION_TTL_MS,
      submitted: false,
    });
    return 'opened';
  }

  function waeHandleAbuseFormMessage(event) {
    if (event.origin !== WAE_HS_ORIGIN) return;
    const data = event.data;
    if (!data || data.protocolVersion !== WAE_AF_PROTOCOL) return;
    const session = waeAbuseFormSessions.get(data.sessionId);
    if (!session || event.source !== session.popup) return;

    if (data.type === WAE_AF_MSG_REQUEST) {
      if (session.expiresAt <= Date.now()) return;
      const source = session.getSource
        ? session.getSource()
        : { items: waeMarkedItemsFor(session.onlyIds), includeNotes: waeCopyIncludesNotes() };
      if (!session.getSource) session.itemIds = source.items.map((item) => item.id);
      session.popup.postMessage({
        type: WAE_AF_MSG_DATA,
        protocolVersion: WAE_AF_PROTOCOL,
        sessionId: data.sessionId,
        payload: waeBuildAbuseFormPayload(source),
      }, WAE_HS_ORIGIN);
      return;
    }

    // The Help Center tab saw the form get submitted (only ever sent when
    // the "After submitting" setting is on). For a session that sent the
    // whole draft list, ask whether to clear the Wayspots that were in it;
    // the review page's single-Wayspot button has no list to clear.
    if (data.type === WAE_AF_MSG_SUBMITTED) {
      if (session.submitted) return;
      session.submitted = true;
      if (session.onSubmitted) {
        try { session.onSubmitted(); } catch (e) { console.warn('[Wayfarer Map Mods - Abuse Reports] After-submit handler failed:', e); }
      }
      if (session.kind !== 'list' || !session.itemIds.length) return;
      const ids = session.itemIds.slice();
      if (waeShowClearPromptHook) waeShowClearPromptHook(ids);
      else { waePendingClear = { ids }; waeOpenMarkedWayspotListModal(); }
    }
  }

  function waeFormatMarkedWayspotLine(item, includeNotes = true) {
    const name = item.name || '(unnamed)';
    const coords = `${Number(item.lat).toFixed(6)}, ${Number(item.lng).toFixed(6)}`;
    return (includeNotes && item.note) ? `${name}, ${coords} (${item.note})` : `${name}, ${coords}`;
  }

  // Feature request: "Copy All" on the Marked Wayspots list can copy with
  // or without each entry's note, via a checkbox next to it. On by
  // default (what Copy All always did before this existed). Stored in
  // WFMM.settings like this file's other real preferences.
  function waeCopyIncludesNotes() {
    return wfmmWindow.WFMM.settings.get(PLUGIN_ID, 'copyIncludeNotes', true) !== false;
  }

  // One list row: name/coords/delete on the first line, a click-to-edit
  // note below it. Feature request, exact interaction as specified:
  // clicking the note line opens a textarea; a second click OUTSIDE that
  // textarea closes it again and stores whatever's in it. Implemented
  // with a capturing 'mousedown' listener on the document (checking
  // whether the click landed inside the textarea, not any particular
  // element outside it) rather than the textarea's own 'blur' -- blur
  // alone is unreliable here since not every element that can be clicked
  // is itself focusable, and this needs to catch literally any outside
  // click, not just a focus change.
  // `selection` (optional) = { ids: Set of item ids, onChange: () => void }
  // -- when given, the row starts with a tick box feeding the list's Copy
  // selected button (see waeRenderMarkedWayspotListSection()), like the
  // Favorite Users rows' own. The selection lives in that section's
  // closure, not on the stored entry: it is a this-modal-session thing,
  // not something to persist.
  // v1.86.0: the total line under the abuse reports table, the draft list
  // and the Favorite Users list. `shown` is what is on the list right now,
  // `total` everything behind it (they only differ while the table's search
  // box is filtering). `noun` is [singular, plural]: "reported Wayspot",
  // "draft report Wayspot" or "favorite user" (v1.86.1).
  function waeRowTotalText(shown, total, noun) {
    if (shown === total) return `${total} ${noun[total === 1 ? 0 : 1]}`;
    return `${shown} of ${total} ${noun[1]}`;
  }
  const WAE_TOTAL_NOUN_REPORTED = ['reported Wayspot', 'reported Wayspots'];
  const WAE_TOTAL_NOUN_DRAFT = ['draft report Wayspot', 'draft report Wayspots'];
  const WAE_TOTAL_NOUN_FAVORITE = ['favorite user', 'favorite users'];

  // v1.85.0: abuse report rows (tickets, and Wayspots reported from the draft
  // that are still waiting for their ticket) at EXACTLY these coordinates --
  // same lat/lng to 6 decimals, the precision the draft list itself dedupes
  // on, NOT the 20 m "nearby" check used elsewhere. Returns a Map of
  // "lat,lng" -> [rows], built once per render of the list.
  function waeExactReportIndex() {
    const index = new Map();
    for (const r of waeAllRecords) {
      if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude)) continue;
      const key = `${r.latitude.toFixed(6)},${r.longitude.toFixed(6)}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(r);
    }
    return index;
  }

  // "#123 (Actioned)", "reported 21/10/2026" or "imported" -- one entry per
  // ticket however many of its rows sit on those coordinates.
  function waeDescribeExactMatches(rows) {
    const seen = new Set();
    const parts = [];
    for (const r of rows) {
      const ref = r.conversationId || `row:${r.id}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (r.conversationId) parts.push({ text: `#${r.conversationId} (${waeStatusLabel(r.ticketStatus)})`, last: r.lastResponseAt });
      else if (r.source === 'reported') parts.push({ text: `reported ${new Date(r.reportedAt || r.lastResponseAt || 0).toLocaleDateString()}`, last: r.lastResponseAt });
      else parts.push({ text: 'in your abuse reports list', last: r.lastResponseAt });
    }
    return parts;
  }

  function waeBuildMarkedWayspotRow(item, ui, onDelete, selection, exactMatches) {
    const row = ui.createElement('div', { className: 'wae-mark-row' });
    const mainLine = ui.createElement('div', {
      className: 'wae-mark-row-main',
      attrs: { title: 'Click to show this Wayspot on the map' },
    });
    const nameEl = ui.createElement('span', { className: 'wae-mark-row-name', text: item.name || '(unnamed)' });
    const coordEl = ui.createElement('span', { className: 'wae-mark-row-coord', text: `${Number(item.lat).toFixed(6)}, ${Number(item.lng).toFixed(6)}` });
    const deleteBtn = ui.createElement('button', { className: 'wae-mark-row-delete', text: '\u00d7', attrs: { type: 'button', title: 'Remove from list' } });
    if (selection) {
      const checkbox = ui.createElement('input', {
        className: 'wae-mark-row-checkbox',
        attrs: { type: 'checkbox', title: 'Select for Copy selected', 'aria-label': 'Select for Copy selected' },
      });
      checkbox.checked = selection.ids.has(item.id);
      // Ticking must not also count as clicking the row (which pans the
      // map to this Wayspot -- see the mainLine click handler below).
      checkbox.addEventListener('click', (ev) => ev.stopPropagation());
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selection.ids.add(item.id);
        else selection.ids.delete(item.id);
        selection.onChange();
      });
      mainLine.append(checkbox);
    }
    mainLine.append(nameEl, coordEl, deleteBtn);

    // Feature request: clicking the row (name/coords line, same as the
    // main abuse-report table's own onRowClick) pans/zooms the map there
    // and pops the InfoWindow -- see waeGoToMarkedWayspot()'s own comment.
    // deleteBtn's own listener below calls stopPropagation() before this
    // ever sees the click, so removing an entry doesn't also navigate to
    // it on the way out.
    mainLine.addEventListener('click', () => waeGoToMarkedWayspot(item));

    const noteEl = ui.createElement('div', {
      className: `wae-mark-row-note${item.note ? '' : ' wae-mark-row-note-empty'}`,
      text: item.note || 'Click to add a note\u2026',
    });
    if (exactMatches && exactMatches.length) {
      const parts = waeDescribeExactMatches(exactMatches);
      const shown = parts.slice(0, 3).map((x) => x.text).join(', ');
      const more = parts.length > 3 ? ` +${parts.length - 3} more` : '';
      const flag = ui.createElement('div', {
        className: 'wae-mark-row-flag',
        text: `\u26A0 Already reported at these exact coordinates: ${shown}${more}`,
        attrs: { title: parts.map((x) => x.text).join('\n') },
      });
      row.append(mainLine, flag, noteEl);
    } else {
      row.append(mainLine, noteEl);
    }

    deleteBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      waeSaveMarkedWayspots(waeLoadMarkedWayspots().filter((x) => x.id !== item.id));
      waeRenderMarkedWayspotMarkers();
      onDelete(row);
    });

    noteEl.addEventListener('click', () => {
      if (row.querySelector('textarea')) return; // already open
      const textarea = ui.createElement('textarea', {
        className: 'wae-mark-row-note-input',
        attrs: { rows: '2' },
      });
      textarea.value = item.note || '';
      row.replaceChild(textarea, noteEl);
      textarea.focus();
      textarea.select();

      const commit = () => {
        document.removeEventListener('mousedown', onOutsideMouseDown, true);
        const value = textarea.value.trim();
        item.note = value;
        waeSaveMarkedWayspots(waeLoadMarkedWayspots().map((x) => (x.id === item.id ? { ...x, note: value } : x)));
        noteEl.textContent = value || 'Click to add a note\u2026';
        noteEl.classList.toggle('wae-mark-row-note-empty', !value);
        if (row.contains(textarea)) row.replaceChild(noteEl, textarea);
      };
      const onOutsideMouseDown = (ev) => {
        if (!textarea.contains(ev.target)) commit();
      };
      // Deferred to the next tick so the SAME click that just opened
      // this editor (still being dispatched) isn't immediately treated
      // as the "outside" click that closes it right back again.
      setTimeout(() => document.addEventListener('mousedown', onOutsideMouseDown, true), 0);
    });

    return row;
  }

  function waeRenderMarkedWayspotListSection(ui, body) {
    const listContainer = ui.createElement('div', { className: 'wae-mark-list' });
    const countEl = ui.createElement('div', { className: 'wae-sub wae-row-total' }); // v1.86.0
    const emptyEl = ui.createElement('div', {
      className: 'wae-sub',
      text: 'Your abuse report draft is empty -- use the + button on the main panel, then click a Wayspot on the map.',
    });
    // v1.80.0: says what this list IS: the draft of the next abuse report.
    const draftHint = ui.createElement('div', {
      className: 'wae-sub wae-draft-hint',
      text: 'This is your abuse report draft: the Wayspots you marked to report. It is only saved in this browser and nothing is sent from here. Copy it, or auto-fill the abuse form with it, then check the form and submit it yourself. Tick rows to limit auto-fill and the trash button to just those; with nothing ticked they work on the whole list.',
    });
    // v1.81.0: after a submitted abuse form (setting "After submitting"):
    // asks whether to clear the Wayspots that were just sent. Hidden until
    // waeShowClearPromptHook() fires. Only the Wayspots that were in the form
    // are cleared -- anything marked since stays.
    const clearPrompt = ui.createElement('div', { className: 'wae-clear-prompt' });
    clearPrompt.hidden = true;
    const clearPromptText = ui.createElement('span', { className: 'wae-clear-prompt-text', text: '' });
    const clearPromptYes = ui.button({ text: 'Clear them', variant: 'danger' });
    const clearPromptNo = ui.button({ text: 'Keep them' });
    clearPrompt.append(clearPromptText, clearPromptYes, clearPromptNo);
    let promptIds = [];
    function showClearPrompt(ids) {
      const live = new Set(waeLoadMarkedWayspots().map((item) => item.id));
      promptIds = ids.filter((id) => live.has(id));
      if (!promptIds.length) return; // already gone from the list
      const n = promptIds.length;
      clearPromptText.textContent = `The abuse form was submitted. Clear the ${n} Wayspot${n === 1 ? '' : 's'} that ${n === 1 ? 'was' : 'were'} in it from your abuse report draft? ${n === 1 ? 'It moves' : 'They move'} to the abuse reports list as "Reported" until the ticket has been scanned.`;
      clearPrompt.hidden = false;
    }
    clearPromptYes.addEventListener('click', () => {
      const gone = new Set(promptIds);
      const draft = waeLoadMarkedWayspots();
      // v1.84.0: the only place that puts Wayspots into the abuse reports list as "Reported"
      const moved = draft.filter((item) => gone.has(item.id));
      waeSaveMarkedWayspots(draft.filter((item) => !gone.has(item.id)));
      waeAddReportedRecords(moved).catch((e) => console.warn('[Wayfarer Map Mods - Abuse Reports] Could not add the reported Wayspots to the list:', e));
      waeRenderMarkedWayspotMarkers();
      promptIds = [];
      clearPrompt.hidden = true;
      render();
    });
    clearPromptNo.addEventListener('click', () => { promptIds = []; clearPrompt.hidden = true; });

    // Feature request: a quick link to Niantic's own "Reporting Abuse in
    // Wayfarer" Help Center article right on this list -- where the
    // entries actually get copied FROM before going to file the report,
    // not the extracted-ticket table elsewhere in this plugin, which is
    // about reports already filed rather than about to be.
    const copyTitle = 'Copy all Wayspots (name, coordinates and notes) to the clipboard';
    const fillTitle = 'Auto-fill the abuse form from this list (opens a new tab)';
    const copyAllBtn = waeIconButton(ui, { icon: WAE_COPY_ICON_SVG, title: copyTitle, disabled: true });
    // v1.70.0: opens the Help Center abuse form and fills its location
    // field with the same text Copy All would copy -- see
    // waeOpenAbuseFormAutofill().
    const fillFormBtn = waeIconButton(ui, { icon: WAE_WAND_ICON_SVG, title: fillTitle, disabled: true });
    // v1.78.0: the quick link to Niantic's \"Reporting Abuse in Wayfarer\"
    // article (where the entries get copied TO) is an icon button in the
    // row too now, instead of a line of text above it.
    const formLinkEl = ui.createElement('a', {
      className: 'wfmm-btn wae-list-icon-btn',
      html: WAE_FILE_ALERT_ICON_SVG,
      attrs: {
        href: WAE_ABUSE_FORM_URL,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: 'Open the abuse form (Help Center article, new tab)',
        'aria-label': 'Open the abuse form (Help Center article, new tab)',
      },
    });
    const clearAllBtn = waeIconButton(ui, { icon: WAE_TRASH_ICON_SVG, title: 'Clear the whole draft list', variant: 'danger', disabled: true });
    // v1.79.0: tick boxes on the rows + a Copy selected button, like the
    // Favorite Users list's -- copies only the ticked Wayspots, in list
    // order, in the same format as Copy All (so the "Include notes when
    // copying" checkbox applies to both). The count shows beside the icon
    // and in the tooltip.
    const copySelectedTitle = 'Copy the ticked Wayspots (name, coordinates and notes) to the clipboard';
    const copySelectedBtn = waeIconButton(ui, { icon: WAE_CLIPBOARD_CHECK_ICON_SVG, title: copySelectedTitle, disabled: true });
    // v1.82.0: unticks every row at once.
    const deselectTitle = 'Deselect all ticked Wayspots';
    const deselectAllBtn = waeIconButton(ui, { icon: WAE_DESELECT_ICON_SVG, title: deselectTitle, disabled: true });
    const clearAllTitle = 'Clear the whole draft list';
    const selectedIds = new Set();
    const selectedIcon = () => WAE_CLIPBOARD_CHECK_ICON_SVG + (selectedIds.size ? `<span class="wae-btn-count">${selectedIds.size}</span>` : '');
    const selectedTitle = () => (selectedIds.size
      ? `Copy the ${selectedIds.size} ticked Wayspot${selectedIds.size === 1 ? '' : 's'} (name, coordinates and notes) to the clipboard`
      : copySelectedTitle);
    // v1.82.0: auto-fill and the trash button act on the ticked rows when
    // there are any, otherwise on the whole list -- their tooltips say which.
    const fillTitleNow = () => (selectedIds.size
      ? `Auto-fill the abuse form with the ${selectedIds.size} ticked Wayspot${selectedIds.size === 1 ? '' : 's'} (opens a new tab)`
      : fillTitle);
    const clearTitleNow = () => (selectedIds.size
      ? `Remove the ${selectedIds.size} ticked Wayspot${selectedIds.size === 1 ? '' : 's'} from the draft list`
      : clearAllTitle);
    const setTitle = (btn, title) => { btn.title = title; btn.setAttribute('aria-label', title); };
    const syncSelectedBtn = () => {
      copySelectedBtn.disabled = !selectedIds.size;
      copySelectedBtn.innerHTML = selectedIcon();
      copySelectedBtn.title = selectedTitle();
      copySelectedBtn.setAttribute('aria-label', selectedTitle());
      deselectAllBtn.disabled = !selectedIds.size;
      setTitle(fillFormBtn, fillTitleNow());
      setTitle(clearAllBtn, clearTitleNow());
    };
    // Forget ticks for entries no longer on the list (removed with the x,
    // Clear All, or from the map while this modal is open), so a stale id
    // can't inflate a later Copy selected count.
    const pruneSelection = (list) => {
      const live = new Set(list.map((item) => item.id));
      for (const id of Array.from(selectedIds)) if (!live.has(id)) selectedIds.delete(id);
    };
    const selection = { ids: selectedIds, onChange: syncSelectedBtn };
    const buttonRow = ui.buttonRow([copyAllBtn, copySelectedBtn, deselectAllBtn, fillFormBtn, formLinkEl, clearAllBtn]);
    const copyNotesToggle = ui.checkboxRow({
      label: 'Include notes when copying',
      checked: waeCopyIncludesNotes(),
      onChange: (checked) => wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'copyIncludeNotes', checked),
    });

    function render() {
      listContainer.innerHTML = '';
      const list = waeLoadMarkedWayspots();
      pruneSelection(list);
      countEl.textContent = waeRowTotalText(list.length, list.length, WAE_TOTAL_NOUN_DRAFT);
      copyAllBtn.disabled = !list.length;
      fillFormBtn.disabled = !list.length;
      clearAllBtn.disabled = !list.length;
      syncSelectedBtn();
      if (!list.length) {
        listContainer.append(emptyEl);
        return;
      }
      const exactIndex = waeExactReportIndex();
      for (const item of list) {
        const exactKey = `${Number(item.lat).toFixed(6)},${Number(item.lng).toFixed(6)}`;
        listContainer.append(waeBuildMarkedWayspotRow(item, ui, (rowEl) => {
          rowEl.remove();
          if (!waeLoadMarkedWayspots().length) render();
          else {
            pruneSelection(waeLoadMarkedWayspots());
            copyAllBtn.disabled = false; fillFormBtn.disabled = false; clearAllBtn.disabled = false;
            syncSelectedBtn();
          }
        }, selection, exactIndex.get(exactKey)));
      }
    }

    copyAllBtn.addEventListener('click', async () => {
      const list = waeLoadMarkedWayspots();
      if (!list.length) return;
      const ok = await waeCopyToClipboard(list.map((item) => waeFormatMarkedWayspotLine(item, waeCopyIncludesNotes())).join('\n'));
      waeFlashButton(copyAllBtn, ok ? WAE_CHECK_ICON_SVG : WAE_X_ICON_SVG, ok ? 'Copied' : 'Copy failed', WAE_COPY_ICON_SVG, copyTitle);
    });

    copySelectedBtn.addEventListener('click', async () => {
      const lines = waeLoadMarkedWayspots()
        .filter((item) => selectedIds.has(item.id))
        .map((item) => waeFormatMarkedWayspotLine(item, waeCopyIncludesNotes()));
      if (!lines.length) return;
      const ok = await waeCopyToClipboard(lines.join('\n'));
      waeFlashButton(copySelectedBtn, ok ? WAE_CHECK_ICON_SVG : WAE_X_ICON_SVG, ok ? 'Copied' : 'Copy failed', selectedIcon, selectedTitle);
    });

    fillFormBtn.addEventListener('click', () => {
      // The ticked rows when there are any, else the whole list.
      const result = waeOpenAbuseFormAutofill(null, Array.from(selectedIds));
      if (result === 'empty') return;
      const opened = result === 'opened';
      waeFlashButton(fillFormBtn, opened ? WAE_CHECK_ICON_SVG : WAE_X_ICON_SVG, opened ? 'Opened' : 'Popup blocked', WAE_WAND_ICON_SVG, fillTitleNow);
    });

    deselectAllBtn.addEventListener('click', () => {
      selectedIds.clear();
      // untick in place -- a full render() would reset the list's scroll position and close open note editors
      listContainer.querySelectorAll('.wae-mark-row-checkbox').forEach((cb) => { cb.checked = false; });
      syncSelectedBtn();
    });

    clearAllBtn.addEventListener('click', () => {
      const list = waeLoadMarkedWayspots();
      if (!list.length) return;
      // v1.82.0: with rows ticked this removes just those, otherwise everything
      const ticked = list.filter((item) => selectedIds.has(item.id));
      if (ticked.length) {
        const n = ticked.length;
        if (!confirm(`Remove the ${n} ticked Wayspot${n === 1 ? '' : 's'} from the abuse report draft? This cannot be undone.`)) return;
        const gone = new Set(ticked.map((item) => item.id));
        waeSaveMarkedWayspots(list.filter((item) => !gone.has(item.id)));
        selectedIds.clear();
      } else {
        if (!confirm('Clear the entire abuse report draft (all marked Wayspots)? This cannot be undone.')) return;
        waeSaveMarkedWayspots([]);
      }
      waeRenderMarkedWayspotMarkers();
      render();
    });

    body.append(clearPrompt, draftHint, buttonRow, copyNotesToggle.row, listContainer, countEl);
    render();
    // v1.85.0: the "already reported" flags need the extracted rows; load them if nothing has yet this session
    if (!waeRecordsLoadPromise) waeEnsureRecordsLoaded().then(() => { if (waeMarkListRenderHook === render) render(); }).catch(() => {});
    waeMarkListRenderHook = render;
    waeShowClearPromptHook = showClearPrompt;
    if (waePendingClear) { // the modal was opened FOR a submitted form (see waeHandleAbuseFormMessage())
      const pending = waePendingClear;
      waePendingClear = null;
      showClearPrompt(pending.ids);
    }

    // Feature request: Favorite Users, in this same modal (see that
    // feature's own top-of-section comment, search "Favorite Users list"
    // further up this file) rather than a modal of its own -- its own
    // ui.section() below for visual separation from the Marked Wayspots
    // list just built above, since this modal's own title only names the
    // latter.
    waeRenderFavoriteUsersSection(ui, body);

    return {
      onOk() { return true; }, // no-op -- every action above already saves on its own
    };
  }

  // Feature request: the Favorite Users list itself -- click a username
  // in the side panel (waeStartSidePanelDetailsWatcher()) to toggle it
  // in/out, shown here wrapped in its own ui.section() within the Marked
  // Wayspots modal (called from waeRenderMarkedWayspotListSection() right
  // above, not given a modal of its own). No per-entry note or Copy
  // All/coordinates the way Marked Wayspots rows have -- a username is
  // just a name to remember, nothing here to copy into an abuse-report
  // form the way that list's own entries are for.
  // Feature request: note editing for a Favorite Users row -- same
  // click-to-edit textarea, commit-on-outside-click behavior as
  // waeBuildMarkedWayspotRow()'s own note handling above, matched to
  // storage by username (waeSetFavoriteUserNote()) rather than an id the
  // way that list's entries have. `color` is passed in rather than
  // re-read per row -- render() below already fetches it once per pass.
  function waeBuildFavoriteUserRow(item, ui, color, render, selectedKeys) {
    const row = ui.createElement('div', { className: 'wae-favorite-user-row' });
    const mainLine = ui.createElement('div', { className: 'wae-favorite-user-row-main' });
    // Feature request: a selection checkbox, so a subset of usernames can
    // be copied without their notes or the "\u00d7" -- see
    // waeRenderFavoriteUsersSection()'s Copy Selected button, further
    // down, for what actually reads `selectedKeys`. The Set (not each
    // item's own field) lives in that section's own closure rather than
    // on the stored entry, since a selection is a this-modal-session
    // thing, not a durable preference worth persisting to WFMM.settings.
    const checkbox = ui.createElement('input', {
      className: 'wae-favorite-user-checkbox',
      attrs: { type: 'checkbox' },
    });
    const key = waeFavoriteUserKey(item.username);
    checkbox.checked = selectedKeys.has(key);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedKeys.add(key);
      else selectedKeys.delete(key);
      render();
    });
    const nameEl = ui.createElement('span', {
      className: 'wae-favorite-user-name',
      text: item.username,
      style: { color, fontWeight: '700' },
    });
    const removeBtn = ui.createElement('button', {
      className: 'wae-favorite-user-remove',
      text: '\u00d7',
      attrs: { type: 'button', title: 'Remove from favorites' },
    });
    removeBtn.addEventListener('click', () => {
      selectedKeys.delete(key);
      waeToggleFavoriteUser(item.username);
      render();
    });
    mainLine.append(checkbox, nameEl, removeBtn);

    const noteEl = ui.createElement('div', {
      className: `wae-favorite-user-note${item.note ? '' : ' wae-favorite-user-note-empty'}`,
      text: item.note || 'Click to add a note\u2026',
    });
    row.append(mainLine, noteEl);

    noteEl.addEventListener('click', () => {
      if (row.querySelector('textarea')) return; // already open
      const textarea = ui.createElement('textarea', {
        className: 'wae-favorite-user-note-input',
        attrs: { rows: '2' },
      });
      textarea.value = item.note || '';
      row.replaceChild(textarea, noteEl);
      textarea.focus();
      textarea.select();

      const commit = () => {
        document.removeEventListener('mousedown', onOutsideMouseDown, true);
        const value = textarea.value.trim();
        waeSetFavoriteUserNote(item.username, value);
        noteEl.textContent = value || 'Click to add a note\u2026';
        noteEl.classList.toggle('wae-favorite-user-note-empty', !value);
        if (row.contains(textarea)) row.replaceChild(noteEl, textarea);
      };
      const onOutsideMouseDown = (ev) => {
        if (!textarea.contains(ev.target)) commit();
      };
      // Deferred to the next tick for the same reason
      // waeBuildMarkedWayspotRow()'s own note editor defers this.
      setTimeout(() => document.addEventListener('mousedown', onOutsideMouseDown, true), 0);
    });

    return row;
  }

  function waeRenderFavoriteUsersSection(ui, body) {
    const listContainer = ui.createElement('div', { className: 'wae-favorite-user-list' });
    const countEl = ui.createElement('div', { className: 'wae-sub wae-row-total' }); // v1.86.0
    const emptyEl = ui.createElement('div', {
      className: 'wae-sub',
      text: 'No favorite users yet -- click a username in the Wayfarer side panel to add one.',
    });
    const copyUsersTitle = 'Copy all usernames to the clipboard';
    const copySelectedTitle = 'Copy the ticked usernames to the clipboard';
    const copyAllBtn = waeIconButton(ui, { icon: WAE_COPY_ICON_SVG, title: copyUsersTitle, disabled: true });
    // Feature request: copy just the usernames of a subset of this list,
    // with neither the "\u00d7" remove control (never text to begin
    // with, so nothing special needed there) nor any entry's note --
    // Copy All above and this button both only ever join item.username
    // values, never waeFormatMarkedWayspotLine() or anything that would
    // pull a note in, unlike the Marked Wayspots list's own Copy All.
    // Selection state lives in this closure (see waeBuildFavoriteUserRow()'s
    // own comment on selectedKeys) -- cleared on Clear All/modal reopen,
    // not persisted.
    const copySelectedBtn = waeIconButton(ui, { icon: WAE_CLIPBOARD_CHECK_ICON_SVG, title: copySelectedTitle, disabled: true });
    const clearAllBtn = waeIconButton(ui, { icon: WAE_TRASH_ICON_SVG, title: 'Clear the whole favorite-users list', variant: 'danger', disabled: true });
    const selectedKeys = new Set();
    // The Copy selected button shows how many usernames are ticked: a small
    // number beside the icon, and the same count in the tooltip.
    const selectedIcon = () => WAE_CLIPBOARD_CHECK_ICON_SVG + (selectedKeys.size ? `<span class="wae-btn-count">${selectedKeys.size}</span>` : '');
    const selectedTitle = () => (selectedKeys.size
      ? `Copy the ${selectedKeys.size} ticked username${selectedKeys.size === 1 ? '' : 's'} to the clipboard`
      : copySelectedTitle);
    const syncSelectedBtn = () => {
      copySelectedBtn.innerHTML = selectedIcon();
      copySelectedBtn.title = selectedTitle();
      copySelectedBtn.setAttribute('aria-label', selectedTitle());
    };

    function render() {
      listContainer.innerHTML = '';
      const list = waeLoadFavoriteUsers();
      // Drop selections for usernames no longer on the list (removed via
      // this render's own removeBtn, or Clear All) so a stale key can't
      // silently inflate a later Copy Selected count.
      const liveKeys = new Set(list.map((u) => waeFavoriteUserKey(u.username)));
      for (const k of Array.from(selectedKeys)) if (!liveKeys.has(k)) selectedKeys.delete(k);

      copyAllBtn.disabled = !list.length;
      clearAllBtn.disabled = !list.length;
      copySelectedBtn.disabled = !selectedKeys.size;
      syncSelectedBtn();
      countEl.textContent = waeRowTotalText(list.length, list.length, WAE_TOTAL_NOUN_FAVORITE);

      if (!list.length) {
        listContainer.append(emptyEl);
        return;
      }
      // Colored the same as a favorited username reads in the live side
      // panel (waeApplyFavoriteUsernameStyle()) -- re-fetched fresh here
      // rather than once outside the loop since it's cheap and this stays
      // correct even if the color's changed since this modal was opened.
      const color = waeLoadAppearance().favoriteUserColor;
      for (const item of list) {
        listContainer.append(waeBuildFavoriteUserRow(item, ui, color, render, selectedKeys));
      }
    }

    async function copyUsernames(usernames, btn, defaultIcon, defaultTitle) {
      if (!usernames.length) return;
      const ok = await waeCopyToClipboard(usernames.join('\n'));
      waeFlashButton(btn, ok ? WAE_CHECK_ICON_SVG : WAE_X_ICON_SVG, ok ? 'Copied' : 'Copy failed', defaultIcon, defaultTitle);
    }

    copyAllBtn.addEventListener('click', () => {
      copyUsernames(waeLoadFavoriteUsers().map((u) => u.username), copyAllBtn, WAE_COPY_ICON_SVG, copyUsersTitle);
    });

    copySelectedBtn.addEventListener('click', () => {
      const usernames = waeLoadFavoriteUsers()
        .map((u) => u.username)
        .filter((name) => selectedKeys.has(waeFavoriteUserKey(name)));
      copyUsernames(usernames, copySelectedBtn, selectedIcon, selectedTitle);
    });

    clearAllBtn.addEventListener('click', () => {
      if (!waeLoadFavoriteUsers().length) return;
      if (!confirm('Clear your entire favorite-users list? This cannot be undone.')) return;
      waeSaveFavoriteUsers([]);
      selectedKeys.clear();
      render();
    });

    const section = ui.section({
      title: 'Favorite Users',
      hint: 'Click a username in the Wayfarer side panel to add or remove it here. Color is set in Marker Style. Tick a username to copy just that subset.',
      children: [ui.buttonRow([copyAllBtn, copySelectedBtn, clearAllBtn]), listContainer, countEl],
    });
    body.append(section);
    render();
    waeFavoriteUsersRenderHook = render;
  }

  let waeMarkListController = null;
  function waeOpenMarkedWayspotListModal() {
    if (waeMarkListController) return; // already open
    waeMarkListController = wfmmWindow.WFMM.ui.openModal({
      id: 'wae-mark-list',
      title: 'Abuse Report Draft - Marked Wayspots',
      className: 'wae-dialog',
      showFooterButtons: false,
      ownerPluginId: PLUGIN_ID,
      desktopInteractions: { minWidth: 360, minHeight: 320 },
      buildContent(modal) {
        return waeRenderMarkedWayspotListSection(modal.ui, modal.body);
      },
      onClose() {
        waeMarkListController = null;
        waeMarkListRenderHook = null;
        waeShowClearPromptHook = null;
        waeFavoriteUsersRenderHook = null;
      },
    });
  }
  // ---------------------------------------------------------------------

  // Marker Style settings -- its own modal, opened from a small cog
  // button next to the tool panel's title (see buildPanelContent()),
  // rather than living inline at the bottom of the panel where it used
  // to. Kept as a separate modal (not folded back into the main panel)
  // because the {onOk}-returning renderXSection(body) shape -- same
  // pattern the suite's own bundled Planner plugin uses for its own
  // settings, see renderPlannerMarkerSettingsSection()/
  // createPlannerSettingsModal()'s own openSettings() in Base's source
  // -- is what waeOpenMarkerSettingsModal() below wraps with
  // WFMM.ui.openModal(). Every control here still applies (and persists)
  // immediately on change, matching how this section already behaved
  // when it lived inline -- so onOk here is just a no-op to satisfy
  // openModal()'s contentHooks contract, not a real save step.
  //
  // This used to also get its own entry in the native Settings side-
  // panel list (WFMM.sidePanel.appendSettingsAction(), see
  // attachSettingsActions()) -- removed as more than this one small
  // setting needed: it's a once-in-a-while adjustment, not something
  // that belongs competing for attention in the Settings list the way a
  // whole plugin's own entry point does. A literal new tab inside
  // WFMM's own native Settings window (the Side Panels & UI / Markers /
  // Map / Planner / ... tabbed modal opened from the gear icon) was
  // never an option regardless -- confirmed against Base's own
  // settings-hub source, that modal's own SECTIONS list is an
  // Object.freeze()'d array, and the function that renders a given
  // section's body hardcodes each non-generic one to a specific bundled
  // plugin by id, with no registerSection()-style hook an externally-
  // registered plugin like this one can call into.
  function waeRenderMarkerStyleSection(ui, body) {
    function updateAppearance(partial) {
      const next = waeNormalizeAppearance({ ...waeLoadAppearance(), ...partial });
      waeSaveAppearance(next);
      return next;
    }
    const initialAppearance = waeLoadAppearance();
    // Declared up front: the email-color handler below needs to keep it
    // in sync while it's still following that color.
    let styleImportColorInput = null;
    const styleColorInput = ui.colorInput({
      value: initialAppearance.fillColor,
      onInput: (v) => {
        updateAppearance({ fillColor: v });
        // Imported markers follow the email color until they've been
        // given a color of their own -- reflect that in their picker.
        if (styleImportColorInput && !waeLoadAppearance().importColor) styleImportColorInput.value = v;
      },
    });
    // Feature request: separate color for CSV-imported rows' markers.
    // Shows the email color while unset (importColor null); picking a
    // color stores it and the two become independent. Everything else
    // about imported markers (size, cluster size, opacity, ring) is
    // shared with the email markers, so there are no extra controls.
    styleImportColorInput = ui.colorInput({
      value: initialAppearance.importColor || initialAppearance.fillColor,
      onInput: (v) => updateAppearance({ importColor: v }),
    });
    const styleImportSameBtn = ui.button({
      text: 'Same as email color',
      onClick: () => {
        const a = updateAppearance({ importColor: null });
        styleImportColorInput.value = a.fillColor;
      },
    });
    const styleSizeRange = ui.rangeInput({
      min: 4, max: 24, step: 1, value: initialAppearance.markerSize,
      formatValue: (v) => `${v}px`,
      onInput: (v) => {
        updateAppearance({ markerSize: Number(v) });
        // Marked Wayspots' own crosses ride on this same markerSize now
        // (see waeGetMarkedWayspotSvgMarkup()) -- redraw them too,
        // same as the abuse-report crosses eventually pick this up via
        // waeSafeRefreshPulses(), just immediately rather than waiting
        // for the next map idle since these aren't on that refresh cycle.
        waeRenderMarkedWayspotMarkers();
      },
    });
    // BUGFIX (not upstream, feature request): this used to be the same
    // markerSize as the cross above (waeGetClusterIcon() just multiplied
    // it by a fixed 1.15) -- decoupled into its own field/control, see
    // WAE_APPEARANCE_DEFAULTS.clusterMarkerSize's own comment. Cluster
    // markers ALSO get bigger automatically at the lowest zoom level
    // (see WAE_CLUSTER_EXPAND_FACTOR) -- that expansion isn't a separate
    // control here, it's a fixed multiplier applied on top of whatever
    // size is set below, only while zoomed all the way out.
    const styleClusterSizeRange = ui.rangeInput({
      min: 4, max: 24, step: 1, value: initialAppearance.clusterMarkerSize,
      formatValue: (v) => `${v}px`,
      onInput: (v) => updateAppearance({ clusterMarkerSize: Number(v) }),
    });
    const styleFillOpacityRange = ui.rangeInput({
      min: 0, max: 1, step: 0.05, value: initialAppearance.fillOpacity,
      formatValue: (v) => `${Math.round(Number(v) * 100)}%`,
      onInput: (v) => updateAppearance({ fillOpacity: Number(v) }),
    });
    const styleBorderColorInput = ui.colorInput({
      value: initialAppearance.borderColor,
      onInput: (v) => updateAppearance({ borderColor: v }),
    });
    const styleBorderWidthRange = ui.rangeInput({
      min: 0, max: 8, step: 1, value: initialAppearance.borderWidth,
      formatValue: (v) => `${v}px`,
      onInput: (v) => updateAppearance({ borderWidth: Number(v) }),
    });
    const styleBorderOpacityRange = ui.rangeInput({
      min: 0, max: 1, step: 0.05, value: initialAppearance.borderOpacity,
      formatValue: (v) => `${Math.round(Number(v) * 100)}%`,
      onInput: (v) => updateAppearance({ borderOpacity: Number(v) }),
    });
    const resetStyleBtn = ui.button({
      text: 'Reset to default',
      onClick: () => {
        const d = waeNormalizeAppearance(WAE_APPEARANCE_DEFAULTS);
        waeSaveAppearance(d);
        styleColorInput.value = d.fillColor;
        styleImportColorInput.value = d.fillColor; // importColor resets to null = follows the email color
        styleBorderColorInput.value = d.borderColor;
        styleSizeRange.input.value = String(d.markerSize);
        styleSizeRange.valueEl.textContent = `${d.markerSize}px`;
        styleClusterSizeRange.input.value = String(d.clusterMarkerSize);
        styleClusterSizeRange.valueEl.textContent = `${d.clusterMarkerSize}px`;
        styleFillOpacityRange.input.value = String(d.fillOpacity);
        styleFillOpacityRange.valueEl.textContent = `${Math.round(d.fillOpacity * 100)}%`;
        styleBorderWidthRange.input.value = String(d.borderWidth);
        styleBorderWidthRange.valueEl.textContent = `${d.borderWidth}px`;
        styleBorderOpacityRange.input.value = String(d.borderOpacity);
        styleBorderOpacityRange.valueEl.textContent = `${Math.round(d.borderOpacity * 100)}%`;
        styleClickableToggle.input.checked = d.clickable;
        styleMarkColorInput.value = d.markColor;
        styleFavoriteUserColorInput.value = d.favoriteUserColor;
        waeRenderMarkedWayspotMarkers();
        waeRestyleCurrentFavoriteUsername();
      },
    });
    const styleClickableToggle = ui.checkboxRow({
      label: 'Clickable markers (mapview/submit only)',
      checked: initialAppearance.clickable,
      onChange: (checked) => updateAppearance({ clickable: checked }),
    });
    // v1.64.0, moved here in v1.67.1 from the Marked Wayspots list (it is a
    // general setting, not part of the draft list): the review map's
    // info-window controls. Not part of the marker appearance, so "Reset
    // to default" below deliberately leaves it alone. Applied straight
    // away (adds the controls to / removes them from any window that is
    // already open).
    const styleReviewControlsToggle = ui.checkboxRow({
      label: 'Show add-to-draft controls in review map info windows',
      checked: waeReviewMapControlsSetting(),
      onChange: (checked) => {
        wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'reviewMapAbuseControls', checked);
        waeReviewIwSchedule();
      },
    });
    // Feature request: color for the separate Marked Wayspots dots (see
    // waeRenderMarkedWayspotMarkers()) -- a distinct field/control from
    // fillColor above since it's a genuinely different marker type (this
    // plugin's own scratch list, not an extracted abuse-report ticket),
    // re-rendering those dots immediately on change the same way
    // updateAppearance()'s other onInput handlers apply immediately to
    // the crosses/clusters -- WFMM.settings alone doesn't redraw
    // anything already on screen, this plugin has to do that itself.
    const styleMarkColorInput = ui.colorInput({
      value: initialAppearance.markColor,
      onInput: (v) => {
        updateAppearance({ markColor: v });
        waeRenderMarkedWayspotMarkers();
      },
    });
    // Feature request: color for a favorited submitter's username in the
    // side panel (see waeStartSidePanelDetailsWatcher()'s own comment) --
    // restyles whatever username is currently on screen immediately on
    // change, same reasoning as markColor's own onInput just above.
    const styleFavoriteUserColorInput = ui.colorInput({
      value: initialAppearance.favoriteUserColor,
      onInput: (v) => {
        updateAppearance({ favoriteUserColor: v });
        waeRestyleCurrentFavoriteUsername();
      },
    });
    const styleSection = ui.section({
      title: 'Marker Style',
      hint: 'Color/size for the map markers this plugin draws (single reports and clusters). Changes apply immediately.',
      children: [
        ui.fieldRow({ label: 'Color', input: styleColorInput, help: 'Markers for reports scanned from emails.' }),
        ui.fieldRow({ label: 'Imported color', input: styleImportColorInput, help: 'Markers for CSV-imported locations. Starts out identical to Color and follows it until you pick your own; size, cluster and ring settings are shared with the email markers.' }),
        ui.buttonRow([styleImportSameBtn]),
        ui.fieldRow({ label: 'Cross size', input: styleSizeRange.row, help: 'Single-report \u201cX\u201d markers. On the review maps they are drawn 3px larger.' }),
        ui.fieldRow({ label: 'Cluster size', input: styleClusterSizeRange.row, help: `Multi-report \u201cheatmap\u201d markers. Automatically shown ${WAE_CLUSTER_EXPAND_FACTOR}\u00d7 bigger at the lowest zoom level.` }),
        ui.fieldRow({ label: 'Fill opacity', input: styleFillOpacityRange.row, help: 'Only visible on cluster markers -- a single X marker is always fully opaque.' }),
        ui.fieldRow({ label: 'Ring color', input: styleBorderColorInput, help: 'Cluster markers only.' }),
        ui.fieldRow({ label: 'Ring width', input: styleBorderWidthRange.row }),
        ui.fieldRow({ label: 'Ring opacity', input: styleBorderOpacityRange.row }),
        styleClickableToggle.row,
        styleReviewControlsToggle.row,
        ui.fieldRow({ label: 'Marked Wayspot color', input: styleMarkColorInput, help: 'The cross shown for entries on your Marked Wayspots list.' }),
        ui.fieldRow({ label: 'Favorite user color', input: styleFavoriteUserColorInput, help: 'A submitter\u2019s username in the side panel, once favorited.' }),
        ui.buttonRow([resetStyleBtn]),
      ],
    });
    // v1.71.0/1.72.0: what the abuse form auto-fill (the button in the
    // Marked Wayspots list) enters besides the location list.
    const contact = waeGetReporterContact();
    const reporterNameInput = ui.textInput({
      placeholder: 'Name for the abuse form',
      value: contact.name,
      autocomplete: 'off',
      onInput: (v) => wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'reporterName', v.trim()),
    });
    const reporterEmailInput = ui.textInput({
      type: 'email',
      placeholder: 'Email for the abuse form',
      value: contact.email,
      autocomplete: 'off',
      onInput: (v) => wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'reporterEmail', v.trim()),
    });
    // A menu of the form's own options, so the exact title is always right.
    // A title saved earlier that isn't one of them (typed by hand in
    // v1.72) stays selectable instead of silently changing.
    const issueChoices = [{ value: '', label: 'Don\u2019t select \u2014 I\u2019ll choose' }]
      .concat(WAE_ISSUE_TYPE_OPTIONS.map((t) => ({ value: t, label: t })));
    if (contact.issueType && !WAE_ISSUE_TYPE_OPTIONS.includes(contact.issueType)) {
      issueChoices.push({ value: contact.issueType, label: `${contact.issueType} (saved earlier)` });
    }
    const onIssueChange = (v) => wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'reporterIssueType', String(v || '').trim());
    let reporterIssueInput;
    if (typeof ui.selectInput === 'function') {
      reporterIssueInput = ui.selectInput({ options: issueChoices, value: contact.issueType, onChange: onIssueChange });
    } else {
      reporterIssueInput = document.createElement('select');
      for (const c of issueChoices) {
        const o = document.createElement('option');
        o.value = c.value;
        o.textContent = c.label;
        reporterIssueInput.append(o);
      }
      reporterIssueInput.value = contact.issueType;
      reporterIssueInput.addEventListener('change', () => onIssueChange(reporterIssueInput.value));
    }
    const makeTextarea = (opts) => {
      if (typeof ui.textarea === 'function') return ui.textarea(opts);
      const t = document.createElement('textarea');
      t.className = 'wfmm-textarea';
      t.placeholder = opts.placeholder || '';
      t.value = opts.value || '';
      t.rows = opts.rows || 3;
      t.addEventListener('input', () => opts.onInput(t.value, t));
      return t;
    };
    const reporterDetailsInput = makeTextarea({
      placeholder: 'Default text for \u201cAbuse report details\u201d (empty = leave to you)',
      value: contact.reportDetails,
      rows: 3,
      onInput: (v) => wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'reporterReportDetails', v.trim()),
    });
    const reporterAbuserInput = makeTextarea({
      placeholder: 'Default text for \u201cDetails of the abuser(s)\u201d (empty = leave to you)',
      value: contact.abuser,
      rows: 2,
      onInput: (v) => wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'reporterAbuser', v.trim()),
    });
    const listInDetailsToggle = ui.checkboxRow({
      label: 'Also put the Wayspot list, with notes, in the report details (the location field then gets it without notes)',
      checked: contact.listInDetails,
      onChange: (checked) => wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'reporterListInDetails', checked === true),
    });
    const sightengineToggle = ui.checkboxRow({
      label: 'When the Sightengine check says a review photo is over 90% AI-generated, start the abuse form auto-fill for that Wayspot',
      checked: contact.sightengineAutoStart,
      onChange: (checked) => wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'sightengineAutoStart', checked === true),
    });
    const afterSubmitToggle = ui.checkboxRow({
      label: 'After the form is submitted: close its tab and offer to clear the draft list',
      checked: contact.afterSubmit,
      onChange: (checked) => wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'afterSubmitCleanup', checked === true),
    });
    const autofillSection = ui.section({
      title: 'Abuse form auto-fill',
      hint: 'Entered in the Help Center abuse form by the \u201cAuto-fill abuse form\u201d button in the Marked Wayspots list, next to the list of Wayspots itself. Leave a field empty to fill it in yourself; fields that already have text are never overwritten. The list option (off by default) puts the Wayspots, with their notes, in the report details instead of your default text, while the location field gets the list without notes. The Sightengine option (on by default) applies to the review row\u2019s Sightengine button: if the verdict is over 90% AI-generated, that tab goes to the abuse form and fills it in for the review\u2019s Wayspot (issue Photo Issues, the verdict and your note as the report details); with it off the tab simply stays on Sightengine. The last option (off by default) watches for your click on Submit: once the form has gone, the tab closes after 1.5 seconds and the draft list asks whether to clear the Wayspots that were sent. Saved with this plugin\u2019s settings, so it is included in WFMM\u2019s settings backups.',
      children: [
        ui.fieldRow({ label: 'Name', input: reporterNameInput }),
        ui.fieldRow({ label: 'Email', input: reporterEmailInput }),
        ui.fieldRow({ label: 'Issue type', input: reporterIssueInput }),
        ui.fieldRow({ label: 'Report details', input: reporterDetailsInput }),
        ui.fieldRow({ label: 'Abuser(s)', input: reporterAbuserInput }),
        listInDetailsToggle.row,
        sightengineToggle.row,
        afterSubmitToggle.row,
      ],
    });
    body.append(styleSection, autofillSection);
    return {
      onOk() { return true; }, // no-op -- every control above already saved on its own onInput/onChange
    };
  }

  let waeMarkerSettingsController = null;
  function waeOpenMarkerSettingsModal() {
    if (waeMarkerSettingsController) return; // already open
    waeMarkerSettingsController = wfmmWindow.WFMM.ui.openModal({
      id: 'wae-marker-settings',
      title: 'Abuse Reports - Marker Style',
      className: 'wae-dialog',
      showFooterButtons: false,
      ownerPluginId: PLUGIN_ID,
      desktopInteractions: { minWidth: 360, minHeight: 280 },
      buildContent(modal) {
        return waeRenderMarkerStyleSection(modal.ui, modal.body);
      },
      onClose() {
        waeMarkerSettingsController = null;
      },
    });
  }
  // ---------------------------------------------------------------------

  // Builds the panel's BODY content into an already-open WFMM.ui modal --
  // called as openModal()'s buildContent(modalController). The modal
  // itself (backdrop, dialog, header/title, close button, Escape/
  // backdrop-click handling) is entirely WFMM.ui's own doing now; this
  // only ever touches modal.body. Every button/input/section is built via
  // the `ui` service handed in here, same one openModal() itself uses
  // internally, so this panel matches the rest of the suite's look
  // instead of a hand-copied approximation of it.
  function buildPanelContent(modal) {
    const ui = modal.ui;
    waeUiApi = ui; // so helpers called outside buildContent's own scope (log(), the popover, table row clicks) can still reach it

    const countEl = ui.createElement('div', { className: 'wae-sub', text: 'Loading...' });

    const scanBtn = ui.button({ text: 'Scan Imported Emails', variant: 'primary' });
    const importCsvBtn = ui.button({ text: 'Import CSV' });
    const exportBtn = ui.button({ text: 'Export CSV', disabled: true });
    const clearBtn = ui.button({ text: 'Clear Extracted Data', variant: 'danger', disabled: true });
    const buttonRowEl = ui.buttonRow([scanBtn, importCsvBtn, exportBtn, clearBtn]);
    const csvFileInput = ui.createElement('input', {
      attrs: { type: 'file', accept: '.csv,text/csv' },
      style: { display: 'none' },
    });
    // Always visible, not just shown after a failed import -- the whole
    // point is knowing the format going in, not finding out by trial and
    // error. Latitude/Longitude are the only columns waeParseCsvImport()
    // actually requires; everything else in this example is there to
    // show what else it recognizes, not because a real file needs them.
    // The header and its data row are on separate lines (.wae-csv-hint
    // has white-space:pre-line for this) rather than run together with
    // "then", so the example actually reads like a real CSV instead of
    // a sentence describing one.
    const csvHint = ui.createElement('div', {
      className: 'wae-sub wae-csv-hint',
      text: 'Import CSV expects a header row -- only Latitude/Longitude are required. Example:\nLatitude,Longitude,Name,Comment,Conversation ID\n1.2345678,1.2345678,Example Wayspot,Optional note,12345',
    });

    const progressEl = ui.createElement('div', { className: 'wae-progress' });

    const searchInput = ui.textInput({
      className: 'wfmm-input wfmm-input-large wae-search-input',
      placeholder: 'Search name, ticket, location/report text\u2026',
    });
    // waeSearchQuery outlives the panel (the dialog is torn down on close and
    // rebuilt on open), so put the text back in the box -- otherwise the table
    // stays filtered by a query the person can't see or clear.
    searchInput.value = waeSearchQuery;

    const searchWrap = ui.createElement('div', { className: 'wae-search-wrap' });
    const searchClearBtn = ui.createElement('button', { className: 'wae-search-clear', text: '\u2715' });
    searchClearBtn.type = 'button';
    searchClearBtn.title = 'Clear search';
    searchClearBtn.setAttribute('aria-label', 'Clear search');
    searchWrap.append(searchInput, searchClearBtn);
    const waeSyncSearchClear = () => searchWrap.classList.toggle('wae-has-text', !!searchInput.value);
    waeSyncSearchClear();

    const autoCloseToggle = ui.checkboxRow({
      label: 'Close this panel when a row jumps the map to its location',
      checked: waeAutoCloseOnNavigateEnabled(),
      onChange: (checked) => wfmmWindow.WFMM.settings.set(PLUGIN_ID, 'autoCloseOnNavigate', checked),
    });

    const tableContainer = ui.createElement('div', { className: 'wae-table-container' });
    const logEl = ui.createElement('div', { className: 'wae-log' });

    // ---- Marked Wayspots ----
    // List icon -- opens the modal listing everything marked so far via
    // the "+" on the Wayspot details side panel (see
    // waeStartSidePanelDetailsWatcher()), with its own Copy All/Clear
    // All (waeOpenMarkedWayspotListModal()). Same tucked-next-to-the-
    // summary-line treatment as markerStyleBtn/emailImporterBtn below,
    // for the same reason: a once-in-a-while tool, not something that
    // should compete with the table/export/scan controls every time the
    // panel opens.
    const markListBtn = ui.iconButton({
      iconSvg: WAE_LIST_ICON_SVG,
      title: 'Marked Wayspots List',
      onClick: () => waeOpenMarkedWayspotListModal(),
    });

    // ---- Marker Style ----
    // BUGFIX (not upstream, feature request): used to also have its own
    // entry in the native Settings side-panel list -- see
    // attachSettingsActions()'s own comment for why that was more than
    // this one setting needed. This cog button is now the only way in:
    // tucked out of the way next to the panel's own summary line rather
    // than sitting in the panel as a labeled button by default, so it
    // doesn't compete for attention with the table/export/scan controls
    // every time the panel opens -- the same reasoning as it having its
    // own modal at all (see waeRenderMarkerStyleSection()'s own comment).
    const markerStyleBtn = ui.iconButton({
      iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
      title: 'Marker Style Settings',
      onClick: () => waeOpenMarkerSettingsModal(),
    });

    // ---- Email Importer ----
    // Same treatment as markerStyleBtn just above, for the same reason:
    // the companion Abuse Email Importer script (a separate userscript --
    // it needs GM_xmlhttpRequest for Gmail OAuth, a sandbox-only API, so
    // it can't run @inject-into page the way this script does, and so
    // can't just be merged into this file outright) used to add its own
    // separate "Import Abuse Report Emails" entry to Base's Settings
    // side-panel list -- removed as of its own v4.10.0, in favor of this
    // one small envelope icon here instead, so there's exactly one entry
    // in that list ("Abuse Reports") rather than two separate
    // ones a reviewer would have to know to look for individually.
    // Both scripts run in the same page-context window (this script via
    // @inject-into page; the importer's own wfmmWindow resolves to
    // unsafeWindow, which IS that same window -- see its own comment on
    // that declaration), so window.WayfarerAbuseEmailImporter is a plain,
    // synchronously-available object here, not something that needs
    // fetching or waiting on -- checked fresh on every click (not just
    // once at panel-build time) since the two scripts' own startup timing
    // relative to each other isn't guaranteed, and the importer script
    // being missing/not-yet-loaded is a perfectly normal state (it's an
    // optional companion script, not a dependency) rather than an error.
    const emailImporterBtn = ui.iconButton({
      iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22 6 12 13 2 6"></polyline></svg>',
      title: 'Import Abuse Report Emails',
      onClick: () => {
        const wei = window.WayfarerAbuseEmailImporter;
        if (wei && typeof wei.togglePanel === 'function') {
          wei.togglePanel();
        } else {
          log(logEl, '\u2717 Abuse Email Importer script not detected -- install/enable it to import from Gmail or .eml files.', 'err');
        }
      },
    });

    const panelHeaderRow = ui.createElement('div', { className: 'wae-panel-header-row' });
    const panelHeaderActions = ui.createElement('div', { className: 'wae-panel-header-actions' });
    panelHeaderActions.append(markListBtn, emailImporterBtn, markerStyleBtn);
    panelHeaderRow.append(countEl, panelHeaderActions);

    modal.body.append(panelHeaderRow, buttonRowEl, csvHint, csvFileInput, progressEl, searchWrap, autoCloseToggle.row, tableContainer, logEl);

    waeUI = { countEl, tableContainer, logEl, scanBtn, exportBtn, clearBtn, searchInput };
    waeStartPanelFit(modal, tableContainer); // v1.68.0

    let waeSearchDebounceTimer = null;
    searchInput.addEventListener('input', () => {
      waeSyncSearchClear();
      clearTimeout(waeSearchDebounceTimer);
      waeSearchDebounceTimer = setTimeout(() => {
        waeSearchQuery = searchInput.value;
        waeCurrentPage = 1;
        waeRenderFilteredTable();
      }, 200);
    });

    searchClearBtn.addEventListener('click', () => {
      clearTimeout(waeSearchDebounceTimer); // don't let a pending debounce re-apply the old text
      searchInput.value = '';
      waeSyncSearchClear();
      waeSearchQuery = '';
      waeCurrentPage = 1;
      waeRenderFilteredTable();
      searchInput.focus();
    });

    scanBtn.addEventListener('click', async () => {
      scanBtn.disabled = true;
      progressEl.textContent = 'Scanning imported emails...';
      try {
        const { extractedCount, ticketCount, missingCoords } = await waeScanAndPersist((done, total) => {
          progressEl.textContent = `Scanning imported emails... ${done}/${total}`;
        });
        progressEl.textContent = '';
        log(logEl, `✓ Scanned: found ${extractedCount} location(s) across ${ticketCount} abuse report ticket(s).`, 'ok');
        if (missingCoords) {
          log(logEl, `⚠ ${missingCoords} report(s) had no parseable coordinates -- check the raw columns in the CSV.`, 'warn');
        }
      } catch (e) {
        progressEl.textContent = '';
        log(logEl, `✗ Scan failed: ${e.message || e}`, 'err');
      } finally {
        scanBtn.disabled = false;
        waeCurrentPage = 1;
        refreshPanel();
        waeResyncMapIfVisible();
        waeResyncReviewIfVisible();
      }
    });

    importCsvBtn.addEventListener('click', () => csvFileInput.click());
    csvFileInput.addEventListener('change', async () => {
      const file = csvFileInput.files[0];
      csvFileInput.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const { records, skipped, error } = waeParseCsvImport(text);
        if (error) {
          log(logEl, `✗ ${error}`, 'err');
          return;
        }
        if (!records.length) {
          log(logEl, `${skipped ? `All ${skipped} row(s)` : 'No rows'} had missing or invalid coordinates -- nothing imported.`, 'warn');
          return;
        }
        await putExtractedRecords(records);
        log(logEl, `✓ Imported ${records.length} location(s) from "${file.name}"${skipped ? ` (${skipped} row(s) skipped: missing/invalid coordinates)` : ''}.`, 'ok');
      } catch (e) {
        log(logEl, `✗ CSV import failed: ${e.message || e}`, 'err');
      } finally {
        waeCurrentPage = 1;
        refreshPanel();
        waeResyncMapIfVisible();
        waeResyncReviewIfVisible();
      }
    });

    exportBtn.addEventListener('click', async () => {
      try {
        const extracted = await getAllExtractedRecords();
        if (!extracted.length) return;
        const nearby = waeFindNearbyDuplicates(extracted);
        const withNearby = extracted.map((r) => ({
          ...r,
          nearbyTickets: waeFormatNearbyForCsv(nearby.get(r.id)),
          ticketStatus: waeStatusLabel(r.ticketStatus),
          // ISO 8601 rather than a locale-formatted string (what the
          // table itself shows) -- unambiguous regardless of which
          // spreadsheet app/locale opens the file, and sorts correctly
          // as plain text too, which a "Sep 10, 2026" string wouldn't.
          lastResponseAt: Number.isFinite(r.lastResponseAt) ? new Date(r.lastResponseAt).toISOString() : '',
        }));
        downloadCsv(withNearby);
        log(logEl, `✓ Exported ${extracted.length} row(s) to CSV.`, 'ok');
      } catch (e) {
        log(logEl, `✗ Export failed: ${e.message || e}`, 'err');
      }
    });

    clearBtn.addEventListener('click', async () => {
      // BUGFIX (not upstream): this warning used to only mention scanned
      // data ("you can re-scan any time"), which was accurate for every
      // row until CSV-imported ones existed -- those don't come from an
      // email at all, so there's nothing to re-derive them from if this
      // clears them too. Checked for and mentioned explicitly now rather
      // than letting the reassuring "re-scan any time" line quietly
      // apply to rows it doesn't actually cover.
      const allBefore = await getAllExtractedRecords();
      const hasCsvRows = allBefore.some((r) => r.source === 'csv');
      // v1.84.0: Wayspots reported from the draft, still waiting for their ticket, have no email behind them either
      const hasReportedRows = allBefore.some((r) => r.source === 'reported');
      const csvWarning = (hasCsvRows || hasReportedRows)
        ? ` This will ALSO permanently delete any ${[hasCsvRows && 'CSV-imported', hasReportedRows && 'reported-from-draft'].filter(Boolean).join(' and ')} location(s) -- unlike scanned data, those cannot be recovered by re-scanning.`
        : '';
      if (!confirm(`Clear all extracted abuse-report data? The original imported emails are untouched -- you can re-scan any time.${csvWarning}`)) return;
      try {
        await clearExtractedRecords();
        await clearTicketDetails();
        waeSaveDeletedRowKeys([]); // a fresh scan after a full clear restores rows deleted by hand too
        log(logEl, '✓ Cleared extracted-report storage.', 'ok');
      } catch (e) {
        log(logEl, `✗ Clear failed: ${e.message || e}`, 'err');
      } finally {
        waeCurrentPage = 1;
        refreshPanel();
        waeResyncMapIfVisible();
        waeResyncReviewIfVisible();
      }
    });

    refreshPanel();

    // Returned as this modal's contentHooks -- WFMM.ui.openModal() calls
    // onClose() itself once the dialog is actually torn down, regardless
    // of whether that happened via the × button, Escape, a backdrop
    // click, or our own waeGoToLocation() calling modal.close()
    // programmatically -- one place to null out the now-stale DOM refs
    // instead of every close path having to remember to do it.
    return {
      onClose() {
        waeStopPanelFit();
        waeUI = null;
        waePanelController = null;
        waeCloseNearbyPopover();
      },
    };
  }

  function openPanel() {
    if (waePanelController) return; // already open
    waePanelController = wfmmWindow.WFMM.ui.openModal({
      id: 'wae-panel',
      title: 'Wayfarer Map Mods - Abuse Reports',
      className: 'wae-dialog',
      showFooterButtons: false,
      ownerPluginId: PLUGIN_ID,
      // Dragging/resizing itself isn't something a plugin can turn on for
      // its own modal -- confirmed against the real source
      // (resolveDesktopModalInteractionOptions() in
      // desktop-modal-interactions.js): whatever draggable/resizable a
      // modal passes in gets OVERWRITTEN with the suite-wide "Make modals
      // draggable"/"Make modals resizeable" preference (Base's own Side
      // Panel settings), same as every other WFMM.ui modal, including the
      // suite's own (e.g. Reporting History). Since this panel already
      // goes through openModal(), it's automatically draggable/resizable
      // too, for free, once the user turns that preference on -- nothing
      // to opt into here. minWidth/minHeight below only matter once
      // resizing is on, same as Reporting History's own desktopInteractions.
      desktopInteractions: { minWidth: 420, minHeight: 320 },
      buildContent: buildPanelContent,
    });
  }

  function closePanel() {
    waePanelController?.close();
  }

  function togglePanel() {
    if (waePanelController) closePanel();
    else openPanel();
  }

  // ---------------------------------------------------------------------
  // BUGFIX (not upstream) + refactor: this used to hand-roll its own
  // side-panel integration -- confirmed against Report Wayspots v3.3.0's
  // own insertReportingHistoryLinkIfReady()/
  // insertReportingSettingsLinkIfReady(): appendChild a plain <a> into
  // ".wfmapmods-settings-links" the first time it exists, found via a
  // whole-document MutationObserver (childList+subtree, debounced 50ms).
  // That copied a real bug from that other script (an observer that
  // disconnects itself after first success has no way to notice the
  // link is gone and never re-add it if Base's side panel gets torn
  // down and rebuilt by Angular's router -- reported as the plugin going
  // completely unreachable after navigating between routed views) and,
  // separately, never used the mechanism WFMM.sidePanel actually offers
  // for exactly this: appendSettingsAction(element, options) drops an
  // element into the real settings-actions slot and hands back an
  // unsubscribe function, while WFMM.sidePanel.onReady()/onCleared()
  // (already relied on elsewhere in this file -- see
  // waeStartSidePanelDetailsWatcher()) fire every time that slot is
  // actually rebuilt, which is the real, public replacement for the
  // MutationObserver above: re-adding through onReady() covers the
  // Angular-router case the old code was trying to patch over, without
  // watching the entire document tree to do it.
  //
  // Just the one link now -- Marker Style settings used to also get a
  // second entry here of its own ("Abuse Report Extractor \u2013 Marker
  // Style"), but a whole separate Settings-list entry for what's really
  // one small piece of this plugin's own panel was more than it needed
  // to be. It's reachable from inside the tool panel itself instead now
  // (see the cog button next to its title, in buildPanelContent()) --
  // tucked behind a click rather than sitting in the panel by default,
  // same reasoning as it having its own modal at all: it's a
  // once-in-a-while adjustment, not something that should compete for
  // attention with the table/export/scan controls every time the panel
  // opens.
  // ---------------------------------------------------------------------

  let waeSettingsActionCleanup = null;
  let waeSidePanelReadyUnsub = null;
  let waeSidePanelClearedUnsub = null;

  function attachSettingsActions() {
    waeSettingsActionCleanup?.();
    const toolLink = document.createElement('a');
    toolLink.textContent = 'Abuse Reports';
    toolLink.style.cursor = 'pointer';
    toolLink.addEventListener('click', (ev) => {
      ev.preventDefault();
      togglePanel();
    });
    waeSettingsActionCleanup = wfmmWindow.WFMM.sidePanel.appendSettingsAction(toolLink);
  }

  function detachSettingsActions() {
    waeSettingsActionCleanup?.();
    waeSettingsActionCleanup = null;
  }


  function startPlugin() {
    waePluginActive = true;
    // Answers the Help Center tab's data request for the abuse form
    // auto-fill (see waeOpenAbuseFormAutofill()). Re-adding the same
    // function reference on a restart is a no-op.
    window.addEventListener('message', waeHandleAbuseFormMessage);
    window.addEventListener('message', waeHandleSightengineMessage);
    // A review candidate can arrive before this runs (the request hook is
    // installed at load) -- show its row now that the plugin's on.
    try {
      if (waeLatestReviewCandidate && waeReviewIsOnRoute()) waeInsertReviewAbuseRow(waeLatestReviewCandidate);
    } catch (e) { /* not on a route we can check yet -- next response will insert it */ }
    // Fired off first, before anything else in this function, so the
    // IndexedDB read is already in flight by the time waeResyncMapIfVisible()
    // (below) goes looking for it -- see waeEnsureRecordsLoaded()'s own
    // comment for the bug this is the other half of the fix for. Not
    // awaited here -- startPlugin() itself isn't async, and doesn't need
    // to be: every real consumer (waeResyncMapIfVisible(),
    // waeApplyLayerEnabled(), the review-map attach path) awaits this
    // same cached promise itself before its own first draw.
    waeEnsureRecordsLoaded();
    // One-time migration from the old raw-localStorage keys (removed
    // from this file as of v1.37.0, see WAE_SETTINGS_DEFAULTS' own
    // comment) into WFMM.settings -- only runs if this plugin id has
    // genuinely never been registered with WFMM.settings before (get()
    // with no fallback comes back undefined only in that case;
    // registerPlugin() itself always leaves AT LEAST {} behind after the
    // first call, so this can't accidentally re-run and clobber a real
    // choice made after upgrading). Must run BEFORE registerPlugin()
    // just below -- that's what makes get(PLUGIN_ID) stop looking "never
    // registered" to this check. Old keys are removed once migrated so
    // this doesn't leave two sources of truth lying around, silently
    // disagreeing, forever. WAE_MAP_VISIBLE_KEY is deliberately NOT part
    // of this -- see its own comment for why that one's already handled,
    // as a one-time seed straight into WFMM.layers.register() instead.
    if (wfmmWindow.WFMM.settings.get(PLUGIN_ID) === undefined) {
      const legacyAppearanceRaw = localStorage.getItem('wae_marker_appearance');
      const legacyAutoClose = localStorage.getItem('wae_autoclose_on_navigate');
      if (legacyAppearanceRaw !== null || legacyAutoClose !== null) {
        let legacyAppearance;
        try { legacyAppearance = JSON.parse(legacyAppearanceRaw || '{}'); } catch (e) { legacyAppearance = {}; }
        wfmmWindow.WFMM.settings.setPlugin(PLUGIN_ID, {
          appearance: waeNormalizeAppearance(legacyAppearance),
          autoCloseOnNavigate: legacyAutoClose !== 'false',
        });
        localStorage.removeItem('wae_marker_appearance');
        localStorage.removeItem('wae_autoclose_on_navigate');
      }
    }
    wfmmWindow.WFMM.settings.registerPlugin(PLUGIN_ID, WAE_SETTINGS_DEFAULTS);
    // Registering as an external plugin (the only path startPlugin() is
    // reached from -- see registerOrSelfStart() below) already implies
    // WFMM.plugins exists, which per the real v4.0.0+ source means
    // WFMM.ui, WFMM.markerAppearance, and WFMM.layers do too -- all
    // populated by the same suite bootstrap (confirmed: all three are
    // assigned right alongside each other in that bootstrap sequence).
    // injectStyle() is idempotent (replaces by id, see WFMM.ui's own
    // dom.js), so this is safe to call every startPlugin() -- no separate
    // "already injected" guard needed.
    wfmmWindow.WFMM.ui.injectStyle('wae-extra-styles', STYLE);
    // registerStyle() itself is NOT idempotent -- it throws if the same
    // key is already registered, which matters here since startPlugin()
    // can run again if the plugin's toggled off/on in Plugin Manager. The
    // unregister function it returns is called in stopPlugin() below for
    // exactly that reason.
    waeUnregisterAppearance = wfmmWindow.WFMM.markerAppearance.registerStyle({
      key: WAE_APPEARANCE_STYLE_KEY,
      pluginId: PLUGIN_ID,
      // normalizeResolvedStyle() (marker-appearance.js) reads style.generic.*,
      // not a flat object -- waeLoadAppearance() stays flat for our own
      // icon-building code's convenience, wrapped here to match what the
      // registry actually expects from a resolve() callback.
      // Only the six fields normalizeResolvedStyle() (marker-appearance.js)
      // actually reads from style.generic -- clickable isn't a WFMM
      // marker-appearance concept, so it's left out here even though
      // waeLoadAppearance() itself carries it (see the v1.23.1 changelog
      // note up top).
      resolve: () => {
        const { markerSize, fillColor, fillOpacity, borderColor, borderWidth, borderOpacity } = waeLoadAppearance();
        return { markerType: 'generic', generic: { markerSize, fillColor, fillOpacity, borderColor, borderWidth, borderOpacity } };
      },
    });
    // register() itself throws if the same id is already registered --
    // same reasoning as registerStyle() above, and the same reason
    // unregister() is paired with it in stopPlugin(). defaultEnabled
    // reads the OLD standalone localStorage flag (see WAE_MAP_VISIBLE_KEY's
    // own comment) purely as a one-time starting value for whoever
    // upgrades into this version with it already set -- WFMM.layers'
    // OWN persisted value (from a previous run of THIS version) always
    // wins over this if one already exists, matching register()'s own
    // documented savedEnabled ?? defaultEnabled priority.
    wfmmWindow.WFMM.layers.register({
      id: WAE_LAYER_ID,
      pluginId: PLUGIN_ID,
      label: 'Abuse Report Crosses',
      defaultEnabled: localStorage.getItem(WAE_MAP_VISIBLE_KEY) === 'true',
      onChange: (enabled) => { waeApplyLayerEnabled(enabled); },
    });
    // Subscribes to the real WFMM.sidePanel.onReady()/onCleared() events
    // (see attachSettingsActions()'s own comment for why this replaced
    // the old whole-document MutationObserver) rather than a one-shot
    // call, so a side panel rebuilt later in the SPA session -- Angular
    // router navigation, same case the old code was patching around --
    // gets both settings-actions links re-added the same way they
    // appeared the first time. onReady() itself only fires for FUTURE
    // rebuilds (confirmed against every other plugin's own use of it,
    // e.g. Web Reports' attachSettingsAction() call site: each calls its
    // attach function once immediately, THEN subscribes for later) --
    // so the immediate call below covers the side panel already being
    // up right now, same as this plugin's own
    // waeStartSidePanelDetailsWatcher() does for its own subscription.
    attachSettingsActions();
    waeSidePanelReadyUnsub = wfmmWindow.WFMM.sidePanel.onReady(attachSettingsActions);
    waeSidePanelClearedUnsub = wfmmWindow.WFMM.sidePanel.onCleared(detachSettingsActions);
    // Subscribes to WFMM.map/WFMM.routes for this plugin's whole
    // lifetime (see waeStartMapTracking()'s own comment for why this
    // replaced the old setInterval-based stale watch) -- started here
    // rather than tied to the "Show on Map" toggle, since the
    // subscriptions themselves are cheap and their callbacks already
    // check isMapPulsesEnabled() before doing any real work.
    waeStartMapTracking();
    waeStartSidePanelDetailsWatcher();
    waeResyncMapIfVisible();
    // Review-page (/new/review) crosses -- see that section's own top
    // comment (right after waeStopMapTracking()) for why this is a
    // wholly separate subscription from waeStartMapTracking() above,
    // deliberately never touching WFMM.layers/attachSettingsActions().
    waeStartReviewTracking();
  }

  function stopPlugin() {
    waePluginActive = false;
    window.removeEventListener('message', waeHandleAbuseFormMessage);
    window.removeEventListener('message', waeHandleSightengineMessage);
    waeAbuseFormSessions.clear();
    waeSeChecks.clear();
    waeRemoveReviewAbuseRows();
    waeSidePanelReadyUnsub?.();
    waeSidePanelReadyUnsub = null;
    waeSidePanelClearedUnsub?.();
    waeSidePanelClearedUnsub = null;
    detachSettingsActions();
    waeMarkerSettingsController?.close();
    waeCloseNearbyPopover();
    closePanel(); // no-op if the panel isn't open; openModal's own close() tears its DOM down
    waeStopMapTracking();
    waeStopSidePanelDetailsWatcher();
    waeClearPulses();
    waeStopReviewTracking();
    waeUnregisterAppearance?.();
    waeUnregisterAppearance = null;
    wfmmWindow.WFMM.layers.unregister(WAE_LAYER_ID);
  }

  // ---------------------------------------------------------------------
  // External API -- lets the companion Abuse Email Importer script trigger
  // a real scan directly, for its own "scan after import" checkbox: a
  // successful Gmail sync/.eml import over there can call this to get the
  // freshly-imported emails scanned immediately, rather than leaving that
  // as a separate manual step in THIS script's own panel. Mirrors that
  // script's own wfmmWindow.WayfarerAbuseEmailImporter (this script reads
  // FROM that one; that one now calls INTO this one) -- same reasoning on
  // wfmmWindow vs window applies in reverse here: this script itself isn't
  // sandboxed (@grant none, @inject-into page runs it in the real page
  // context already), but the importer script IS (@grant
  // GM_xmlhttpRequest/unsafeWindow), so ITS copy of `window` is a separate
  // sandbox object -- it can only ever reach this through wfmmWindow, the
  // one object both scripts' own top-of-file comments already point at the
  // real, shared page window for exactly this reason.
  // scanImportedEmails here is intentionally waeScanAndPersist, not the
  // like-named lower-level function a few hundred lines up that only
  // parses emails into rows without saving them anywhere -- an external
  // caller has no other way to reach the save step, and "scan" from
  // outside this file should mean the same thing it does when this
  // script's own Scan button is clicked.
  // ---------------------------------------------------------------------
  wfmmWindow.WayfarerAbuseReportExtractor = {
    scanImportedEmails: (onProgress) => waeScanAndPersist(onProgress),
  };

  // ---------------------------------------------------------------------
  // Map Mods plugin manager registration -- see the importer script's own
  // copy of this comment for the full explanation. Same pattern here:
  // register as a real entry in the suite's Plugin Manager settings
  // screen (window.WFMM.plugins.registerExternal(), confirmed against its
  // v4.0.0 source), falling back to the old self-starting behavior if the
  // plugin manager never becomes available within 5s.
  // ---------------------------------------------------------------------

  const PLUGIN_ID = 'wayfarer-abuse-report-extractor';
  const PLUGIN_DEFINITION = {
    id: PLUGIN_ID,
    name: (typeof GM_info !== 'undefined' && GM_info.script?.name) || 'Wayfarer Map Mods - Abuse Reports',
    description: 'Scans imported abuse-report emails for reported Wayspot names/coordinates, flags nearby duplicates, and plots them on the map.',
    source: 'external',
    requirement: 'optional',
    author: (typeof GM_info !== 'undefined' && GM_info.script?.author) || 'unknown',
    version: (typeof GM_info !== 'undefined' && GM_info.script?.version) || '0.0.0',
    namespace: (typeof GM_info !== 'undefined' && GM_info.script?.namespace) || undefined,
    apiVersion: 1,
    create() {
      return { start: startPlugin, stop: stopPlugin };
    },
  };

  // wfmmWindow is declared once, near the top of this file (see that
  // comment for why) -- reused here unchanged from earlier versions.
  function registerOrSelfStart(attemptsLeft) {
    const plugins = wfmmWindow.WFMM && wfmmWindow.WFMM.plugins;
    if (plugins && typeof plugins.registerExternal === 'function') {
      try {
        plugins.registerExternal(PLUGIN_DEFINITION);
        return; // registered -- WFMM owns calling start()/stop() from here
      } catch (e) {
        console.warn('[Wayfarer Map Mods - Abuse Reports] Plugin Manager registration failed, self-starting instead:', e);
        startPlugin();
        return;
      }
    }
    if (attemptsLeft > 0) {
      setTimeout(() => registerOrSelfStart(attemptsLeft - 1), 250);
      return;
    }
    console.warn('[Wayfarer Map Mods - Abuse Reports] Map Mods plugin manager not detected after 5s -- self-starting instead.');
    startPlugin();
  }

  registerOrSelfStart(20); // 20 * 250ms = 5s
})();