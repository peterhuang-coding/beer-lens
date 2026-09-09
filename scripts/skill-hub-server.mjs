#!/usr/bin/env node
/** Read-only local dashboard; all statistics have explicit portable sources. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ROOT,
  getStats,
  getHealth,
  getCrawlLog,
  getSnapshots,
  getFeatures,
  getApis,
} from "./project-data.mjs";
const dataRoot = process.env.BEER_LENS_DATA_ROOT
  ? path.resolve(process.env.BEER_LENS_DATA_ROOT)
  : ROOT;
function parseArgs(argv) {
  let port = process.env.PORT ?? "8888",
    host = process.env.HOST ?? "127.0.0.1";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") return { help: true };
    if (argv[i] === "--port") port = argv[++i];
    else if (argv[i] === "--host") host = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!/^\d+$/.test(port ?? "") || Number(port) > 65535)
    throw new Error("port must be an integer from 0 to 65535");
  if (!host || host.startsWith("-")) throw new Error("Missing host");
  return { port: Number(port), host };
}
const jsonRoutes = {
  "/api/stats": getStats,
  "/api/health": getHealth,
  "/api/crawl-log": getCrawlLog,
  "/api/snapshots": getSnapshots,
  "/api/features": getFeatures,
  "/api/apis": getApis,
};
const staticRoutes = {
  "/": ["dashboard.html", "text/html"],
  "/data/dashboard.css": ["dashboard.css", "text/css"],
  "/data/dashboard.js": ["dashboard.js", "text/javascript"],
};
function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: npm run hub:serve -- [--port 8888] [--host 127.0.0.1]\nGET /, /api/stats, /api/health, /api/crawl-log, /api/snapshots, /api/features, /api/apis",
    );
    return;
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "GET") {
        res.setHeader("allow", "GET");
        return json(res, 405, { error: "method not allowed" });
      }
      const url = new URL(req.url, "http://localhost");
      if (Object.hasOwn(jsonRoutes, url.pathname))
        return json(res, 200, await jsonRoutes[url.pathname](dataRoot));
      const entry = Object.hasOwn(staticRoutes, url.pathname)
        ? staticRoutes[url.pathname]
        : null;
      if (!entry) return json(res, 404, { error: "not found" });
      const body = await readFile(path.join(ROOT, "data", entry[0]));
      res.writeHead(200, {
        "content-type": `${entry[1]}; charset=utf-8`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      });
      res.end(body);
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  });
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(args.port, args.host, () => {
    console.log(`Skill Hub → http://${args.host}:${server.address().port}/`);
  });
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
