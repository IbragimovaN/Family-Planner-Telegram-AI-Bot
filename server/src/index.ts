import database from "./database.js";
import { createApp } from "./app.js";
import { readAuthConfig } from "./auth/config.js";

const config = readAuthConfig();
const port = Number(process.env.PORT) || 3000;
const host = config.devEnabled ? "127.0.0.1" : "0.0.0.0";
createApp(database, config).listen(port, host, () => {
  console.log(`Server started on port ${port}`);
});
