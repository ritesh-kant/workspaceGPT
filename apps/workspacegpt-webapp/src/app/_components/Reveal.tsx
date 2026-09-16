"use client";

import { useEffect } from "react";

/**
 * Fades `[data-reveal]` elements in as they enter the viewport.
 *
 * Mounted once at the page root rather than wrapping each section, so adding a
 * reveal costs one attribute rather than another component boundary. Elements
 * are revealed once and unobserved — re-animating on scroll-back reads as a
 * gimmick, which is the opposite of the goal here.
 */
export function Reveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (!els.length) return;

    // Without IntersectionObserver, or with reduced motion, show everything.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof IntersectionObserver === "undefined") {
      els.forEach((el) => el.classList.add("is-visible"));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.05 }
    );

    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return null;
}
