// Copia os estáticos e versiona app.js/styles.css pelo conteúdo (cache-busting).
import crypto from "node:crypto";
import fs from "node:fs";

const out = "dist/public";
fs.cpSync("src/web/fonts", `${out}/fonts`, { recursive: true });
fs.cpSync("src/web/icons", `${out}/icons`, { recursive: true });
fs.copyFileSync("src/web/styles.css", `${out}/styles.css`);
const hash = (f) => crypto.createHash("sha1").update(fs.readFileSync(`${out}/${f}`)).digest("hex").slice(0, 10);
const html = fs
  .readFileSync("src/web/index.html", "utf8")
  .replace('src="app.js"', `src="app.js?v=${hash("app.js")}"`)
  .replace('href="styles.css"', `href="styles.css?v=${hash("styles.css")}"`);
fs.writeFileSync(`${out}/index.html`, html);
