"use client";

import { useEffect, useState } from "react";

// Diz se o vídeo de um stream está chegando totalmente preto.
// Amostra uma miniatura (32×18) a cada 2 s; "preto" = nenhum pixel com
// brilho acima de um limiar baixo, por 3 amostras seguidas (6 s). Cenas
// escuras de verdade quase sempre têm algum ponto claro (HUD, legenda),
// então não disparam.
const W = 32;
const H = 18;

export function useBlackFrames(stream) {
  const [black, setBlack] = useState(false);

  useEffect(() => {
    setBlack(false);
    if (!stream || !stream.getVideoTracks().length) return;
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    v.play().catch(() => {});
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true });
    let dark = 0;
    const t = setInterval(() => {
      if (!v.videoWidth || v.readyState < 2) return;
      try {
        g.drawImage(v, 0, 0, W, H);
        const d = g.getImageData(0, 0, W, H).data;
        let max = 0;
        for (let i = 0; i < d.length; i += 4) {
          const l = d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722;
          if (l > max) max = l;
        }
        dark = max < 14 ? dark + 1 : 0;
        setBlack(dark >= 3);
      } catch {}
    }, 2000);
    return () => {
      clearInterval(t);
      v.srcObject = null;
    };
  }, [stream]);

  return black;
}
