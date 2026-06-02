#!/usr/bin/env node
/**
 * Génère public/logo.png — le logo imprimé au démarrage.
 * Modifiez les variables ci-dessous puis relancez : node generate-logo.js
 * Pour utiliser votre propre image, remplacez directement public/logo.png
 * (PNG, 384px de large, noir sur blanc recommandé).
 */

const { Jimp, loadFont, HorizontalAlign } = require('jimp');
const path = require('path');

// ── Personnalisation ───────────────────────────────────────────────
const TITLE    = 'PIZZIA';          // Nom affiché en grand
const SUBTITLE = 'Pret a recevoir'; // Ligne sous le titre
const WIDTH    = 384;               // 384 = imprimante 80mm standard
// ──────────────────────────────────────────────────────────────────

async function generate() {
  const H = 148;
  const img = new Jimp({ width: WIDTH, height: H, color: 0xffffffff });

  const font64 = await loadFont(path.join(
    __dirname, 'node_modules/@jimp/plugin-print/fonts/open-sans/open-sans-64-black/open-sans-64-black.fnt'
  ));
  const font16 = await loadFont(path.join(
    __dirname, 'node_modules/@jimp/plugin-print/fonts/open-sans/open-sans-16-black/open-sans-16-black.fnt'
  ));

  // Titre
  img.print({ font: font64, x: 0, y: 8,
    text: { text: TITLE, alignmentX: HorizontalAlign.CENTER }, maxWidth: WIDTH });

  // Séparateur
  const sep = '─'.repeat(32);
  img.print({ font: font16, x: 0, y: 100,
    text: { text: sep, alignmentX: HorizontalAlign.CENTER }, maxWidth: WIDTH });

  // Sous-titre
  img.print({ font: font16, x: 0, y: 122,
    text: { text: SUBTITLE, alignmentX: HorizontalAlign.CENTER }, maxWidth: WIDTH });

  const outPath = path.join(__dirname, 'public', 'logo.png');
  await img.write(outPath);
  console.log(`Logo généré : ${outPath} (${WIDTH}×${H}px)`);
}

generate().catch(err => {
  console.error('Erreur :', err.message);
  process.exit(1);
});
