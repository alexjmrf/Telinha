"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Room } from "@/lib/room";
import { QUALITY, displayOptions } from "@/lib/rtc";
import Chat, { speak, useTts } from "./Chat";

const SURFACE_LABEL = { window: "janela", browser: "aba", monitor: "tela inteira" };

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

export default function RoomPage() {
  const { id } = useParams();
  const room = String(id).toLowerCase();
  const [name, setName] = useState(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const saved = load("telinha:name", "");
    setDraft(saved);
    // Se já veio de um clique (ex.: "Criar sala"), entra direto.
    // Senão, pede um clique: isso também libera o som automático no navegador.
    if (saved && navigator.userActivation?.hasBeenActive) setName(saved);
  }, []);

  if (!name) {
    return (
      <main className="home narrow">
        <Link href="/" className="brand">
          <span className="dot" /> telinha
        </Link>
        <h1 className="h2">
          Entrar na sala <code>{room}</code>
        </h1>
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            const n = draft.trim() || "anônimo";
            save("telinha:name", n);
            setName(n);
          }}
        >
          <label className="field">
            <span>Seu apelido</span>
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={24} placeholder="ex: alexandre" />
          </label>
          <button className="btn primary" type="submit">
            Entrar
          </button>
        </form>
      </main>
    );
  }

  return <RoomView room={room} name={name} />;
}

