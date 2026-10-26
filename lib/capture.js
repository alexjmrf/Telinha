// "Tela inteira" com som escolhido a dedo.
//
// O navegador só oferece duas opções de som para tela inteira: o som do PC
// inteiro (que inclui o Discord) ou nada. Para deixar o Discord de fora,
// pegamos o VÍDEO da tela inteira e misturamos o SOM de janelas específicas
// (cada uma capturada à parte, com o áudio só dela). O mix sai como uma única
// trilha de áudio, então adicionar/remover fontes não derruba a transmissão.

import { displayOptions } from "./rtc";

// captura de fonte de som: o vídeo é descartável, então pede o mínimo
const TINY = { width: 320, height: 180, frameRate: 5 };

export function screenVideoOptions(q) {
  const o = displayOptions(q, "window");
  o.video.displaySurface = "monitor";
  o.audio = false; // o som vem das fontes escolhidas depois
  delete o.systemAudio;
  delete o.windowAudio;
  return o;
}

export function audioSourceOptions(kind) {
  // "window": uma janela/aba com o som só dela | "system": som do PC inteiro
  return displayOptions(TINY, kind === "system" ? "screen" : "window");
}

export class ScreenMix {
  constructor(onChange) {
    this.ctx = new AudioContext({ sampleRate: 48000 });
    this.dest = this.ctx.createMediaStreamDestination();
    this.dest.channelCount = 2;
    this.sources = [];
    this.onChange = onChange;
    this.n = 0;
  }

  get mixTrack() {
    return this.dest.stream.getAudioTracks()[0];
  }

  // monta o stream da transmissão: vídeo da tela + trilha de áudio mixada
  setVideo(screenStream) {
    screenStream.getAudioTracks().forEach((t) => t.stop());
    return new MediaStream([screenStream.getVideoTracks()[0], this.mixTrack]);
  }

  // retorna a fonte adicionada, ou null se a captura veio sem som
  addSource(stream, requested) {
    const a = stream.getAudioTracks()[0];
    if (!a) {
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    this.ctx.resume();
    const node = this.ctx.createMediaStreamSource(new MediaStream([a]));
    node.connect(this.dest);

    const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
    const kind = requested === "system" || surface === "monitor" ? "system" : surface === "browser" ? "browser" : "window";
    this.n += 1;
    const src = {
      id: this.n,
      kind,
      stream,
      node,
      ownFiltered: !!a.getSettings?.().restrictOwnAudio,
      label: kind === "system" ? "Som do PC inteiro" : kind === "browser" ? `Aba ${this.n}` : `Janela ${this.n}`,
    };
    this.sources.push(src);
    // se a pessoa parar essa captura pela barra do Chrome, a fonte some
    stream.getTracks().forEach((t) => t.addEventListener("ended", () => this.remove(src.id)));
    this.onChange?.();
    return src;
  }

  remove(id) {
    const i = this.sources.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [s] = this.sources.splice(i, 1);
    s.node.disconnect();
    s.stream.getTracks().forEach((t) => t.stop());
    this.onChange?.();
  }

  stop() {
    for (const s of this.sources) {
      s.node.disconnect();
      s.stream.getTracks().forEach((t) => t.stop());
    }
    this.sources = [];
    this.ctx.close().catch(() => {});
  }
}
