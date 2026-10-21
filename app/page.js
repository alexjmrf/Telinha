"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { randomRoom } from "@/lib/rtc";

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
    <main className="home">
      <div className="brand">
        <span className="dot live" /> telinha
      </div>
      <h1>Compartilhe uma janela. Com o som só dela.</h1>
      <p className="lead">
        Crie uma sala e mande o link. Todo mundo na sala pode transmitir ao mesmo tempo, e cada um escolhe quem quer
        assistir. O áudio vem só da janela escolhida: o Discord, as notificações e o resto do PC ficam de fora.
      </p>

      <label className="field">
        <span>Seu apelido</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex: alexandre" maxLength={24} />
      </label>

      <div className="cards">
        <section className="card">
          <h2>Nova sala</h2>
          <p>Cria uma sala com um código novo pra mandar pros amigos.</p>
          <button className="btn primary" onClick={host}>
            Criar sala
          </button>
        </section>

        <form className="card" onSubmit={join}>
          <h2>Entrar numa sala</h2>
          <p>Cole o código ou o link que te mandaram.</p>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="gato-1234" />
          <button className="btn" type="submit" disabled={!code.trim()}>
            Entrar
          </button>
        </form>
      </div>

      <footer className="foot">
        Funciona melhor no Chrome ou Edge no Windows. Vídeo e som vão direto de PC pra PC (WebRTC); nada passa por
        servidor nosso.
      </footer>
    </main>
  );
}
