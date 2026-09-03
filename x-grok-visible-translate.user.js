// ==UserScript==
// @name         X Grok 自動繁中翻譯（原生優先）
// @namespace    ben/x-grok-visible-translator
// @version      1.0.2
// @description  僅翻譯可視貼文；目標語言跟隨 X 介面語言，優先使用 X 原生翻譯。
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// @run-at       document-start
// @license      MIT
// @homepageURL  https://github.com/llpgf/x-grok-visible-translate
// @downloadURL  https://raw.githubusercontent.com/llpgf/x-grok-visible-translate/main/x-grok-visible-translate.user.js
// @updateURL    https://raw.githubusercontent.com/llpgf/x-grok-visible-translate/main/x-grok-visible-translate.user.js
// ==/UserScript==

(() => {
  'use strict';

  // The small queue is intentional: this is an undocumented X endpoint.
  const SETTINGS = { minChars: 10, maxConcurrent: 1, cacheTtlMs: 24 * 60 * 60 * 1000 };
  const API_URL = 'https://api.x.com/2/grok/translation.json';
  const FALLBACK_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const CACHE_KEY = 'x-grok-visible-translate-cache-v1';
  const nativeTranslation = /(?:show original|顯示原文|显示原文|translated by|已翻譯|已翻译)/i;
  const state = {
    headers: {}, queue: [], active: new Map(), jobs: new Map(), cache: new Map(), observed: new WeakSet(),
    versions: new WeakMap(), scanQueued: false, scanRoots: new Set(), cooldownUntil: 0,
  };

  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function targetLang() {
    const locale = (document.documentElement.lang || 'zh-TW').toLowerCase();
    if (locale === 'zh-hant' || locale.startsWith('zh-hant-')) return 'zh-TW';
    if (locale === 'zh-hans' || locale.startsWith('zh-hans-')) return 'zh-CN';
    return locale;
  }

  function loadCache() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(CACHE_KEY) || '{}');
      const now = Date.now();
      Object.entries(saved).forEach(([id, item]) => {
        if (item && item.at > now - SETTINGS.cacheTtlMs && typeof item.text === 'string') state.cache.set(id, item);
      });
    } catch { /* malformed cache is disposable */ }
  }

  function saveCache() {
    const entries = [...state.cache.entries()].slice(-250);
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries))); } catch { /* cache is optional */ }
  }

  function captureHeaders(headers) {
    if (!headers) return;
    const list = headers instanceof Headers ? [...headers.entries()] : Array.isArray(headers) ? headers : Object.entries(headers);
    for (const [rawName, rawValue] of list) {
      const name = String(rawName).toLowerCase();
      if (['authorization', 'x-csrf-token', 'x-client-transaction-id', 'x-twitter-active-user', 'x-twitter-auth-type'].includes(name) && rawValue) {
        state.headers[name] = String(rawValue);
      }
    }
  }

  // Observe normal X traffic only; do not alter it or log any credentials.
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (/api\.x\.com|twitter\.com\/i\/api/.test(url)) {
      captureHeaders(input instanceof Request ? input.headers : null);
      captureHeaders(init?.headers);
    }
    return originalFetch.apply(this, arguments);
  };

  const open = XMLHttpRequest.prototype.open;
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xTranslateUrl = String(url); this.__xTranslateHeaders = {}; return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    this.__xTranslateHeaders[String(name).toLowerCase()] = String(value); return setHeader.apply(this, arguments);
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (/api\.x\.com|twitter\.com\/i\/api/.test(this.__xTranslateUrl || '')) captureHeaders(this.__xTranslateHeaders);
    return send.apply(this, arguments);
  };

  function tweetIdFor(textNode) {
    if (textNode.dataset.xGrokTweetId) return textNode.dataset.xGrokTweetId;
    const article = textNode.closest('article');
    const match = article?.querySelector('time')?.closest('a[href*="/status/"]')?.getAttribute('href')?.match(/\/status\/(\d+)/)
      || article?.querySelector('a[href*="/status/"]')?.getAttribute('href')?.match(/\/status\/(\d+)/);
    if (match) return (textNode.dataset.xGrokTweetId = match[1]);
    // Last-resort compatibility path; X changes this private React shape often.
    for (let node = textNode, depth = 0; node && depth++ < 8; node = node.parentElement) {
      const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'));
      let fiber = key && node[key];
      for (let hops = 0; fiber && hops++ < 12; fiber = fiber.return) {
        const tweet = fiber.memoizedProps?.tweet;
        const id = tweet?.rest_id || tweet?.id_str;
        if (id) return (textNode.dataset.xGrokTweetId = id);
      }
    }
    return null;
  }

  function meaningfulText(text) {
    return text.replace(/https?:\/\/\S+|@\w+|[#\s_\p{Extended_Pictographic}]/gu, '').trim();
  }

  function hasNativeTranslation(article) {
    return [...(article?.querySelectorAll('button, [role="button"], span') || [])].some((node) => nativeTranslation.test(node.textContent || ''));
  }

  function shouldTranslate(node) {
    const article = node.closest('article');
    const text = meaningfulText(node.textContent || '');
    if (!article || node.dataset.xGrokState || hasNativeTranslation(article) || text.length < SETTINGS.minChars) return false;
    const targetBase = targetLang().split('-')[0];
    const language = (node.lang || '').toLowerCase();
    if (language === targetBase || language.startsWith(`${targetBase}-`)) return false;
    // X sometimes omits lang; skip clearly Chinese text without guessing Japanese/Korean as Chinese.
    const han = (text.match(/\p{Script=Han}/gu) || []).length;
    return !(targetBase === 'zh' && han / Math.max(text.length, 1) > 0.7);
  }

  function parseTranslation(raw) {
    let text = '';
    for (const line of raw.trim().split('\n')) {
      try {
        const json = JSON.parse(line);
        text += json.result?.text || json.translated_text || json.text || '';
      } catch { /* streaming framing can contain non-JSON lines */ }
    }
    return text.trim() || null;
  }

  function csrfCookie() {
    return document.cookie.match(/(?:^|; )ct0=([^;]*)/)?.[1] || '';
  }

  async function translate(id, signal) {
    const cacheId = `${targetLang()}:${id}`;
    const cached = state.cache.get(cacheId);
    if (cached && cached.at > Date.now() - SETTINGS.cacheTtlMs) return cached.text;
    const headers = {
      authorization: state.headers.authorization || `Bearer ${decodeURIComponent(FALLBACK_BEARER)}`,
      'content-type': 'text/plain;charset=UTF-8', 'x-csrf-token': state.headers['x-csrf-token'] || csrfCookie(),
      'x-twitter-active-user': 'yes', 'x-twitter-client-language': targetLang(),
      ...state.headers,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(API_URL, { method: 'POST', credentials: 'include', headers, signal,
        body: JSON.stringify({ content_type: 'POST', id, dst_lang: targetLang() }) });
      const raw = await response.text();
      if (response.ok) {
        const text = parseTranslation(raw);
        if (text) { state.cache.set(cacheId, { text, at: Date.now() }); saveCache(); return text; }
      }
      if (response.status === 429) state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + 5_000 + Math.floor(Math.random() * 2_000));
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) throw new Error(`X translation HTTP ${response.status}`);
      await sleep((600 * 2 ** attempt) + Math.floor(Math.random() * 350));
    }
  }

  function wrapperFor(node) { return node.parentElement?.querySelector(':scope > .x-grok-translation'); }

  function showLoading(node) {
    let box;
    const timer = setTimeout(() => {
      if (node.dataset.xGrokState !== 'pending') return;
      box = document.createElement('small'); box.className = 'x-grok-translation'; box.textContent = '翻譯中…';
      node.insertAdjacentElement('afterend', box);
    }, 150);
    return () => { clearTimeout(timer); box?.remove(); };
  }

  function render(node, translated) {
    // Deliberately replace the original in the existing X text node: no second translation block.
    if (!state.versions.has(node)) state.versions.set(node, { original: node.textContent || '', originalLang: node.lang, translated, showingOriginal: false });
    wrapperFor(node)?.remove();
    node.replaceChildren(document.createTextNode(translated));
    node.lang = targetLang();
    addPostToggle(node);
  }

  function pump() {
    if (state.cooldownUntil > Date.now()) { setTimeout(pump, state.cooldownUntil - Date.now()); return; }
    while (state.active.size < SETTINGS.maxConcurrent && state.queue.length) {
      const job = state.queue.shift();
      if (job.cancelled || !job.nodes.size) { state.jobs.delete(job.id); continue; }
      job.started = true; state.active.set(job.id, job);
      translate(job.id, job.controller.signal).then((text) => {
        if (!job.cancelled) for (const node of job.nodes) if (node.isConnected) { render(node, text); node.dataset.xGrokState = 'done'; }
      }).catch((error) => {
        if (!job.cancelled && error.name !== 'AbortError') for (const node of job.nodes) if (node.isConnected) node.dataset.xGrokState = 'error';
      }).finally(() => {
        for (const stop of job.stopLoading.values()) stop();
        state.active.delete(job.id); state.jobs.delete(job.id); pump();
      });
    }
  }

  function enqueue(node) {
    if (!shouldTranslate(node)) { node.dataset.xGrokState = 'skip'; return; }
    const id = tweetIdFor(node);
    if (!id) { node.dataset.xGrokState = 'skip'; return; }
    node.dataset.xGrokState = 'pending';
    let job = state.jobs.get(id);
    if (job) {
      job.nodes.add(node); job.stopLoading.set(node, showLoading(node)); return;
    }
    job = { id, nodes: new Set([node]), controller: new AbortController(), cancelled: false, started: false, stopLoading: new Map([[node, showLoading(node)]]) };
    state.jobs.set(id, job); state.queue.push(job); pump();
  }

  function nativeTranslateButton(article) {
    return [...article.querySelectorAll('button[aria-label], [role="button"][aria-label]')].find((button) =>
      /^(?:顯示翻譯|显示翻译|Show translation|Translate post)$/i.test(button.getAttribute('aria-label') || ''));
  }

  function addPostToggle(node) {
    if (nativeTranslateButton(node.closest('article')) || node.parentElement?.querySelector(':scope > [data-x-grok-toggle]')) return;
    const slot = document.createElement('div');
    slot.dataset.xGrokToggle = '';
    const button = document.createElement('button');
    button.type = 'button'; button.setAttribute('aria-label', '顯示原文'); button.textContent = '顯示原文';
    Object.assign(button.style, { border: '0', padding: '0', background: 'transparent', color: 'rgb(29, 155, 240)', cursor: 'pointer', font: 'inherit' });
    button.onclick = () => {
      const version = state.versions.get(node);
      if (!version) return;
      version.showingOriginal = !version.showingOriginal;
      node.replaceChildren(document.createTextNode(version.showingOriginal ? version.original : version.translated));
      node.lang = version.showingOriginal ? version.originalLang : targetLang();
      const label = version.showingOriginal ? '顯示翻譯' : '顯示原文';
      button.textContent = label; button.setAttribute('aria-label', label);
    };
    slot.append(button); node.parentElement?.insertBefore(slot, node);
  }

  function forceNativeThenFallback(node) {
    if (!shouldTranslate(node)) { node.dataset.xGrokState = 'skip'; return; }
    const button = nativeTranslateButton(node.closest('article'));
    if (!button) return enqueue(node);
    node.dataset.xGrokState = 'native';
    button.click(); // When X supplies its own control, leave that control and its result entirely to X.
  }

  function cancel(node) {
    const id = node.dataset.xGrokTweetId;
    const job = id && state.jobs.get(id);
    if (!job) return;
    job.stopLoading.get(node)?.(); job.stopLoading.delete(node); job.nodes.delete(node);
    delete node.dataset.xGrokState;
    wrapperFor(node)?.remove();
    if (!job.nodes.size) {
      job.cancelled = true;
      if (job.started) job.controller.abort();
    }
  }

  const visible = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) forceNativeThenFallback(entry.target); else cancel(entry.target);
  }), { rootMargin: '120px 0px' });

  function observe(node) {
    if (state.observed.has(node)) return;
    state.observed.add(node); visible.observe(node);
  }

  function scan(root) {
    if (root instanceof Element && root.matches?.('[data-testid="tweetText"]')) observe(root);
    root.querySelectorAll?.('[data-testid="tweetText"]').forEach(observe);
  }

  function queueScan(root) {
    state.scanRoots.add(root);
    if (state.scanQueued) return;
    state.scanQueued = true;
    idle(() => {
      state.scanQueued = false;
      for (const pendingRoot of state.scanRoots) scan(pendingRoot);
      state.scanRoots.clear();
    });
  }

  function start() {
    loadCache(); scan(document);
    const main = document.querySelector('main') || document.body;
    new MutationObserver((mutations) => mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) queueScan(node);
    }))).observe(main, { childList: true, subtree: true });
  }

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start, { once: true }) : start();
})();

