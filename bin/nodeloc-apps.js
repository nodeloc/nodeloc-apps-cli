#!/usr/bin/env node

import { init, dev, upload, playtest, logs } from "../src/commands.js";
import { login, logout, whoami } from "../src/login.js";

const COMMANDS = { login, logout, whoami, init, dev, upload, playtest, logs };

const USAGE = `nodeloc-apps <command>

  login --site <url>   Sign in through your browser
  whoami               Show who you are signed in as
  logout               Forget the stored credential

  init <slug>          Start a new app in ./<slug>
  dev                  Bundle and check the app without publishing
  playtest             Push to a private install and re-push on every change
  upload               Submit the current app for review
  logs                 Show what your app did when it ran
`;

const io = {
  log: (message) => process.stdout.write(`${message}\n`),
  warn: (message) => process.stderr.write(`${message}\n`),
};

const [command, ...args] = process.argv.slice(2);

if (!command || command === "--help" || command === "-h") {
  io.log(USAGE);
  process.exit(command ? 0 : 1);
}

const handler = COMMANDS[command];
if (!handler) {
  io.warn(`Unknown command: ${command}\n`);
  io.log(USAGE);
  process.exit(1);
}

try {
  await handler(args, io);
} catch (error) {
  io.warn(error.message);
  process.exit(1);
}
