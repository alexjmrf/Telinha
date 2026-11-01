"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Zoom local numa stream (só pra quem está vendo; não muda nada pra quem transmite).
// - Rodinha do mouse: aproxima/afasta em direção ao ponteiro.
// - Arrastar (com zoom): move a imagem.
// - Celular: pinça com dois dedos; arrasta com um dedo quando tem zoom.
const MAX = 4;

export function useZoom(boxRef, enabled) {
  const [z, setZ] = useState({ s: 1, x: 0, y: 0 });
  const zr = useRef(z);
  zr.current = z;
  const dragged = useRef(false); // o último "clique" foi na verdade um arrasto

  const reset = useCallback(() => setZ({ s: 1, x: 0, y: 0 }), []);

  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  useEffect(() => {
    const box = boxRef.current;
    if (!enabled || !box) return;

    // a imagem sempre cobre o quadro inteiro (não deixa arrastar pra fora)
    const clamp = (s, x, y) => {
      const w = box.clientWidth;
      const h = box.clientHeight;
      return { s, x: Math.min(0, Math.max(w - w * s, x)), y: Math.min(0, Math.max(h - h * s, y)) };
    };
    // muda o zoom mantendo parado o ponto (px, py) do quadro
    const zoomAt = (target, px, py) => {
      const { s, x, y } = zr.current;
      const s2 = Math.min(MAX, Math.max(1, target));
      if (s2 === s) return;
      const k = s2 / s;
      setZ(s2 === 1 ? { s: 1, x: 0, y: 0 } : clamp(s2, px - (px - x) * k, py - (py - y) * k));
    };
    const local = (cx, cy) => {
      const r = box.getBoundingClientRect();
      return [cx - r.left, cy - r.top];
    };
    const onControls = (t) => t instanceof Element && !!t.closest(".controls, button, input, .tile-msg");

    function onWheel(e) {
      if (onControls(e.target)) return;
      // sem zoom e girando pra afastar: deixa a página rolar normalmente
      if (zr.current.s === 1 && e.deltaY > 0) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const [px, py] = local(e.clientX, e.clientY);
      zoomAt(zr.current.s * Math.pow(1.0015, -dy), px, py);
    }

    const pts = new Map(); // dedos/mouse apertados
    let pan = null; // { cx, cy, x, y }
    let pinch = null; // { d } distância anterior entre os dedos

    function onDown(e) {
      if (onControls(e.target) || (e.pointerType === "mouse" && e.button !== 0)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragged.current = false;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
        pan = null;
      } else if (pts.size === 1 && zr.current.s > 1) {
        pan = { cx: e.clientX, cy: e.clientY, x: zr.current.x, y: zr.current.y };
      }
    }

    function onMove(e) {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const [px, py] = local((a.x + b.x) / 2, (a.y + b.y) / 2);
        if (pinch.d > 0) zoomAt(zr.current.s * (d / pinch.d), px, py);
        pinch.d = d;
        dragged.current = true;
        return;
      }
      if (!pan) return;
      const dx = e.clientX - pan.cx;
      const dy = e.clientY - pan.cy;
      if (!dragged.current && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (!dragged.current) {
        dragged.current = true;
        try {
          box.setPointerCapture(e.pointerId);
        } catch {}
      }
      setZ(clamp(zr.current.s, pan.x + dx, pan.y + dy));
    }

    function onUp(e) {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) pan = null;
      else if (pts.size === 1 && zr.current.s > 1) {
        // sobrou um dedo depois da pinça: continua arrastando com ele
        const [p] = [...pts.values()];
        pan = { cx: p.x, cy: p.y, x: zr.current.x, y: zr.current.y };
      }
    }

    // o quadro mudou de tamanho (janela, tela cheia): reajusta os limites
    const ro = new ResizeObserver(() => {
      const { s, x, y } = zr.current;
      if (s > 1) setZ(clamp(s, x, y));
    });
    ro.observe(box);

    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("pointerdown", onDown);
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerup", onUp);
    box.addEventListener("pointercancel", onUp);
    return () => {
      ro.disconnect();
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("pointerdown", onDown);
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerup", onUp);
      box.removeEventListener("pointercancel", onUp);
    };
  }, [enabled, boxRef]);

  return {
    scale: z.s,
    zoomed: z.s > 1,
    reset,
    // true se o clique que acabou de acontecer era o fim de um arrasto (e não deve contar)
    wasDrag() {
      const d = dragged.current;
      dragged.current = false;
      return d;
    },
    videoStyle: enabled && z.s > 1 ? { transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})`, transformOrigin: "0 0" } : undefined,
    // celular: sem zoom, um dedo rola a página; com zoom, o dedo arrasta a imagem
    boxStyle: enabled ? { touchAction: z.s > 1 ? "none" : "pan-x pan-y" } : undefined,
  };
}
