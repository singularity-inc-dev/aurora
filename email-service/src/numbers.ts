/**
 * Entry point of `vt-numbers` (run on the server as `sudo vt-numbers`). See numberscli.ts.
 */
import { loadConfig } from "./config.ts";
import { runNumbers } from "./numberscli.ts";
import { paperclipApi } from "./paperclip.ts";

process.exitCode = await runNumbers(paperclipApi(loadConfig()), process.argv.slice(2));
