const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const packageRoot = path.resolve(
  __dirname,
  "..",
  "node_modules",
  "NeteaseCloudMusicApi"
);
const anonymousTokenPath = path.join(os.tmpdir(), "anonymous_token");

async function start() {
  if (!fs.existsSync(anonymousTokenPath)) {
    fs.writeFileSync(anonymousTokenPath, "", "utf8");
  }

  const generateConfig = require(path.join(packageRoot, "generateConfig.js"));
  await generateConfig();

  const { serveNcmApi } = require(path.join(packageRoot, "server.js"));
  await serveNcmApi({
    port: Number(process.env.PORT || 3001),
    host: process.env.HOST || "",
    checkVersion: false
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
