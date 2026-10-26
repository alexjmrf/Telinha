"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { randomRoom } from "@/lib/rtc";
import { colorFor } from "@/lib/colors";
import { IconChat, IconGrid, IconVolume, IconVolumeLoud, Logo } from "./icons";

export default function Home() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    try {
      setName(localStorage.getItem("telinha:name") || "");
    } catch {}
  }, []);

  function saveName() {
    try {
      localStorage.setItem("telinha:name", name.trim());
    } catch {}
  }

  function host() {
    saveName();
    router.push(`/sala/${randomRoom()}`);
  }

  function join(e) {
    e.preventDefault();
    const c = code.trim().toLowerCase().replace(/.*\/sala\//, "").replace(/\/.*/, "");
    if (!c) return;
    saveName();
    router.push(`/sala/${c}`);
  }

  return (
    <div>
      <header className="wrap home-nav">
        <Link href="/" className="logo">
          <Logo size={34} />
          <b>telinha</b>
        </Link>
        <nav aria-label="Principal">
          <a href="#como">Como funciona</a>
          <a href="#recursos">Recursos</a>
        </nav>
      </header>

      <main>
        <section className="wrap hero">
          <div className="hero-copy">
            <span className="eyebrow">
              <span className="dot" /> Compartilhamento de tela entre amigos
            </span>
            <h1>
              Sua tela,
              <br />
              com o som
              <br />
              <em>só dela.</em>
            </h1>
            <p className="lead">
              Crie uma sala, mande o link e todo mundo pode transmitir ao mesmo tempo. O áudio vem só da janela
              escolhida: o Discord e as notificações ficam de fora.
            </p>

            <form className="start" onSubmit={join}>
              <label className="field">
                Seu apelido
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="ex: alexandre"
                  maxLength={24}
                />
              </label>
              <button type="button" className="btn primary lg" onClick={host}>
                Criar sala
              </button>
              <div className="divider">ou entre numa sala</div>
              <div className="join-row">
                <label>
                  <span className="sr-only">Código ou link da sala</span>
                  <input
                    className="input mono"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="gato-1234"
                  />
                </label>
                <button className="btn" type="submit" disabled={!code.trim()}>
                  Entrar
                </button>
              </div>
            </form>
          </div>

          <HeroArt />
        </section>

        <section id="recursos" className="features">
          <div className="wrap">
            <div className="feature">
              <IconGrid />
              <h2>Várias telas de uma vez</h2>
              <p>Qualquer um na sala pode ir ao vivo. Você abre até quatro transmissões lado a lado, cada uma com volume próprio.</p>
            </div>
            <div className="feature">
              <IconVolumeLoud size={28} />
              <h2>Som só da janela</h2>
              <p>Escolha o jogo ou o player e só o som dele vai junto. Na tela inteira, você escolhe de quais janelas vem o áudio.</p>
            </div>
            <div className="feature">
              <IconChat />
              <h2>Chat com /tts</h2>
              <p>
                Mande <code>/tts</code> e a mensagem é lida em voz alta. Quem não quiser ouvir desliga com um clique.
              </p>
            </div>
          </div>
        </section>

        <section id="como" className="wrap steps">
          <h2>Três passos e pronto</h2>
          <ol>
            <li>
              <span className="n">01</span>
              <b>Crie a sala</b>
              <span>
                Ganha um código tipo <span className="mono" style={{ color: "var(--text)" }}>gato-1234</span>. Manda o link no grupo.
              </span>
            </li>
            <li>
              <span className="n">02</span>
              <b>Escolha a janela</b>
              <span>No seletor do Chrome, marque “Compartilhar áudio”. Só o som dela vai junto.</span>
            </li>
            <li>
              <span className="n">03</span>
              <b>Cada um assiste o que quer</b>
              <span>Na lista da sala, clique em Assistir. Ninguém recebe o que não abriu.</span>
            </li>
          </ol>
        </section>
      </main>

      <footer className="home-foot">
        <div className="wrap">
          <span>Funciona melhor no Chrome ou Edge no Windows.</span>
          <span>Vídeo e som vão direto de PC pra PC. Nada passa por servidor.</span>
        </div>
      </footer>
    </div>
  );
}

// ilustração da sala (decorativa)
function HeroArt() {
  const people = ["ana", "bia", "caio"];
  return (
    <div className="hero-art" aria-hidden="true">
      <div className="mock">
        <div className="mock-top">
          <span>sala/gato-1234</span>
          <span className="mock-avatars">
            {people.map((p) => {
              const c = colorFor(p);
              return (
                <span key={p} className="avatar" style={{ background: c.bg, color: c.fg }}>
                  {p[0].toUpperCase()}
                </span>
              );
            })}
            <span className="avatar" style={{ background: "var(--line)", color: "var(--text)", fontSize: 11 }}>
              +2
            </span>
          </span>
        </div>
        <div className="mock-grid">
          <div className="mock-screen scene">
            <i style={{ left: 0, right: 0, bottom: 0, height: "38%", background: "#22384A" }} />
            <i style={{ left: "14%", bottom: "30%", width: "12%", height: "26%", background: "#FFB547", borderRadius: "4px 4px 0 0" }} />
            <i style={{ left: "46%", bottom: "38%", width: "30%", height: "7%", background: "#3B5872", borderRadius: 3 }} />
            <i style={{ right: "12%", top: "16%", width: "14%", aspectRatio: "1", borderRadius: "50%", background: "#E9E2C8" }} />
            <span className="pill-live">AO VIVO</span>
            <span className="name">ana</span>
          </div>
          <div className="mock-screen code-scene">
            <i style={{ width: "60%", background: "#9C8CFF" }} />
            <i style={{ width: "80%", background: "#3A3F4E" }} />
            <i style={{ width: "45%", background: "#6FD3B8" }} />
            <i style={{ width: "70%", background: "#3A3F4E" }} />
            <i style={{ width: "52%", background: "#FFB547" }} />
            <span className="pill-live">AO VIVO</span>
            <span className="name">bia</span>
          </div>
        </div>
        <div className="mock-chat">
          <div>
            <b style={{ color: colorFor("bia").bg }}>bia</b> abre o som do jogo aí
          </div>
          <div>
            <b style={{ color: colorFor("caio").bg }}>caio</b>
            <span style={{ color: "var(--accent)", display: "inline-flex" }}>
              <IconVolume size={14} />
            </span>
            bora, chefão final!
          </div>
        </div>
      </div>
    </div>
  );
}
