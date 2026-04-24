import { config } from "./config.js";
import { createServer } from "./server.js";

const app = await createServer();

app.listen({ port: config.serverPort, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
