import { main } from "./replaycli.js";

process.exitCode = await main(process.argv.slice(2), {
  uid: process.getuid?.(),
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t.endsWith("\n") ? t : `${t}\n`),
  now: () => new Date(),
});
