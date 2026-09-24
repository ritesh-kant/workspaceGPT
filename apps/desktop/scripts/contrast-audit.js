// Contrast audit for the desktop shell and its framed views — a dev check,
// run inside a page by scripts/webkit-probe.swift:
//
//   swift scripts/webkit-probe.swift <url> --eval "$(cat scripts/contrast-audit.js)"
//
// For every visible element with its own text it composites the text colour
// (times every ancestor's opacity) over the element's effective background
// (ancestor backgrounds composited upward to the page) and reports anything
// under WCAG's 3:1 — text that is hard to read or invisible. It walks the
// shell and every same-origin iframe. The value of the last expression is
// what the probe prints.
(() => {
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (top, under) => {
    const a = top.a + under.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (k) => (top[k] * top.a + under[k] * under.a * (1 - top.a)) / a;
    return { r: mix('r'), g: mix('g'), b: mix('b'), a };
  };
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  function audit(doc, where, pageBg) {
    const win = doc.defaultView;
    const out = [];
    const bgOf = (el) => {
      const layers = [];
      for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
        const cs = win.getComputedStyle(e);
        if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/gradient/.test(cs.backgroundImage)) return null;
        const c = parse(cs.backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a >= 1) break;
        }
      }
      let bg = pageBg;
      for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
      return bg;
    };
    const opacityOf = (el) => {
      let o = 1;
      for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(win.getComputedStyle(e).opacity);
      return o;
    };
    for (const el of doc.querySelectorAll('body *')) {
      if (['SCRIPT', 'STYLE', 'SVG', 'PATH', 'IFRAME'].includes(el.tagName.toUpperCase())) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
      if (!own) continue;
      const r = el.getBoundingClientRect();
      // Scrolled-out content counts too: a long conversation is audited whole.
      if (r.width < 1 || r.height < 1) continue;
      const cs = win.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      // Gradient-clipped text (background-clip: text) can't be judged by colour.
      if (cs.webkitTextFillColor && parse(cs.webkitTextFillColor)?.a === 0) continue;
      const fg0 = parse(cs.webkitTextFillColor || cs.color) || parse(cs.color);
      const bg = bgOf(el);
      if (!fg0 || !bg) continue;
      const op = opacityOf(el);
      if (op < 0.05) continue;
      const fg = over({ ...fg0, a: fg0.a * op }, bg);
      const cr = ratio(fg, bg);
      if (cr < 3) {
        out.push({ where, ratio: +cr.toFixed(2), text: own.slice(0, 50), el: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`, fg: hex(fg), bg: hex(bg) });
      }
    }
    for (const f of doc.querySelectorAll('iframe')) {
      try {
        const d = f.contentDocument;
        if (d) out.push(...audit(d, (f.title || f.src).slice(0, 30), bgOf(f) || pageBg));
      } catch {
        /* cross-origin: skip */
      }
    }
    return out;
  }
  const findings = audit(document, 'shell', { r: 255, g: 255, b: 255, a: 1 });
  const seen = new Set();
  return findings.filter((f) => {
    const k = `${f.where}|${f.el}|${f.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
})()
