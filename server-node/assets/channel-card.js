/* ==========================================================================
   Relay Controller — shared channel editor card
   Used by the dashboard (/) and the profile editor (/profiles) so both edit a
   channel the same way. The card mutates the `ch` object it is given
   ({ enabled, pulse_ms, schedule[], skip_dates[], label }) and asks the host
   page to re-render / mark dirty through the `ctx` callbacks.

   ctx = {
     index: number,              // position, for the entrance-animation stagger
     animate: boolean,           // play the entrance animation
     headingLevel: 2 | 3,        // semantic level of the channel name
     toolsOpen: Set<string>,     // keys whose "Bulk add & import" is expanded
     canRing: boolean,           // show the "Ring now" footer
     ring(btn, key, ch),         // called after the two-step confirmation
     rerender({ key, sel }?),    // rebuild all cards (optionally refocus an element)
     changed(what?),             // a non-structural edit happened ("label" | "pulse")
     toast(message, isError?),
   }
   ========================================================================== */
(function (global) {
  'use strict';

  const MAX_SLOTS = 24;   // per channel — matches server validation + firmware capacity
  const MAX_SKIP = 32;
  const MIN_PULSE = 100;
  const MAX_PULSE = 60000;

  const BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const entryTime = (e) => (typeof e === 'string' ? e : (e && e.time) || '');
  const entryPulse = (e) => (e && typeof e === 'object' && e.pulse_ms) || 0;
  const sortSlots = (list) => list.sort((a, b) => entryTime(a).localeCompare(entryTime(b)));
  const makeEntry = (time, pulse) => (pulse >= MIN_PULSE ? { time, pulse_ms: Math.min(pulse, MAX_PULSE) } : time);

  /** "8:5" is rejected, "8:05" -> "08:05". Returns null when invalid. */
  function normTime(v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  }

  /** Make sure every channel has its list fields (older data may omit them). */
  function normalize(channels) {
    for (const ch of Object.values(channels || {})) {
      if (!Array.isArray(ch.schedule)) ch.schedule = [];
      if (!Array.isArray(ch.skip_dates)) ch.skip_dates = [];
    }
    return channels;
  }

  function chipHtml(entry, editable) {
    const time = entryTime(entry);
    const pulse = entryPulse(entry);
    const t = escapeHtml(time);
    return `<span class="tag" data-list="schedule" data-val="${t}">`
      + (editable
        ? `<button type="button" class="tag-edit" data-edit aria-label="Edit ${t}${pulse ? `, custom pulse ${pulse} milliseconds` : ''}">${t}${pulse ? `<span class="p" title="Custom pulse">${pulse}ms</span>` : ''}</button>`
          + `<button type="button" class="tag-x" data-remove="schedule" data-val="${t}" aria-label="Remove ${t}">&times;</button>`
        : `${t}${pulse ? `<span class="p">${pulse}ms</span>` : ''}`)
      + '</span>';
  }

  function skipChipHtml(date, editable) {
    const d = escapeHtml(date);
    return `<span class="tag" data-list="skip_dates">${d}`
      + (editable ? `<button type="button" class="tag-x" data-remove="skip_dates" data-val="${d}" aria-label="Remove ${d}">&times;</button>` : '')
      + '</span>';
  }

  function build(key, ch, ctx) {
    normalize({ [key]: ch });
    const on = !!ch.enabled;
    const label = ch.label || key.toUpperCase();
    const slots = ch.schedule;
    const level = ctx.headingLevel === 3 ? 3 : 2;
    const el = document.createElement('article');
    el.className = 'channel' + (on ? '' : ' disabled') + (ctx.animate ? ' enter' : '');
    el.style.setProperty('--i', ctx.index || 0);
    el.dataset.key = key;
    el.innerHTML = `
      <div class="ch-header">
        <div class="ch-title">
          <h${level} contenteditable="${on}" spellcheck="false" data-field="label"${on ? ' title="Click to rename"' : ''}>${escapeHtml(label)}</h${level}>
          <span class="ch-key-tag">${escapeHtml(key)}</span>
        </div>
        <button type="button" class="toggle${on ? ' active' : ''}" role="switch" aria-checked="${on}" aria-label="${escapeHtml(label)} schedule" data-action="toggle" title="${on ? 'Turn this schedule off' : 'Turn this schedule on'}"></button>
      </div>
      <div class="ch-body">
        ${on ? `
        <div class="field">
          <label for="pulse-${escapeHtml(key)}">Default pulse (ms)</label>
          <input type="number" id="pulse-${escapeHtml(key)}" value="${Number(ch.pulse_ms) || 2000}" min="${MIN_PULSE}" max="${MAX_PULSE}" step="100" data-field="pulse_ms">
          <div class="hint">How long the relay stays closed for each bell. A single time can override this.</div>
        </div>` : ''}
        <div class="field">
          <div class="field-head"><span class="label">Bell times</span><span class="count${slots.length >= MAX_SLOTS ? ' full' : ''}">${slots.length} / ${MAX_SLOTS}</span></div>
          <div class="tag-list" data-list="schedule" data-empty="${on ? 'No bell times yet — add one below' : 'No bell times'}">${slots.map((s) => chipHtml(s, on)).join('')}</div>
          ${on ? `
          <div class="add-row">
            <input type="time" data-input="schedule" aria-label="Time to add">
            <input type="number" class="narrow" data-input="schedule_pulse" placeholder="ms" min="${MIN_PULSE}" max="${MAX_PULSE}" step="100" aria-label="Optional pulse for this bell, in milliseconds" title="Optional pulse for this bell (blank = default)">
            <button type="button" class="btn btn-add" data-add="schedule">Add</button>
          </div>
          <details class="more-tools"${ctx.toolsOpen && ctx.toolsOpen.has(key) ? ' open' : ''}>
            <summary>Bulk add &amp; import</summary>
            <div class="more-body">
              <div class="seg" role="tablist" aria-label="Bulk add method">
                <button type="button" role="tab" aria-selected="true" data-tab="paste">Paste a list</button>
                <button type="button" role="tab" aria-selected="false" data-tab="range">Every N minutes</button>
              </div>
              <div data-panel="paste">
                <textarea rows="4" data-input="bulk_paste" aria-label="Bell times, one per line" placeholder="One per line: H:MM [pulse_ms]&#10;8:00&#10;9:00 5000&#10;10:30"></textarea>
                <button type="button" class="btn btn-add btn-block" data-action="bulk-add">Add all</button>
              </div>
              <div data-panel="range" hidden>
                <div class="range-row">
                  <input type="time" data-input="range_from" aria-label="From time">
                  <span>to</span>
                  <input type="time" data-input="range_to" aria-label="To time">
                  <span>every</span>
                  <input type="number" data-input="range_step" min="1" max="1440" placeholder="min" aria-label="Interval in minutes">
                  <input type="number" data-input="range_pulse" min="${MIN_PULSE}" max="${MAX_PULSE}" step="100" placeholder="ms" aria-label="Optional pulse in milliseconds">
                </div>
                <button type="button" class="btn btn-add btn-block" data-action="range-gen">Generate</button>
              </div>
              <div class="import-row">
                <input type="file" class="hidden" data-input="timetable-file" accept=".txt,text/plain">
                <button type="button" class="btn btn-ghost btn-sm" data-action="import-timetable">Import timetable .txt</button>
                <span class="hint">Lines: <code>HH:MM pulse_ms name</code></span>
              </div>
            </div>
          </details>` : ''}
        </div>
        <div class="field">
          <div class="field-head"><span class="label">Skip dates</span><span class="count">${ch.skip_dates.length} / ${MAX_SKIP}</span></div>
          <div class="tag-list" data-list="skip_dates" data-empty="No skipped dates">${ch.skip_dates.map((d) => skipChipHtml(d, on)).join('')}</div>
          ${on ? `
          <div class="add-row">
            <input type="date" data-input="skip_dates" aria-label="Date to skip">
            <button type="button" class="btn btn-add" data-add="skip_dates">Add</button>
          </div>
          <div class="hint">No bells ring on these dates (holidays, exam days).</div>` : ''}
        </div>
      </div>
      ${on && ctx.canRing ? `<div class="ch-foot"><button type="button" class="btn btn-run" data-action="ring">${BELL} Ring now</button></div>` : ''}
    `;
    wire(el, key, ch, ctx);
    return el;
  }

  function wire(el, key, ch, ctx) {
    const $ = (s, root = el) => root.querySelector(s);
    const $$ = (s, root = el) => [...root.querySelectorAll(s)];
    const toast = ctx.toast || (() => {});

    const addSlots = (entries) => {
      let added = 0;
      let full = false;
      for (const e of entries) {
        if (ch.schedule.some((v) => entryTime(v) === e.time)) continue;
        if (ch.schedule.length >= MAX_SLOTS) { full = true; break; }
        ch.schedule.push(makeEntry(e.time, e.pulse_ms));
        added++;
      }
      sortSlots(ch.schedule);
      return { added, full };
    };

    const reportAdded = ({ added, full }, total) => {
      toast(`Added ${added} of ${total} times${full ? ` — a channel supports at most ${MAX_SLOTS}` : ''}`, full);
    };

    const addOne = () => {
      const time = normTime($('[data-input="schedule"]').value);
      const pulse = parseInt($('[data-input="schedule_pulse"]').value, 10) || 0;
      if (!time) { toast('Pick a time first', true); return; }
      if (pulse && (pulse < MIN_PULSE || pulse > MAX_PULSE)) { toast(`Pulse must be ${MIN_PULSE}–${MAX_PULSE} ms`, true); return; }
      if (ch.schedule.length >= MAX_SLOTS) { toast(`A channel supports at most ${MAX_SLOTS} bell times`, true); return; }
      if (ch.schedule.some((v) => entryTime(v) === time)) { toast(`${time} is already scheduled`, true); return; }
      ch.schedule.push(makeEntry(time, pulse));
      sortSlots(ch.schedule);
      ctx.rerender({ key, sel: '[data-input="schedule"]' });
    };

    const addSkip = () => {
      const v = $('[data-input="skip_dates"]').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { toast('Pick a date first', true); return; }
      if (ch.skip_dates.includes(v)) { toast(`${v} is already skipped`, true); return; }
      if (ch.skip_dates.length >= MAX_SKIP) { toast(`At most ${MAX_SKIP} skip dates per channel`, true); return; }
      ch.skip_dates.push(v);
      ch.skip_dates.sort().reverse();
      ctx.rerender({ key, sel: '[data-input="skip_dates"]' });
    };

    const startEdit = (tag) => {
      const idx = ch.schedule.findIndex((v) => entryTime(v) === tag.dataset.val);
      if (idx === -1) return;
      const entry = ch.schedule[idx];
      tag.classList.add('editing');
      tag.innerHTML = `
        <input type="time" class="edit-time" value="${escapeHtml(entryTime(entry))}" aria-label="Time">
        <input type="number" class="edit-pulse" value="${entryPulse(entry) || ''}" placeholder="ms" min="${MIN_PULSE}" max="${MAX_PULSE}" step="100" aria-label="Custom pulse in milliseconds (optional)">
        <span class="editor-actions"><button type="button" class="edit-save">Save</button><button type="button" class="edit-cancel">Cancel</button></span>`;
      const timeInp = $('.edit-time', tag);
      const pulseInp = $('.edit-pulse', tag);
      const save = () => {
        const newTime = normTime(timeInp.value);
        const newPulse = parseInt(pulseInp.value, 10) || 0;
        if (!newTime) { toast('Pick a valid time', true); return; }
        if (newPulse && (newPulse < MIN_PULSE || newPulse > MAX_PULSE)) { toast(`Pulse must be ${MIN_PULSE}–${MAX_PULSE} ms`, true); return; }
        if (ch.schedule.some((v, i) => i !== idx && entryTime(v) === newTime)) { toast(`${newTime} is already scheduled`, true); return; }
        ch.schedule[idx] = makeEntry(newTime, newPulse);
        sortSlots(ch.schedule);
        ctx.rerender();
      };
      $('.edit-save', tag).onclick = save;
      $('.edit-cancel', tag).onclick = () => ctx.rerender();
      tag.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        else if (e.key === 'Escape') { e.preventDefault(); ctx.rerender(); }
      });
      timeInp.focus();
    };

    const parseTimetable = (text) => {
      const entries = [];
      const seen = new Set();
      const lines = text.replace(/^﻿/, '').split(/\r?\n/);
      for (const [index, raw] of lines.entries()) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^(\d{1,2}:\d{2})(?:\s+(\d+))?(?:\s+.*)?$/.exec(line);
        const time = m && normTime(m[1]);
        if (!time) return { error: `Line ${index + 1}: expected "HH:MM pulse_ms name"` };
        const pulse = m[2] ? Number(m[2]) : 0;
        if (pulse && (pulse < MIN_PULSE || pulse > MAX_PULSE)) return { error: `Line ${index + 1}: pulse must be ${MIN_PULSE}–${MAX_PULSE} ms` };
        if (seen.has(time)) return { error: `Line ${index + 1}: duplicate ${time}` };
        seen.add(time);
        entries.push({ time, pulse_ms: pulse });
      }
      if (!entries.length) return { error: 'No timetable entries found' };
      if (entries.length > MAX_SLOTS) return { error: `A channel supports at most ${MAX_SLOTS} entries` };
      return { entries };
    };

    const importTimetable = async (input) => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const parsed = parseTimetable(await file.text());
        if (parsed.error) throw new Error(parsed.error);
        if (ch.schedule.length && !confirm(`Replace the ${ch.schedule.length} existing bell times with ${parsed.entries.length} from this file?`)) return;
        ch.schedule = sortSlots(parsed.entries.map((x) => makeEntry(x.time, x.pulse_ms)));
        if (ctx.toolsOpen) ctx.toolsOpen.add(key);
        ctx.rerender();
        toast(`Imported ${parsed.entries.length} bell times — save to apply`);
      } catch (err) {
        toast('Timetable import failed: ' + err.message, true);
      } finally {
        input.value = '';
      }
    };

    const actions = {
      toggle() {
        ch.enabled = !ch.enabled;
        ctx.rerender({ key, sel: '[data-action="toggle"]' });
      },
      'bulk-add'() {
        const entries = [];
        for (const raw of $('[data-input="bulk_paste"]').value.split(/\r?\n/)) {
          const line = raw.trim();
          if (!line || line.startsWith('#')) continue;
          const parts = line.split(/\s+/);
          const time = normTime(parts[0]);
          if (!time) continue;
          const pulse = parseInt(parts[1], 10) || 0;
          entries.push({ time, pulse_ms: pulse >= MIN_PULSE && pulse <= MAX_PULSE ? pulse : 0 });
        }
        if (!entries.length) { toast('No valid times found (use H:MM, one per line)', true); return; }
        const result = addSlots(entries);
        if (ctx.toolsOpen) ctx.toolsOpen.add(key);
        ctx.rerender();
        reportAdded(result, entries.length);
      },
      'range-gen'() {
        const from = $('[data-input="range_from"]').value;
        const to = $('[data-input="range_to"]').value;
        const step = parseInt($('[data-input="range_step"]').value, 10) || 0;
        const pulse = parseInt($('[data-input="range_pulse"]').value, 10) || 0;
        if (!from || !to) { toast('Set both From and To times', true); return; }
        if (step < 1 || step > 1440) { toast('Interval must be 1–1440 minutes', true); return; }
        const [fh, fm] = from.split(':').map(Number);
        const [th, tm] = to.split(':').map(Number);
        const fromMin = fh * 60 + fm;
        const toMin = th * 60 + tm;
        if (fromMin >= toMin) { toast('“From” must be earlier than “To”', true); return; }
        const entries = [];
        for (let m = fromMin; m <= toMin; m += step) {
          entries.push({ time: String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'), pulse_ms: pulse >= MIN_PULSE && pulse <= MAX_PULSE ? pulse : 0 });
        }
        const result = addSlots(entries);
        if (ctx.toolsOpen) ctx.toolsOpen.add(key);
        ctx.rerender();
        reportAdded(result, entries.length);
      },
      'import-timetable'() {
        $('[data-input="timetable-file"]').click();
      },
      ring(btn) {
        const idle = `${BELL} Ring now`;
        if (btn.classList.contains('armed')) {
          clearTimeout(btn._t);
          btn.classList.remove('armed');
          btn.innerHTML = idle;
          if (ctx.ring) ctx.ring(btn, key, ch);
          return;
        }
        // Two-step: a stray click must never ring the whole school.
        btn.classList.add('armed');
        btn.innerHTML = `${BELL} Press again to ring`;
        btn._t = setTimeout(() => { btn.classList.remove('armed'); btn.innerHTML = idle; }, 3500);
      },
    };

    el.addEventListener('click', (e) => {
      const t = e.target.closest('button, summary');
      if (!t || !el.contains(t)) return;
      if (t.dataset.action && actions[t.dataset.action]) { actions[t.dataset.action](t); return; }
      if (t.dataset.add === 'schedule') { addOne(); return; }
      if (t.dataset.add === 'skip_dates') { addSkip(); return; }
      if (t.dataset.remove) {
        const list = t.dataset.remove;
        ch[list] = ch[list].filter((v) => (list === 'schedule' ? entryTime(v) : v) !== t.dataset.val);
        ctx.rerender();
        return;
      }
      if (t.dataset.edit !== undefined) { startEdit(t.closest('.tag')); return; }
      if (t.dataset.tab) {
        $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b === t)));
        $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
      }
    });

    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.target.matches('[data-input="schedule"], [data-input="schedule_pulse"]')) { e.preventDefault(); addOne(); }
      else if (e.target.matches('[data-input="skip_dates"]')) { e.preventDefault(); addSkip(); }
    });

    el.addEventListener('change', (e) => {
      if (e.target.matches('[data-field="pulse_ms"]')) {
        const v = Math.min(MAX_PULSE, Math.max(MIN_PULSE, parseInt(e.target.value, 10) || 2000));
        ch.pulse_ms = v;
        e.target.value = v;
        if (ctx.changed) ctx.changed('pulse');
      } else if (e.target.matches('[data-input="timetable-file"]')) {
        importTimetable(e.target);
      }
    });

    const labelEl = $('[data-field="label"]');
    labelEl.addEventListener('focusout', () => {
      ch.label = labelEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) || key.toUpperCase();
      labelEl.textContent = ch.label;
      if (ctx.changed) ctx.changed('label');
    });
    labelEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); labelEl.blur(); }
      else if (e.key === 'Escape') { labelEl.textContent = ch.label || key.toUpperCase(); labelEl.blur(); }
    });
    labelEl.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\s+/g, ' ');
      document.execCommand('insertText', false, text);
    });

    const details = $('details.more-tools');
    if (details && ctx.toolsOpen) {
      details.addEventListener('toggle', () => { if (details.open) ctx.toolsOpen.add(key); else ctx.toolsOpen.delete(key); });
    }
  }

  global.BellChannelCard = {
    build,
    normalize,
    limits: { MAX_SLOTS, MAX_SKIP, MIN_PULSE, MAX_PULSE },
    helpers: { entryTime, entryPulse, normTime, escapeHtml },
  };
})(window);
