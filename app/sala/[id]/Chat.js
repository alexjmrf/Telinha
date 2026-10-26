"use client";

import { useEffect, useRef, useState } from "react";
import { colorFor } from "@/lib/colors";
import { IconMute, IconSend, IconStop, IconVolume } from "../../icons";

function load(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

// ---------- TTS (Web Speech API, roda no navegador de quem ouve) ----------
function pickVoice() {
  const voices = window.speechSynthesis?.getVoices() || [];
  return (
    voices.find((v) => v.lang === "pt-BR" && /google|natural|online/i.test(v.name)) ||
    voices.find((v) => v.lang === "pt-BR") ||
    voices.find((v) => v.lang?.startsWith("pt")) ||
    null
  );
}

export function speak(msg, volume) {
  const s = window.speechSynthesis;
  if (!s) return;
  const u = new SpeechSynthesisUtterance(`${msg.name} disse: ${msg.text}`);
  const v = pickVoice();
  if (v) u.voice = v;
  u.lang = v?.lang || "pt-BR";
  u.volume = volume;
  u.rate = 1.05;
  s.speak(u);
}

// texto com links clicáveis (só http/https)
function Linkify({ text }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow">
        {p}
      </a>
    ) : (
      p
    )
  );
}

export default function Chat({ room, selfId, online, tts }) {
  const [text, setText] = useState("");
  const listRef = useRef(null);
  const stick = useRef(true);
  const messages = room.messages;

  // rola pro fim quando chega mensagem (se a pessoa já estava no fim)
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  function onScroll() {
    const el = listRef.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  function send(e) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    if (/^\/tts\s*$/i.test(t)) return; // /tts sem texto
    if (room.sendChat(t)) {
      setText("");
      stick.current = true;
    }
  }

  const typingTts = /^\/t?t?s?$/i.test(text) || /^\/tts\b/i.test(text);

  return (
    <section className="panel chat" aria-labelledby="chat-t">
      <div className="panel-head">
        <h2 id="chat-t" className="panel-title">
          Chat
        </h2>
        <div className="tts-ctl">
          <label className="switch" title="Ouvir mensagens /tts">
            <input type="checkbox" checked={tts.on} onChange={(e) => tts.setOn(e.target.checked)} />
            Ouvir TTS
          </label>
          {tts.on && (
            <>
              <label style={{ display: "flex" }}>
                <span className="sr-only">Volume do TTS</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={tts.volume}
                  onChange={(e) => tts.setVolume(parseFloat(e.target.value))}
                />
              </label>
              <button
                className="icon-btn boxed"
                onClick={() => window.speechSynthesis?.cancel()}
                aria-label="Calar o TTS agora"
                title="Calar o TTS agora"
              >
                <IconStop />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="msgs" ref={listRef} onScroll={onScroll} aria-live="polite">
        {messages.length === 0 && <p className="hint">Nenhuma mensagem ainda. Use /tts texto pra falar em voz alta.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.tts ? "tts" : ""} ${m.from === selfId ? "me" : ""}`}>
            <span className="time">{new Date(m.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
            <b style={{ color: colorFor(m.name).bg }}>{m.name}</b>
            {m.tts && (
              <span className="ttsflag" role="img" aria-label="falado em voz alta" title="Mensagem falada (TTS)">
                <IconVolume size={13} />
              </span>
            )}
            {m.ttsBlocked && (
              <span className="ttsflag off" role="img" aria-label="TTS ignorado" title="TTS ignorado: espere 5 s entre TTS">
                <IconMute size={13} />
              </span>
            )}
            <span className="txt">
              <Linkify text={m.text} />
            </span>
          </div>
        ))}
      </div>

      <form onSubmit={send} className="chat-form">
        {typingTts && (
          <div className="cmd-hint">
            <b>/tts</b> texto · lê em voz alta pra quem tem TTS ligado
          </div>
        )}
        <label>
          <span className="sr-only">Mensagem</span>
          <input
            className={`input ${typingTts ? "cmd" : ""}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={online ? "Mensagem… (/tts pra falar)" : "Conectando…"}
            maxLength={510}
            disabled={!online}
          />
        </label>
        <button className="btn primary send" type="submit" aria-label="Enviar" disabled={!online || !text.trim()}>
          <IconSend />
        </button>
      </form>
    </section>
  );
}

// estado do TTS guardado no navegador de cada pessoa
export function useTts() {
  const [on, setOnState] = useState(true);
  const [volume, setVolState] = useState(1);
  const ref = useRef({ on: true, volume: 1 });

  useEffect(() => {
    const o = load("telinha:tts", "1") === "1";
    const v = parseFloat(load("telinha:ttsvol", "1"));
    setOnState(o);
    setVolState(Number.isNaN(v) ? 1 : v);
    ref.current = { on: o, volume: Number.isNaN(v) ? 1 : v };
    // Chrome carrega as vozes de forma assíncrona
    window.speechSynthesis?.getVoices();
  }, []);

  return {
    on,
    volume,
    ref,
    setOn(v) {
      setOnState(v);
      ref.current.on = v;
      save("telinha:tts", v ? "1" : "0");
      if (!v) window.speechSynthesis?.cancel();
    },
    setVolume(v) {
      setVolState(v);
      ref.current.volume = v;
      save("telinha:ttsvol", String(v));
    },
  };
}
