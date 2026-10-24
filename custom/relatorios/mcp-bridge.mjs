#!/usr/bin/env node
// Ponte stdio → HTTPS para o MCP "carteira": o Claude Desktop/Code roda este arquivo localmente e
// ele repassa cada mensagem para https://<relatórios>/mcp. Sem dependências (Node 18+).
//   MCP_URL=https://ctrelatorio.exemplo.com/mcp MCP_TOKEN=... node mcp-bridge.mjs
import readline from "node:readline";

const URL_ = process.env.MCP_URL;
const TOKEN = process.env.MCP_TOKEN;
if (!URL_ || !TOKEN) {
  console.error("[carteira] defina MCP_URL e MCP_TOKEN");
  process.exit(1);
}

const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const fail = (msg, text) => msg.id !== undefined && out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: text } });

let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  queue = queue.then(async () => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    try {
      const res = await fetch(URL_, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
        body: line,
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status === 202 || res.status === 204) return; // notificação
      const text = await res.text();
      if (!res.ok) return fail(msg, `Servidor da carteira respondeu ${res.status}: ${text.slice(0, 200)}`);
      const body = JSON.parse(text);
      for (const m of Array.isArray(body) ? body : [body]) out(m);
    } catch (err) {
      console.error("[carteira]", err.message);
      fail(msg, `Sem conexão com o servidor da carteira (${err.message})`);
    }
  });
});
process.stdin.on("end", () => queue.then(() => process.exit(0)));
