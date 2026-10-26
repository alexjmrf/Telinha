"use client";

import { useEffect, useRef, useState } from "react";

const COLORS = ["#9a8dff", "#3ecf8e", "#f5b84a", "#ff7a90", "#5cc8ff", "#e58bff", "#ffb36b", "#7ee0c3"];
function colorFor(id = "") {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

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
    <div className="panel chat">
      <div className="chat-head">
        <h3>Chat</h3>
        <div className="tts-ctl">
          <label className="switch" title="Ouvir mensagens /tts">
            <input type="checkbox" checked={tts.on} onChange={(e) => tts.setOn(e.target.checked)} />
            <span>TTS</span>
          </label>
          {tts.on && (
            <>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={tts.volume}
                onChange={(e) => tts.setVolume(parseFloat(e.target.value))}
                title="Volume do TTS"
              />
              <button className="btn ghost sm" onClick={() => window.speechSynthesis?.cancel()} title="Calar o TTS agora">
                ⏹
              </button>
            </>
          )}
        </div>
      </div>

      <div className="msgs" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 && <p className="hint">Nenhuma mensagem ainda. Use /tts texto pra falar em voz alta.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.from === selfId ? "me" : ""}`}>
            <span className="time">{new Date(m.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
            <b style={{ color: colorFor(m.from) }}>{m.name}</b>{" "}
            {m.tts && <span className="ttsflag" title="Mensagem falada (TTS)">🔊</span>}
            {m.ttsBlocked && <span className="ttsflag off" title="TTS ignorado: espere 5 s entre TTS">🔇</span>}
            <span className="txt">
              <Linkify text={m.text} />
            </span>
          </div>
        ))}
      </div>

      <form onSubmit={send} className="chat-form">
        {typingTts && (
          <div className="cmd-hint">
            <b>/tts</b> &lt;texto&gt; — lê em voz alta pra todo mundo com TTS ligado
          </div>
        )}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={online ? "Mensagem…  (/tts texto pra falar)" : "Conectando…"}
          maxLength={510}
          disabled={!online}
        />
      </form>
    </div>
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
