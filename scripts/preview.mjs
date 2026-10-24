import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

export function createPreviewServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const path = decodeURIComponent(url.pathname);
      const relative = path === "/" ? "index.html"
        : path === "/__preview/client.js" ? "scripts/preview-client.js" : path.slice(1);
      const file = resolve(root, relative);
      if (!file.startsWith(`${root.replace(/\/$/, "")}${sep}`)
        || !(relative === "index.html" || relative === "scripts/preview-client.js"
          || relative.startsWith("assets/") || relative.startsWith("data/"))) {
        response.writeHead(404).end("Not found");
        return;
      }
      let content = await readFile(file);
      if (relative === "index.html") {
        content = content.toString().replace(
          '<script src="assets/app.js"></script>',
          '<script src="/__preview/client.js"></script>\n  <script src="assets/app.js"></script>'
        );
      }
      response.writeHead(200, { "Content-Type": `${types[extname(file)] || "application/octet-stream"}; charset=utf-8`, "Cache-Control": "no-store" });
      response.end(content);
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof URIError) response.writeHead(404).end("Not found");
      else {
        console.error("Preview request failed.", error);
        response.writeHead(500).end("Preview request failed");
      }
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8765);
  const server = createPreviewServer();
  server.on("error", (error) => { console.error("Cannot start preview.", error); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`Local signed-in preview: http://127.0.0.1:${port}/`));
}
