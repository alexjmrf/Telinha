import "./globals.css";

export const metadata = {
  title: "Telinha — compartilhar tela",
  description: "Compartilhe uma janela específica com áudio só dela, direto no navegador.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
