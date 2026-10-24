// MCP por stdio: docker exec -i ghostfolio-relatorios node mcp.js
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp";

// stdout é o canal do protocolo: qualquer log vai para stderr.
createMcpServer()
  .connect(new StdioServerTransport())
  .then(() => console.error("[mcp carteira] pronto"));