function RoomView({ room, name }) {
  const [, force] = useReducer((x) => x + 1, 0);
  const roomRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  const tts = useTts();
  const ttsRef = tts.ref;

  useEffect(() => {
    const r = new Room(room, name, force);
    r.onChat = (msg) => {
      if (msg.tts && ttsRef.current.on) speak(msg, ttsRef.current.volume);
    };
    roomRef.current = r;
    r.start();
    force();
    const bye = () => r.destroy();
    window.addEventListener("pagehide", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      r.destroy();
    };
  }, [room, name, ttsRef]);

  const r = roomRef.current;
  if (!r) return null;

  async function share() {
    setErr("");
    try {
      const s = await navigator.mediaDevices.getDisplayMedia(displayOptions(QUALITY[r.quality]));
      r.goLive(s);
    } catch (e) {
      if (e.name !== "NotAllowedError") setErr("Não deu pra capturar: " + e.message);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${location.origin}/sala/${room}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  const members = r.members.length ? r.members : r.selfId ? [{ id: r.selfId, ...r.stateObj() }] : [];
  const sorted = [...members].sort((a, b) => (b.live - a.live) || (a.id === r.selfId ? -1 : b.id === r.selfId ? 1 : 0));
  const live = sorted.filter((m) => m.live);
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  const tiles = [...r.watching.entries()];

  return (
    <main className="room">
      <header className="bar">
        <Link href="/" className="brand small">
          <span className={`dot ${r.local ? "live" : ""}`} /> telinha
        </Link>
        <div className="share">
          <code>{room}</code>
          <button className="btn ghost" onClick={copy}>
            {copied ? "Copiado!" : "Copiar link"}
          </button>
        </div>
      </header>

      <div className="layout">
        <section className={`stage grid n${Math.min(tiles.length, 4)}`}>
          {tiles.length === 0 ? (
            <div className="empty">
              {r.status === "conectando" && !r.members.length ? (
                <p>Entrando na sala…</p>
              ) : live.length === 0 ? (
                <>
                  <p>Ninguém transmitindo ainda.</p>
                  <p className="hint">Qualquer um na sala pode clicar em “Transmitir uma janela”.</p>
                </>
              ) : (
                <>
                  <p>Ao vivo agora:</p>
                  <div className="row wrap">
                    {live.map((m) => (
                      <button key={m.id} className="btn primary" onClick={() => r.watch(m.id)}>
                        {m.id === r.selfId ? "Ver minha prévia" : `Assistir ${m.name}`}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            tiles.map(([id, e]) => {
              const self = !!e.self;
              const m = byId[id];
              return (
                <Tile
                  key={id}
                  self={self}
                  stream={self ? r.local?.stream : e.stream}
                  label={self ? "Você (prévia)" : m?.name || "…"}
                  hasAudio={self ? r.local?.hasAudio : m?.hasAudio}
                  onClose={() => r.unwatch(id)}
                />
              );
            })
          )}
        </section>

        <aside className="side">
          <div className="panel">
            <h3>Você</h3>
            {r.local ? (
              <>
                <div className="row">
                  <span className="pill live">AO VIVO</span>
                  <span>{SURFACE_LABEL[r.local.surface] || r.local.surface}</span>
                </div>
                <AudioBadge surface={r.local.surface} hasAudio={r.local.hasAudio} />
                <p className="hint" style={{ marginTop: 0 }}>
                  {r.watchers.size === 0
                    ? "Ninguém te assistindo ainda."
                    : `Te assistindo: ${[...r.watchers.values()].map((w) => w.name).join(", ")}`}
                </p>
                <div className="row gap">
                  <button className="btn" onClick={share}>
                    Trocar janela
                  </button>
                  <button className="btn danger" onClick={() => r.stopLive()}>
                    Parar
                  </button>
                </div>
              </>
            ) : (
              <>
                <button className="btn primary wide" onClick={share} disabled={!r.selfId}>
                  Transmitir uma janela
                </button>
                <p className="hint">
                  No seletor, escolha <b>Janela</b> (ou <b>Aba</b>) e deixe marcado <b>“Compartilhar áudio”</b>.
                </p>
              </>
            )}
            {err && <p className="err">{err}</p>}
          </div>

          <div className="panel">
            <h3>Na sala ({members.length})</h3>
            <ul className="members">
              {sorted.map((m) => {
                const me = m.id === r.selfId;
                const watching = r.watching.has(m.id);
                return (
                  <li key={m.id}>
                    <span className="who">
                      {m.live ? <span className="pill live sm">AO VIVO</span> : <span className="pres" />}
                      <span className="nm">
                        {m.name}
                        {me && <em> (você)</em>}
                      </span>
                      {m.live && (
                        <span className="meta">
                          {m.hasAudio ? "🔊" : "🔇"} 👁 {m.watchers?.length || 0}
                        </span>
                      )}
                    </span>
                    {m.live && (
                      <button className={`btn sm ${watching ? "" : "primary"}`} onClick={() => (watching ? r.unwatch(m.id) : r.watch(m.id))}>
                        {watching ? "Fechar" : me ? "Prévia" : "Assistir"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <Chat room={r} selfId={r.selfId} online={r.status === "online"} tts={tts} />

          <details className="panel">
            <summary>
              <h3>Qualidade da sua transmissão</h3>
            </summary>
            <select value={r.quality} onChange={(e) => r.setQuality(e.target.value)}>
              {Object.keys(QUALITY).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <div className="seg">
              <button className={r.motion ? "on" : ""} onClick={() => r.setMotion(true)}>
                Jogo / vídeo
              </button>
              <button className={!r.motion ? "on" : ""} onClick={() => r.setMotion(false)}>
                Texto / código
              </button>
            </div>
            <p className="hint">Você envia uma cópia pra cada pessoa que te assiste. Com muita gente, baixe a qualidade.</p>
          </details>

          {r.status === "conectando" && r.members.length > 0 && <p className="hint">Reconectando à sala…</p>}
          {r.error && <p className="err">{r.error}</p>}
        </aside>
      </div>
    </main>
  );
}

function Tile({ stream, label, self, hasAudio, onClose }) {
  const videoRef = useRef(null);
  const wrapRef = useRef(null);
  const [vol, setVol] = useState(1);
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const v = parseFloat(load("telinha:vol", "1"));
    if (!Number.isNaN(v)) setVol(v);
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream || null;
    if (!stream) return;
    v.muted = self;
    v.play().catch(() => {
      // Navegador bloqueou som automático: toca mudo e pede um clique.
      v.muted = true;
      setBlocked(true);
      v.play().catch(() => {});
    });
  }, [stream, self]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = vol;
    if (!blocked) v.muted = self || muted;
    save("telinha:vol", String(vol));
  }, [vol, muted, blocked, self]);

  function unlock() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    v.play().catch(() => {});
    setBlocked(false);
    setMuted(false);
  }

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrapRef.current?.requestFullscreen?.();
  }

  return (
    <div className="tile" ref={wrapRef} onDoubleClick={fullscreen}>
      <video ref={videoRef} autoPlay playsInline />
      {!stream && <div className="loading">Conectando…</div>}
      <div className="tag">{label}</div>
      {blocked && stream && (
        <button className="unlock" onClick={unlock}>
          🔊 Clique para ativar o som
        </button>
      )}
      <div className="controls">
        {self ? (
          <span className="hint">prévia sem som</span>
        ) : hasAudio ? (
          <>
            <button className="btn ghost sm" onClick={() => (blocked ? unlock() : setMuted((m) => !m))}>
              {muted || blocked ? "🔇" : "🔊"}
            </button>
            <input type="range" min="0" max="1" step="0.01" value={vol} onChange={(e) => setVol(parseFloat(e.target.value))} />
          </>
        ) : (
          <span className="hint">sem áudio</span>
        )}
        <span className="spacer" />
        <button className="btn ghost sm" onClick={fullscreen} title="Tela cheia">
          ⛶
        </button>
        <button className="btn ghost sm" onClick={onClose} title="Fechar">
          ✕
        </button>
      </div>
    </div>
  );
}

function AudioBadge({ surface, hasAudio }) {
  if (hasAudio) return <p className="ok">🔊 Áudio: só {surface === "browser" ? "desta aba" : "desta janela"}</p>;
  if (surface === "monitor")
    return <p className="warn">🔇 Tela inteira vai sem som (pra não vazar o áudio do PC). Escolha uma janela ou aba.</p>;
  return (
    <p className="warn">
      🔇 Sem áudio. A caixa “Compartilhar áudio” estava desmarcada, ou seu navegador ainda não captura som por janela.
      Use Chrome/Edge atualizado no Windows, ou compartilhe uma <b>aba</b>.
    </p>
  );
}
