// Cor de cada pessoa (avatar e nome no chat), calculada a partir do apelido
// para ficar igual em todos os navegadores. Tons claros sobre o fundo escuro,
// com texto escuro do mesmo tom dentro do avatar.

function hash(str) {
  // FNV-1a + finalizador do murmur: espalha bem nomes parecidos
  let h = 2166136261;
  for (const c of String(str).toLowerCase()) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function colorFor(name = "") {
  const hue = hash(name) % 360;
  return { bg: `hsl(${hue} 85% 72%)`, fg: `hsl(${hue} 70% 12%)` };
}

export function initial(name = "") {
  const ch = String(name).trim()[0];
  return ch ? ch.toUpperCase() : "?";
}
